import * as cheerio from "cheerio";
import { BaseScraper } from "./base-scraper";
import { Grant, Region } from "../models/grant";
import { extractGrantNamesFromTitles } from "../enrich/ai-enricher";

/**
 * Web横断検索による助成金発見スクレイパー
 *
 * 2つの検索を使い、固定の情報源には載らないマイナーな助成金を発掘する：
 * - Google News RSS: ニュース記事・プレスリリースの募集告知＋採択報告
 * - DuckDuckGo（キー不要）: ブログ・団体サイトの「〇〇助成でイベントを
 *   開催しました」という活動報告（ニュースに載らない助成金の発掘源）
 *
 * 発見した記事は「候補」であり、内容の確認はリンク先で行う前提
 * （レポートでは🔎セクションに掲載する）。
 */
export class NewsDiscoveryScraper extends BaseScraper {
  /** 検索キーワード（それぞれ別々にRSS検索する） */
  private static readonly QUERIES = [
    "子ども食堂 助成金 募集",
    "子育て支援 助成金 募集 NPO",
    "学習支援 助成 募集 団体",
    "外国ルーツ 子ども 助成",
    "フードパントリー 助成 募集",
    "不登校 居場所 助成 募集",
    "体験格差 助成 募集",
    "ひとり親 支援 助成 募集",
  ];

  /** 掲載する記事の新しさ（日数） */
  private static readonly MAX_AGE_DAYS = 60;

  /** 全体の掲載上限（レポートが発見候補で溢れないように） */
  private static readonly MAX_ITEMS = 20;

  /**
   * 採択報告の検索キーワード。
   * 他団体の「〇〇助成に採択されました」というブログ・お知らせは、
   * まだ追跡していない助成金の存在を教えてくれる発掘源になる。
   */
  private static readonly ADOPTION_QUERIES = [
    '"採択されました" 助成 NPO',
    '"採択" 助成金 子ども食堂',
    '"助成が決定" NPO 子ども',
    '"助成金を活用" 子ども食堂',
  ];

  /**
   * 活動報告のWeb検索キーワード（DuckDuckGo・キー不要）。
   * ニュースに載らないブログ・団体サイトの「〇〇助成でイベントを開催しました」
   * という報告から、まだ追跡していない助成金を発掘する。
   */
  private static readonly WEB_REPORT_QUERIES = [
    '"助成を受けて" 子ども食堂',
    '"助成金を活用して" 子ども 開催',
    '"の助成により" 子ども イベント',
    '"様から助成" 子ども食堂',
    '"助成をいただき" 子ども 開催',
  ];

  /** 採択報告由来の掲載上限（通常の発見枠とは別） */
  private static readonly MAX_ADOPTION_ITEMS = 10;

  constructor() {
    super("news", "全国");
  }

  async search(): Promise<Grant[]> {
    const grants: Grant[] = [];

    for (const query of NewsDiscoveryScraper.QUERIES) {
      try {
        const url =
          "https://news.google.com/rss/search?q=" +
          encodeURIComponent(query) +
          "&hl=ja&gl=JP&ceid=" +
          encodeURIComponent("JP:ja");
        const response = await this.client.get(url, { responseType: "text" });
        const $ = cheerio.load(response.data, { xmlMode: true });
        grants.push(...this.parseRss($));
      } catch (error) {
        console.error(
          `[News発見] 検索「${query}」に失敗:`,
          error instanceof Error ? error.message : error,
        );
      }
    }

    // IDで重複を除去し、新しい順に上限まで
    const unique = new Map<string, Grant>();
    for (const grant of grants) unique.set(grant.id, grant);
    const result = Array.from(unique.values())
      .sort((a, b) => (a.grantPeriod < b.grantPeriod ? 1 : -1)) // grantPeriod に配信日を格納している
      .slice(0, NewsDiscoveryScraper.MAX_ITEMS);

    if (result.length === 0) {
      console.error(
        "[News発見] 記事を取得できませんでした（RSSの形式が変わった可能性があります）",
      );
    }

    // Google News の転送URLは機械では解決できないため、
    // 記事タイトルで検索して公式サイト（または元記事）のURLに差し替える
    for (const grant of result) {
      const official = await this.searchOfficialSite(
        grant.name.replace(/…$/, ""),
        NewsDiscoveryScraper.AGGREGATOR_SITES,
      );
      if (official) grant.url = official;
    }

    // 採択報告からの発掘（失敗しても通常の発見結果は返す）
    try {
      const adopted = await this.searchAdoptionReports();
      result.push(...adopted);
      if (adopted.length > 0) {
        console.log(`[News発見] 採択報告から ${adopted.length}件を発掘`);
      }
    } catch (error) {
      console.error(
        "[News発見] 採択報告の検索に失敗:",
        error instanceof Error ? error.message : error,
      );
    }

    return result;
  }

  /** 採択報告・活動報告らしい文かどうか（助成金名の抽出に回す価値があるか） */
  private static readonly REPORT_PATTERN =
    /採択|助成が決定|助成金を活用|助成を受け|助成により|助成をいただ|から助成|より助成/;

  /**
   * 他団体の採択報告・活動報告を検索し、記事タイトルから助成金名をAIで抽出して
   * 「発見候補」として返す。既に追跡済みの助成金は後段の名前ベース重複除去
   * （dedupeAcrossSources）で畳まれるため、新規のものだけがレポートに残る。
   * 検索元は Google News RSS（ニュース）と DuckDuckGo（ブログ・団体サイト等のWeb全体）。
   */
  private async searchAdoptionReports(): Promise<Grant[]> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - NewsDiscoveryScraper.MAX_AGE_DAYS);

    // 採択報告らしい記事タイトルを集める（title -> link）
    const articles = new Map<string, string>();
    for (const query of NewsDiscoveryScraper.ADOPTION_QUERIES) {
      try {
        const url =
          "https://news.google.com/rss/search?q=" +
          encodeURIComponent(query) +
          "&hl=ja&gl=JP&ceid=" +
          encodeURIComponent("JP:ja");
        const response = await this.client.get(url, { responseType: "text" });
        const $ = cheerio.load(response.data, { xmlMode: true });
        $("item").each((_, elem) => {
          const $item = $(elem);
          const rawTitle = this.cleanText($item.find("title").first().text());
          const link = this.cleanText($item.find("link").first().text());
          const pubDateText = this.cleanText(
            $item.find("pubDate").first().text(),
          );
          if (!rawTitle || !link) return;
          const published = pubDateText ? new Date(pubDateText) : null;
          if (!published || isNaN(published.getTime()) || published < cutoff)
            return;
          const title = this.cleanText(rawTitle.replace(/\s*-\s*[^-]+$/, ""));
          if (!NewsDiscoveryScraper.REPORT_PATTERN.test(title)) return;
          articles.set(title, link);
        });
      } catch {
        // クエリ単位の失敗はスキップ
      }
    }

    // ブログ・団体サイトの活動報告をWeb検索で集める（日付は取れないため鮮度判定なし。
    // 古い報告でも「毎年恒例の助成」の発見につながるので候補として扱う）
    for (const query of NewsDiscoveryScraper.WEB_REPORT_QUERIES) {
      try {
        const results = await this.searchWebReports(query);
        for (const r of results) {
          // タイトルだけでは助成金名が入らないことが多いので、本文抜粋を添えてAIに渡す
          const text = r.snippet ? `${r.title} ／ ${r.snippet}` : r.title;
          if (!NewsDiscoveryScraper.REPORT_PATTERN.test(text)) continue;
          articles.set(text, r.url);
        }
      } catch {
        // クエリ単位の失敗はスキップ
      }
    }

    if (articles.size === 0) return [];

    // 記事タイトルから助成金名・助成元をAIで抽出
    const titles = Array.from(articles.keys()).slice(0, 40);
    const extracted = await extractGrantNamesFromTitles(titles);

    const grants: Grant[] = [];
    const seen = new Set<string>();
    for (const e of extracted) {
      if (grants.length >= NewsDiscoveryScraper.MAX_ADOPTION_ITEMS) break;
      const title = titles[e.index];
      const key = e.grantName.replace(/\s/g, "");
      if (seen.has(key)) continue;
      seen.add(key);

      const grant = this.createGrant({
        id: this.generateId(e.grantName, "adoption"),
        name: e.grantName,
        organization: e.organization || "要確認（記事参照）",
        targetProjects: `採択・活動報告から発見(記事:「${title.slice(0, 50)}」)。内容はリンク先で要確認`,
        grantAmount: "要確認",
        applicationDeadline: "要確認",
        url: articles.get(title) ?? "",
        status: "不明",
      });

      // 記事URLはGoogle Newsの転送URLなので、助成金名で公式サイトを探して差し替える
      const official = await this.searchOfficialSite(
        e.grantName,
        NewsDiscoveryScraper.AGGREGATOR_SITES,
      );
      if (official) grant.url = official;

      grants.push(grant);
    }
    return grants;
  }

  /**
   * DuckDuckGo（HTML版・キー不要）でWeb全体を検索し、結果一覧を返す。
   * ニュースに載らないブログ・団体サイトの活動報告を拾うため、
   * 除外はSNS・検索エンジンのみ（ブログサービスは発掘源として採用する）。
   */
  private async searchWebReports(
    query: string,
  ): Promise<{ title: string; url: string; snippet: string }[]> {
    const response = await this.client.get(
      "https://html.duckduckgo.com/html/",
      {
        params: { q: query, kl: "jp-jp" },
        responseType: "text",
      },
    );
    const $ = cheerio.load(response.data);
    const results: { title: string; url: string; snippet: string }[] = [];
    $(".result").each((_, el) => {
      const $el = $(el);
      const $a = $el.find("a.result__a").first();
      const title = this.cleanText($a.text());
      let href = $a.attr("href") ?? "";
      // DDGは /l/?uddg=<エンコード済みURL> 形式のリダイレクトを挟むことがある
      const redirect = href.match(/uddg=([^&]+)/);
      if (redirect) href = decodeURIComponent(redirect[1]);
      if (!title || !/^https?:\/\//.test(href)) return;
      if (BaseScraper.NON_OFFICIAL.test(href)) return;
      const snippet = this.cleanText(
        $el.find(".result__snippet").first().text(),
      );
      results.push({ title, url: href, snippet: snippet.slice(0, 150) });
    });
    if (results.length === 0) {
      console.warn(
        `[News発見] Web検索「${query}」が0件でした（DuckDuckGoの形式変更・一時ブロックの可能性）`,
      );
    }
    return results;
  }

  /** RSS（XML）を解析して助成金告知らしき記事を抽出 */
  private parseRss($: cheerio.CheerioAPI): Grant[] {
    const grants: Grant[] = [];
    const now = new Date();
    const cutoff = new Date(now);
    cutoff.setDate(cutoff.getDate() - NewsDiscoveryScraper.MAX_AGE_DAYS);

    $("item").each((_, elem) => {
      try {
        const $item = $(elem);
        const rawTitle = this.cleanText($item.find("title").first().text());
        const link = this.cleanText($item.find("link").first().text());
        const pubDateText = this.cleanText(
          $item.find("pubDate").first().text(),
        );
        const sourceName = this.cleanText($item.find("source").first().text());

        if (!rawTitle || !link) return;

        // タイトル末尾の「 - 配信元」を除去
        const title = this.cleanText(rawTitle.replace(/\s*-\s*[^-]+$/, ""));

        // 助成金の「募集告知」らしい記事のみ（贈呈式・寄付報告などは除外）
        if (!/助成|補助金|支援金|基金/.test(title)) return;
        if (!/募集|公募|受付|応募|申請|案内|開始/.test(title)) return;
        if (/贈呈|寄付を実施|採択|決定しました|報告/.test(title)) return;

        // 配信日（古い記事は除外）
        const published = pubDateText ? new Date(pubDateText) : null;
        if (!published || isNaN(published.getTime()) || published < cutoff)
          return;

        // 地域の推定
        const region: Region = /長久手/.test(title)
          ? "長久手市"
          : /愛知|名古屋/.test(title)
            ? "愛知県"
            : "全国";

        // タイトルから締切らしき日付を抽出（あれば）
        const deadlineMatch = title.match(
          /(\d{1,2}月\d{1,2}日)\s*(?:まで|締切|〆)/,
        );

        grants.push(
          this.createGrant({
            // 同じ記事が複数の配信元から流れるため、IDはタイトルのみから生成して重複を畳む
            id: this.generateId(title, "news"),
            name: title.length > 70 ? `${title.slice(0, 70)}…` : title,
            organization: sourceName || "要確認（記事参照）",
            region,
            targetProjects:
              "ニュース/ブログから自動発見（内容はリンク先で要確認）",
            grantAmount: "要確認",
            grantPeriod: published.toISOString().slice(0, 10), // 配信日（並べ替え用）
            applicationDeadline: deadlineMatch
              ? deadlineMatch[1]
              : "要確認（記事参照）",
            url: link,
            status: "不明",
          }),
        );
      } catch {
        // 個別記事の解析エラーはスキップ
      }
    });

    return grants;
  }
}

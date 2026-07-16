import * as cheerio from "cheerio";
import { BaseScraper } from "./base-scraper";
import { Grant } from "../models/grant";

/**
 * WAM（独立行政法人 福祉医療機構）助成金情報スクレイパー
 *
 * 旧URL（/hp/cat/cat_jyosei.html 等）は廃止・404のため、
 * 「WAM助成の募集情報」ページ（実HTMLを確認済み）を使う:
 * https://www.wam.go.jp/hp/wamjosei_boshu/
 *
 * このページは年度ごとの「募集のお知らせ」リンクが新しい順に並ぶアーカイブ。
 * 事業種別（通常助成事業／モデル事業／補正予算）ごとに最新年度のお知らせを
 * 開き、詳細ページの「応募締切 令和N年M月D日」で募集中／募集前を判定する。
 * WAM助成は例年12月〜1月頃の募集。
 */
export class WamScraper extends BaseScraper {
  private baseUrl = "https://www.wam.go.jp";
  private indexUrl = "https://www.wam.go.jp/hp/wamjosei_boshu/";

  constructor() {
    super("wam", "全国");
  }

  async search(): Promise<Grant[]> {
    const grants: Grant[] = [];

    try {
      const $ = await this.fetchPage(this.indexUrl);

      // 事業種別ごとに最新（＝ページ上で最初に現れる）お知らせリンクを拾う
      const latestByType = new Map<string, { title: string; url: string }>();

      $("a").each((_, elem) => {
        const $a = $(elem);
        const title = this.cleanText($a.text());
        const href = $a.attr("href") ?? "";
        if (
          !/令和\d+年度.*助成.*(募集|お知らせ)|20\d{2}年度.*助成.*募集/.test(
            title,
          )
        )
          return;

        const type = /モデル/.test(title)
          ? "モデル事業"
          : /補正/.test(title)
            ? "補正予算事業"
            : "通常助成事業";
        if (latestByType.has(type)) return; // 新しい順なので最初のものが最新

        const url = href.startsWith("http") ? href : `${this.baseUrl}${href}`;
        latestByType.set(type, { title, url });
      });

      // 各種別の詳細ページから締切を取得して判定
      for (const [type, info] of latestByType) {
        try {
          const grant = await this.buildFromDetailPage(
            type,
            info.title,
            info.url,
          );
          if (grant) grants.push(grant);
        } catch (error) {
          console.error(
            `[WAM] 詳細ページの取得に失敗 (${info.url}):`,
            error instanceof Error ? error.message : error,
          );
        }
      }

      if (grants.length === 0) {
        console.error(
          "[WAM] 募集情報を抽出できませんでした（ページ構成が変わった可能性があります）",
        );
      }
    } catch (error) {
      console.error(
        "[WAM] 検索に失敗:",
        error instanceof Error ? error.message : error,
      );
    }

    return grants;
  }

  /** 募集お知らせ詳細ページから助成金1件を組み立てる */
  private async buildFromDetailPage(
    type: string,
    title: string,
    url: string,
  ): Promise<Grant | null> {
    const $ = await this.fetchPage(url);
    const text = this.cleanText($("body").text());

    // 「応募締切 令和N年M月D日」を探す
    const deadlineMatch = text.match(
      /応募締切[^令0-9]{0,10}((?:令和\d+年)?\d{1,2}月\d{1,2}日[^ ]{0,15})/,
    );
    const deadlineText = deadlineMatch ? this.cleanText(deadlineMatch[1]) : "";
    const deadlineDate = deadlineText
      ? this.parseJapaneseDate(deadlineText)
      : null;

    const now = new Date();
    const targetProjects =
      "子ども食堂・居場所づくり・生活困窮者支援など、社会福祉振興のためのNPO等の事業";

    // 名前は「次回募集」⇔「令和N年度」と状態で変わるため、IDは種別だけから
    // 生成して安定させる（IDが変わるとメモ・👍👎が引き継がれない）
    const stableId = this.generateId(
      `WAM助成（${type}）`,
      "独立行政法人 福祉医療機構（WAM）",
    );

    if (deadlineDate && deadlineDate >= now) {
      return this.createGrant({
        id: stableId,
        name: `WAM助成（${type}）${title.match(/令和\d+年度|20\d{2}年度/)?.[0] ?? ""}`,
        organization: "独立行政法人 福祉医療機構（WAM）",
        region: "全国",
        targetProjects,
        applicationDeadline: deadlineText,
        url,
        status: "募集中",
      });
    }

    // 締切が過ぎている（または読めない）→ 次年度の予告として掲載
    // 直近実績が古すぎる（2年以上前）場合は掲載しない
    if (deadlineDate) {
      const cutoff = new Date(now);
      cutoff.setMonth(cutoff.getMonth() - 24);
      if (deadlineDate < cutoff) return null;
    }

    const monthLabel = deadlineDate
      ? `例年${deadlineDate.getMonth() + 1}月頃締切`
      : "例年12月〜1月頃";
    return this.createGrant({
      id: stableId,
      name: `WAM助成（${type}）次回募集`,
      organization: "独立行政法人 福祉医療機構（WAM）",
      region: "全国",
      targetProjects,
      applicationDeadline: "未発表",
      expectedPeriod: deadlineText
        ? `${monthLabel}（前回締切: ${deadlineText}）`
        : monthLabel,
      url,
      status: "募集前",
    });
  }
}

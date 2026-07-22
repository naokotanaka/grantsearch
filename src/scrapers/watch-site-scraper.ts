import { BaseScraper } from "./base-scraper";
import { Grant } from "../models/grant";
import { WatchSite } from "../models/database";

/**
 * 巡回サイトスクレイパー
 *
 * 人間がダッシュボードから登録した「巡回サイト」（助成金情報のまとめページ・
 * 財団のお知らせ一覧など）を毎週フェッチし、ページ内の助成金らしいリンクを
 * 発見候補として拾う。サイトごとの専用解析は持たない汎用ロジックのため、
 * 拾った候補は「不明」状態で🔎新着・発見に載せ、内容の確認は
 * AIエンリッチメント（リンク先の読み取り）と人間の判定に任せる。
 */
export class WatchSiteScraper extends BaseScraper {
  /** 1サイトあたりの拾い上げ上限（一覧ページの全リンクで溢れないように） */
  private static readonly MAX_PER_SITE = 15;

  /** 助成金の告知らしいリンク文言 */
  private static readonly GRANT_WORD = /助成|補助金|支援金|基金|奨励金/;

  /**
   * 募集の告知ではないリンクを除く：結果発表・報告・締切済み・開催済み
   * イベントのほか、「助成金に関する情報」のようなサイト内ナビゲーション・
   * 案内ページ
   */
  private static readonly SKIP_WORD =
    /採択|結果発表|選考結果|報告|終了しました|締め?切りました|開催しました|贈呈式|に関する情報|情報提供|情報を開く|この助成|一覧|カテゴリ|もっと見る|さらに表示|寄付募集|寄附金募集/;

  constructor(private sites: WatchSite[]) {
    super("watch", "全国");
  }

  async search(): Promise<Grant[]> {
    const grants: Grant[] = [];
    for (const site of this.sites) {
      try {
        const found = await this.scanSite(site);
        console.log(`  [巡回] ${site.label}: ${found.length}件の候補を発見`);
        grants.push(...found);
      } catch (error) {
        console.error(
          `  [巡回] ${site.label} の取得に失敗:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
    return grants;
  }

  /** 1サイトを走査し、助成金らしいリンクを候補として返す */
  private async scanSite(site: WatchSite): Promise<Grant[]> {
    const $ = await this.fetchPage(site.url);
    const results: Grant[] = [];
    const seenUrls = new Set<string>();
    const seenNames = new Set<string>();

    $("a[href]").each((_, el) => {
      if (results.length >= WatchSiteScraper.MAX_PER_SITE) return false;
      const text = this.cleanText($(el).text());
      if (text.length < 8 || text.length > 120) return;
      if (!WatchSiteScraper.GRANT_WORD.test(text)) return;
      if (WatchSiteScraper.SKIP_WORD.test(text)) return;

      const href = $(el).attr("href") ?? "";
      let absUrl: string;
      try {
        absUrl = new URL(href, site.url).toString();
      } catch {
        return;
      }
      if (!/^https?:\/\//.test(absUrl)) return;
      if (BaseScraper.NON_OFFICIAL.test(absUrl)) return;

      const name = text.length > 70 ? `${text.slice(0, 70)}…` : text;
      if (seenUrls.has(absUrl) || seenNames.has(name)) return;
      seenUrls.add(absUrl);
      seenNames.add(name);

      results.push(
        this.createGrant({
          // 同じ告知がURL違いで再掲されても畳めるよう、IDは名前＋サイトから生成
          id: this.generateId(name, site.label),
          name,
          organization: "要確認（リンク先参照）",
          targetProjects: `巡回サイト「${site.label}」から発見（内容はリンク先で要確認）`,
          grantAmount: "要確認",
          applicationDeadline: "要確認（リンク先参照）",
          url: absUrl,
          status: "不明",
        }),
      );
    });

    if (results.length === 0) {
      console.warn(
        `  [巡回] ${site.label}: 助成金らしいリンクが見つかりませんでした（ページ構成の変化・対象外ページの可能性）`,
      );
    }
    return results;
  }
}

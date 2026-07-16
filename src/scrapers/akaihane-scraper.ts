import { BaseScraper } from "./base-scraper";
import {
  Grant,
  GrantStatus,
  SEARCH_KEYWORDS,
  DISCOVERY_KEYWORDS,
} from "../models/grant";

/**
 * 中央共同募金会（赤い羽根）助成情報スクレイパー
 * https://www.akaihane.or.jp/subsidies/
 *
 * 赤い羽根福祉基金・企業冠プログラム（清水育英会、コープみらい等）・
 * その他の助成の公募記事が新着順に並ぶ。
 *
 * ページ構造（実HTMLを確認済み）:
 * - 一覧: <ul class="cmn-post-list01"> 内の <li>
 * - 日付: <span class="date">2026年07月15日</span>
 * - 区分: <span class="cat"><a>赤い羽根福祉基金</a></span>
 * - 題名: <span class="title"><a href="…/subsidies/…/ID/">【応募受付中・8/13締切り】「〇〇助成」第7回…</a></span>
 * - 題名の頭の【…】ラベルで受付状況と締切（月/日）が分かる
 */
export class AkaihaneScraper extends BaseScraper {
  private listUrl = "https://www.akaihane.or.jp/subsidies/";

  constructor() {
    super("akaihane", "全国");
  }

  async search(): Promise<Grant[]> {
    const grants: Grant[] = [];
    let parsedItems = 0;

    const $ = await this.fetchPage(this.listUrl);
    const now = new Date();

    $("ul.cmn-post-list01 li").each((_, elem) => {
      try {
        const $item = $(elem);
        const linkElem = $item.find(".title a").first();
        const rawTitle = this.cleanText(linkElem.text());
        const href = linkElem.attr("href") ?? "";
        if (!rawTitle || !href) return;
        parsedItems++;

        // 採択報告・受付終了の記事は載せない（公募中のものだけ拾う）
        if (/決定しました|助成先.{0,6}決定|採択.{0,6}決定/.test(rawTitle))
          return;
        if (/受付終了|応募終了|募集終了/.test(rawTitle)) return;

        // 関連分野に絞り込み
        const keywords = [...SEARCH_KEYWORDS, ...DISCOVERY_KEYWORDS];
        if (!keywords.some((kw) => rawTitle.includes(kw))) return;

        // 頭の【応募受付中・8/13締切り】ラベルから状態と締切を読む
        const label = rawTitle.match(/^【([^】]*)】/)?.[1] ?? "";
        let status: GrantStatus = "不明";
        if (/受付中|公募中|募集中/.test(label + rawTitle)) status = "募集中";

        let applicationDeadline = "要確認";
        const dm = label.match(/(\d{1,2})\s*[\/月]\s*(\d{1,2})/);
        if (dm) {
          // 締切の年はラベルに無いので記事の掲載日から補う
          const posted =
            this.parseJapaneseDate(
              this.cleanText($item.find(".date").first().text()),
            ) ?? now;
          let deadline = new Date(
            posted.getFullYear(),
            parseInt(dm[1]) - 1,
            parseInt(dm[2]),
          );
          if (deadline < posted) {
            // 掲載日より前になる場合は年またぎ（12月掲載・1月締切など）
            deadline = new Date(
              posted.getFullYear() + 1,
              parseInt(dm[1]) - 1,
              parseInt(dm[2]),
            );
          }
          if (deadline < now) return; // 締切済みは載せない
          applicationDeadline = `${deadline.getFullYear()}年${deadline.getMonth() + 1}月${deadline.getDate()}日`;
        }

        // 名称: 頭の【…】ラベルと末尾の「の公募について」等を外して読みやすく
        const name = this.cleanText(
          rawTitle
            .replace(/^【[^】]*】\s*/, "")
            .replace(/の?(公募|募集)について.*$/, "")
            .replace(/について$/, ""),
        );
        if (!name || name.length < 6) return;

        const category = this.cleanText($item.find(".cat a").first().text());

        grants.push(
          this.createGrant({
            name,
            organization: "中央共同募金会",
            targetProjects: category,
            applicationDeadline,
            url: href.startsWith("http")
              ? href
              : new URL(href, this.listUrl).toString(),
            status,
          }),
        );
      } catch {
        // 個別の解析エラーはスキップ
      }
    });

    if (parsedItems === 0) {
      console.error(
        "[中央共同募金会] 記事を抽出できませんでした（ページ構成が変わった可能性があります）",
      );
    }

    // IDで重複を除去
    const unique = new Map<string, Grant>();
    for (const grant of grants) unique.set(grant.id, grant);
    return Array.from(unique.values());
  }
}

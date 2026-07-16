import { BaseScraper } from "./base-scraper";
import { Grant } from "../models/grant";

/**
 * 愛知県共同募金会（赤い羽根）配分・助成スクレイパー
 * https://akaihane-aichi.jp/pages/38/ （共同募金配分（助成）事業の申請）
 *
 * ハブページの表に助成メニューが並ぶ（NPO法人福祉施設等施設・設備整備費、
 * 広域活動団体支援事業費 等）。CBCチャリティ募金・つながりをたやさない
 * 社会づくり事業費への申請案内ページ（/pages/45/ 等）へのリンクもある。
 *
 * ページ構造（実HTMLを確認済み）:
 * - 表の行 <tr> の1列目に <a href="//akaihane-aichi.jp/pages/40/">名称</a>
 *   （番号「2.」付き）、2列目に対象団体、3列目に対象事業、4列目に申請期間
 *   （例:「令和8年4月1日～5月15日（必着）」。終了日に年が無い形式）
 * - 表の外にも本文中に /pages/NN/ への案内リンクがある
 *
 * 申請期間が過ぎている場合は「募集前」（例年時期を表示）として登録し、
 * 毎年の募集時期を追いかけられるようにする。
 */
export class AkaihaneAichiScraper extends BaseScraper {
  private hubUrl = "https://akaihane-aichi.jp/pages/38/";

  constructor() {
    super("akaihane_aichi", "愛知県");
  }

  async search(): Promise<Grant[]> {
    const grants: Grant[] = [];
    const $ = await this.fetchPage(this.hubUrl);
    const now = new Date();
    const seenUrls = new Set<string>();

    // 1. 表の行（名称・対象・事業内容・申請期間が揃っている）
    $("tr").each((_, tr) => {
      try {
        const $tr = $(tr);
        const linkElem = $tr.find('a[href*="/pages/"]').first();
        const href = linkElem.attr("href") ?? "";
        if (!href) return;

        const name = this.cleanText(linkElem.text()).replace(/^\d+\.\s*/, "");
        if (!name || name.length < 5) return;

        const cells = $tr.find("td");
        const target = this.cleanText(cells.eq(1).text());
        const description = this.cleanText(cells.eq(2).text());
        const period = this.cleanText(cells.eq(3).text());

        const url = this.resolveUrl(href);
        seenUrls.add(url);
        grants.push(
          this.buildGrant(name, target, description, period, url, now),
        );
      } catch {
        // 個別の解析エラーはスキップ
      }
    });

    // 2. 表の外の案内リンク（CBCチャリティ募金・つながり等の申請ページ）
    $(
      '#contents a[href*="/pages/"], main a[href*="/pages/"], .maincontents a[href*="/pages/"], body a[href*="/pages/"]',
    ).each((_, el) => {
      try {
        const href = $(el).attr("href") ?? "";
        const url = this.resolveUrl(href);
        if (seenUrls.has(url) || url === this.hubUrl) return;
        const text = this.cleanText($(el).text());
        // 助成・配分の案内らしいリンクだけ（ナビゲーション・様式ダウンロードは除外）
        if (text.length < 15) return;
        if (!/配分|助成|事業費|補助/.test(text)) return;
        if (/様式|配分決定|ロゴマーク/.test(text)) return;
        seenUrls.add(url);
        grants.push(this.buildGrant(text.slice(0, 60), "", "", text, url, now));
      } catch {
        // 個別の解析エラーはスキップ
      }
    });

    if (grants.length === 0) {
      console.error(
        "[愛知県共同募金会] 助成メニューを抽出できませんでした（ページ構成が変わった可能性があります）",
      );
    }

    // IDで重複を除去
    const unique = new Map<string, Grant>();
    for (const grant of grants) unique.set(grant.id, grant);
    return Array.from(unique.values());
  }

  /** //akaihane-aichi.jp/pages/40/ や /pages/45/ を絶対URLにする */
  private resolveUrl(href: string): string {
    if (href.startsWith("//")) return `https:${href}`;
    return new URL(href, this.hubUrl).toString();
  }

  /**
   * 申請期間テキスト（例:「令和8年4月1日～5月15日（必着）」）から状態を決めて
   * Grant を組み立てる。期間が過ぎていれば「募集前」＋例年時期の表示。
   */
  private buildGrant(
    name: string,
    target: string,
    description: string,
    period: string,
    url: string,
    now: Date,
  ): Grant {
    const start = this.parseJapaneseDate(period);
    let end: Date | null = null;
    if (start) {
      // 終了側は「～5月15日」のように年が省略される形式に対応
      const em = period.match(/[〜～~].{0,10}?(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
      if (em) {
        end = new Date(
          start.getFullYear(),
          parseInt(em[1]) - 1,
          parseInt(em[2]),
        );
        if (end < start) {
          end = new Date(
            start.getFullYear() + 1,
            parseInt(em[1]) - 1,
            parseInt(em[2]),
          );
        }
      }
    }

    const targetProjects = [description, target ? `【対象】${target}` : ""]
      .filter(Boolean)
      .join(" ")
      .slice(0, 100);

    if (start && end && end >= now) {
      // 申請期間内（または開始前）
      return this.createGrant({
        name,
        organization: "愛知県共同募金会",
        targetProjects,
        applicationDeadline: period,
        url,
        status: start > now ? "募集前" : "募集中",
        expectedPeriod: start > now ? `募集予定（発表済み）: ${period}` : "",
      });
    }

    if (start && end) {
      // 今年度の申請期間は終了 → 例年時期として追いかける
      return this.createGrant({
        name,
        organization: "愛知県共同募金会",
        targetProjects,
        applicationDeadline: "未発表",
        expectedPeriod: `例年${start.getMonth() + 1}月〜${end.getMonth() + 1}月頃（昨年実績: ${period}）`,
        url,
        status: "募集前",
      });
    }

    // 期間が読み取れない → 要確認として掲載（AI読み取りに任せる）
    return this.createGrant({
      name,
      organization: "愛知県共同募金会",
      targetProjects,
      applicationDeadline: "要確認",
      url,
      status: "不明",
    });
  }
}

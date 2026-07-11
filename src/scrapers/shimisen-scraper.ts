import * as cheerio from "cheerio";
import { BaseScraper } from "./base-scraper";
import { Grant, SEARCH_KEYWORDS } from "../models/grant";

/**
 * しみせん（京都市市民活動総合センター）助成金情報スクレイパー
 * https://shimisen-kyoto.org/subsidies
 *
 * 全国の助成金・補助金を随時まとめている発掘源（ユーザー指定）。
 * 京都のセンターだが掲載内容の多くは全国応募可。京都限定のものは除外する。
 *
 * ページ構造（実HTMLを確認済み）:
 * - 各件は <div class="item"> 内の <div class="type-subsidy">
 * - 種別: <p class="textRed">助成（融資・アワード等もある）
 * - 名称: <h2 class="grid-tit2"><a href="…/subsidy/ID">名称</a></h2>
 * - 助成元: <p class="meta-subsidy">by 〇〇財団</p>
 * - 期間: 表の「応募・申請期間」行（日付に空白が混ざる表記: 2026 年 7 月 1 日）
 * - ページ送りは /subsidies/page/N（現在3ページ）
 */
export class ShimisenScraper extends BaseScraper {
  private baseUrl = "https://shimisen-kyoto.org";

  private static readonly MAX_PAGES = 4;

  /** 関連分野の判定キーワード（CANPANと同じ発掘用拡張） */
  private static readonly EXTRA_KEYWORDS = [
    "移民",
    "難民",
    "ひとり親",
    "母子",
    "貧困",
    "孤立",
    "食支援",
    "フードバンク",
    "食育",
    "教育支援",
    "奨学",
    "子どもの居場所",
    "こども",
    "青少年",
  ];

  constructor() {
    super("shimisen", "全国");
  }

  async search(): Promise<Grant[]> {
    const grants: Grant[] = [];

    for (let page = 1; page <= ShimisenScraper.MAX_PAGES; page++) {
      try {
        const url =
          page === 1
            ? `${this.baseUrl}/subsidies`
            : `${this.baseUrl}/subsidies/page/${page}`;
        const $ = await this.fetchPage(url);
        const result = this.parseListPage($);
        if (result.parsedItems === 0) break; // 最終ページを超えた
        grants.push(...result.grants);
      } catch (error) {
        console.error(
          `[しみせん] ページ${page}の取得に失敗:`,
          error instanceof Error ? error.message : error,
        );
        break;
      }
    }

    // IDで重複を除去
    const unique = new Map<string, Grant>();
    for (const grant of grants) unique.set(grant.id, grant);
    const result = Array.from(unique.values());

    if (result.length === 0) {
      console.error(
        "[しみせん] 助成金を抽出できませんでした（ページ構成が変わった可能性があります）",
      );
    }

    // まとめ記事ではなく公式サイトへのリンクに差し替える
    // （詳細記事内の外部リンク → 見つからなければ助成金名で検索）
    for (const grant of result) {
      const official =
        (await this.resolveOfficialUrl(
          grant.url,
          /shimisen-kyoto|kyoto-npo|hitomachi/,
        )) ??
        (await this.searchOfficialSite(
          `${grant.name} ${grant.organization}`,
          ShimisenScraper.AGGREGATOR_SITES,
        ));
      if (official) grant.url = official;
    }
    return result;
  }

  /** 一覧1ページを解析。parsedItems は絞り込み前の件数（ページ送り終端の判定用） */
  private parseListPage($: cheerio.CheerioAPI): {
    grants: Grant[];
    parsedItems: number;
  } {
    const grants: Grant[] = [];
    let parsedItems = 0;
    const now = new Date();

    $('div[class*="type-subsidy"]').each((_, elem) => {
      try {
        const $item = $(elem);
        parsedItems++;

        const linkElem = $item.find("h2 a").first();
        const name = this.cleanText(linkElem.text());
        const href = linkElem.attr("href") ?? "";
        if (!name || name.length < 4) return;

        const organization =
          this.cleanText(
            $item
              .find(".meta-subsidy")
              .first()
              .text()
              .replace(/^by\s*/i, ""),
          ) || "要確認";

        const excerpt = this.cleanText(
          $item.find(".grid-text p").first().text(),
        );
        const tag = this.cleanText($item.find(".fa-tag").parent().text());

        // 関連分野に絞り込み（名称・タグは広めのキーワード、本文は強い分野語のみ）
        if (!this.isRelevant(name + " " + tag, excerpt)) return;

        // 京都限定の助成金は除外（京都市の区役所事業を含む。助成元名だけの京都は許容）
        if (/京都|[上中下左右西]京区|東山区|山科区|伏見区/.test(name)) return;
        if (/区役所/.test(organization)) return;
        if (
          /京都[市府]内|京都(市|府)?に(限|所在)|対象.{0,10}京都/.test(excerpt)
        )
          return;

        // 応募・申請期間（日付内の空白を除去してから解析）
        const periodRow = $item
          .find('th:contains("応募・申請期間")')
          .closest("tr")
          .find("td")
          .first();
        const period = this.cleanText(periodRow.text());
        const compactPeriod = period.replace(/\s+/g, "");
        const dates = [
          ...compactPeriod.matchAll(/(\d{4})年(\d{1,2})月(\d{1,2})日/g),
        ];

        const url = href.startsWith("http") ? href : `${this.baseUrl}${href}`;

        if (dates.length === 0) {
          // 期間が読み取れない → 要確認として掲載
          grants.push(
            this.createGrant({
              name,
              organization,
              region: "全国",
              targetProjects: excerpt.slice(0, 60),
              applicationDeadline: period || "要確認",
              url,
              status: "不明",
            }),
          );
          return;
        }

        const toDate = (m: RegExpMatchArray) =>
          new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]));
        // 日付が1つだけの表記は「締切のみ」とみなす（開始日扱いにしない）
        const start = dates.length >= 2 ? toDate(dates[0]) : null;
        const end = toDate(dates[dates.length - 1]);

        if (end < now) return; // 締切済みは掲載しない

        if (start !== null && start > now) {
          // 開始前（発表済みのこれから募集）→ 募集前として予告掲載
          grants.push(
            this.createGrant({
              name,
              organization,
              region: "全国",
              targetProjects: excerpt.slice(0, 60),
              applicationDeadline: compactPeriod,
              expectedPeriod: `募集予定（発表済み）: ${compactPeriod}`,
              url,
              status: "募集前",
            }),
          );
        } else {
          grants.push(
            this.createGrant({
              name,
              organization,
              region: "全国",
              targetProjects: excerpt.slice(0, 60),
              applicationDeadline: compactPeriod,
              url,
              status: "募集中",
            }),
          );
        }
      } catch {
        // 個別の解析エラーはスキップ
      }
    });

    return { grants, parsedItems };
  }

  /** 名称・タグは広めのキーワード、本文（説明抜粋）は誤検出を避けるため強い分野語のみで判定 */
  private isRelevant(nameAndTag: string, excerpt: string): boolean {
    const keywords = [...SEARCH_KEYWORDS, ...ShimisenScraper.EXTRA_KEYWORDS];
    if (keywords.some((kw) => nameAndTag.includes(kw))) return true;
    const strongTerms = [
      "子ども食堂",
      "こども食堂",
      "子どもの居場所",
      "学習支援",
      "ひとり親",
      "外国にルーツ",
      "多文化共生",
      "フードバンク",
      "フードパントリー",
      "子どもの貧困",
    ];
    return strongTerms.some((kw) => excerpt.includes(kw));
  }
}

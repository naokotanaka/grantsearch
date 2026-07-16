import * as cheerio from "cheerio";
import { BaseScraper } from "./base-scraper";
import { Grant, SEARCH_KEYWORDS, DISCOVERY_KEYWORDS } from "../models/grant";

/**
 * CANPAN 助成制度データベースからのスクレイパー
 * https://fields.canpan.info/grant/
 *
 * 日本最大級の助成金DB。マイナーな財団系助成金の発掘の本命。
 *
 * ページ構造（実HTMLを確認済み）:
 * - keyword パラメータは効かないため、一覧を全ページ取得してこちらで関連分野に絞り込む
 * - 一覧は /grant/?page=N&sort=update&dir=desc（20件/ページ）
 * - 各行: 助成制度名 <a href="/grant/detail/ID">、実施団体 <a href="/organization/...">、
 *   対象事業、右列に <p class="status">募集中/募集予定/募集終了</p> と <p class="term">期間</p>
 */
export class CanpanScraper extends BaseScraper {
  private baseUrl = "https://fields.canpan.info";

  /** 取得する最大ページ数（現在は92件≒5ページ。余裕を持たせる） */
  private static readonly MAX_PAGES = 8;

  constructor() {
    super("canpan", "全国");
  }

  async search(): Promise<Grant[]> {
    const grants: Grant[] = [];

    for (let page = 1; page <= CanpanScraper.MAX_PAGES; page++) {
      try {
        const url = `${this.baseUrl}/grant/?page=${page}&sort=update&dir=desc`;
        const $ = await this.fetchPage(url);
        const pageGrants = this.parseListPage($);
        if (pageGrants.parsedRows === 0) break; // 最終ページを超えた
        grants.push(...pageGrants.grants);
      } catch (error) {
        console.error(
          `[CANPAN] ページ${page}の取得に失敗:`,
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
        "[CANPAN] 助成金を抽出できませんでした（ページ構成が変わった可能性があります）",
      );
    }

    // CANPANの詳細ページではなく公式サイトへのリンクに差し替える。
    // CANPANは日本財団の運営サイトで、ページ内に日本財団本体へのリンクが常に
    // あるため、助成元が日本財団でない限り候補から外す（例: 日本フィランソロピック
    // 財団の助成が日本財団トップにリンクされていた事故の防止）
    for (const grant of result) {
      const exclude = /日本財団/.test(grant.organization)
        ? /canpan\.info/
        : /canpan\.info|nippon-foundation\.or\.jp/;
      const official =
        (await this.resolveOfficialUrl(grant.url, exclude)) ??
        (await this.searchOfficialSite(
          `${grant.name} ${grant.organization}`,
          CanpanScraper.AGGREGATOR_SITES,
        ));
      if (official) grant.url = official;
    }
    return result;
  }

  /** 一覧1ページを解析。parsedRows は関連判定前の行数（ページ送り終端の判定用） */
  private parseListPage($: cheerio.CheerioAPI): {
    grants: Grant[];
    parsedRows: number;
  } {
    const grants: Grant[] = [];
    let parsedRows = 0;

    $("tr").each((_, elem) => {
      try {
        const $row = $(elem);
        const nameLink = $row.find('a[href*="/grant/detail/"]').first();
        if (!nameLink.length) return;
        parsedRows++;

        const name = this.cleanText(nameLink.text());
        const href = nameLink.attr("href") ?? "";
        const url = href.startsWith("http") ? href : `${this.baseUrl}${href}`;

        const organization =
          this.cleanText(
            $row.find('a[href*="/organization/detail/"]').first().text(),
          ) || "要確認";

        // dl 内の最後の dd が対象事業
        const targetProjects = this.cleanText($row.find("dl dd").last().text());

        const statusText = this.cleanText($row.find("p.status").first().text());
        const term = this.cleanText($row.find("p.term").first().text());

        if (!name || name.length < 4) return;
        if (statusText === "募集終了") return;
        if (/助成制度では(ございません|ありません)/.test(name)) return; // 注記付きの非助成情報
        if (!this.isRelevant(`${name} ${targetProjects}`)) return;

        if (statusText === "募集予定") {
          // 募集期間が発表済みの「これから募集」→ 募集前として予告掲載
          grants.push(
            this.createGrant({
              name,
              organization,
              region: "全国",
              targetProjects,
              applicationDeadline: term || "未発表",
              expectedPeriod: term
                ? `募集予定（発表済み）: ${term}`
                : "募集予定（時期未発表）",
              url,
              status: "募集前",
            }),
          );
        } else {
          // 募集中（またはステータス不明だが掲載されているもの）
          grants.push(
            this.createGrant({
              name,
              organization,
              region: "全国",
              targetProjects,
              applicationDeadline: term || "要確認",
              url,
              status:
                statusText === "募集中"
                  ? "募集中"
                  : this.detectStatus(statusText, term),
            }),
          );
        }
      } catch {
        // 個別行の解析エラーはスキップ
      }
    });

    return { grants, parsedRows };
  }

  private isRelevant(text: string): boolean {
    const keywords = [...SEARCH_KEYWORDS, ...DISCOVERY_KEYWORDS];
    return keywords.some((kw) => text.includes(kw));
  }
}

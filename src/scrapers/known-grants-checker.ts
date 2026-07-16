import { BaseScraper } from "./base-scraper";
import { Grant } from "../models/grant";
import { getKnownGrants } from "./known-grants";

/**
 * 定番リスト（known-grants）の自動チェック
 *
 * 各エントリの公式ページを毎週フェッチし、今年度の募集告知を検出できたら
 * 「募集中」＋実際の締切に自動昇格させる。検出できなければ「募集前」のまま
 * （expectedPeriod の例年時期を表示）。ベストエフォートであり、
 * ページ取得失敗や検出漏れがあってもエントリ自体は必ず掲載される。
 */
class KnownGrantsChecker extends BaseScraper {
  constructor() {
    super("known", "全国");
  }

  /** BaseScraper の抽象メソッド実装（checkAll を使うこと） */
  async search(): Promise<Grant[]> {
    return this.checkAll();
  }

  async checkAll(): Promise<Grant[]> {
    const grants = getKnownGrants();
    const results: Grant[] = [];

    // 同じURL（お知らせ一覧ページ等）を複数エントリが共有しているか
    const urlCount = new Map<string, number>();
    for (const g of grants) {
      const u = g.manualUrl || g.url;
      urlCount.set(u, (urlCount.get(u) ?? 0) + 1);
    }

    for (const grant of grants) {
      try {
        const shared = (urlCount.get(grant.manualUrl || grant.url) ?? 0) > 1;
        results.push(await this.checkOne(grant, shared));
      } catch {
        results.push(grant); // 取得失敗時はそのまま（募集前）
      }
    }
    return results;
  }

  /**
   * 1件の公式ページを確認し、募集中と判定できれば昇格させて返す。
   * urlShared=true（複数エントリが同じページを共有）のときは、助成金名の
   * 近傍から見つかった締切だけを使う（他の助成の締切との取り違え防止）。
   */
  async checkOne(grant: Grant, urlShared = false): Promise<Grant> {
    const url = grant.manualUrl || grant.url;
    if (!url) return grant;

    let text: string;
    try {
      const $ = await this.fetchPage(url);
      text = this.cleanText($("body").text());
    } catch (error) {
      console.log(
        `  [定番チェック] ${grant.name}: ページ取得失敗（募集前のまま）`,
      );
      return grant;
    }

    // 助成金名の特徴的な部分が見つかれば、その近傍だけを判定対象にする
    const key = KnownGrantsChecker.nameKey(grant.name);
    const windows: string[] = [];
    if (key) {
      let idx = text.indexOf(key);
      while (idx !== -1) {
        windows.push(
          text.slice(Math.max(0, idx - 100), idx + key.length + 400),
        );
        idx = text.indexOf(key, idx + key.length);
      }
    }
    if (windows.length === 0 && urlShared) {
      // 共有ページにこの助成の名前が無い → 判定材料なし（他の助成の締切での
      // 誤昇格を防ぐため、昇格しない）
      return grant;
    }
    const searchTexts = windows.length > 0 ? windows : [text];

    // 「締切/募集期間」などの語の近くに未来の日付があれば募集中とみなす
    // （無関係な未来日付での誤昇格を避けるため、必ずアンカー語に隣接した範囲だけを見る）
    const now = new Date();
    const horizon = new Date(now);
    horizon.setMonth(horizon.getMonth() + 12); // 1年より先の日付はノイズとみなす

    const anchorPattern =
      /(締切|締め切り|〆切|応募期間|募集期間|受付期間|申請期間|応募締切|申込期限)[^。｜|]{0,80}/g;
    for (const searchText of searchTexts) {
      for (const match of searchText.matchAll(anchorPattern)) {
        const segment = this.cleanText(match[0]);
        const deadlineDate = this.lastDateIn(segment);
        if (deadlineDate && deadlineDate >= now && deadlineDate <= horizon) {
          console.log(
            `  [定番チェック] ${grant.name}: 募集を検知（${segment.slice(0, 40)}…）`,
          );
          return {
            ...grant,
            status: "募集中",
            applicationDeadline:
              segment.length > 60 ? `${segment.slice(0, 60)}…` : segment,
            lastUpdated: new Date().toISOString(),
          };
        }
      }
    }

    return grant; // 検出できず → 募集前のまま
  }

  /**
   * 助成金名から、ページ内検索に使う特徴的な部分を取り出す。
   * 括弧書き・年度・回数を除いて最長の語（5文字以上）を使う。
   * 例:「むすびえ・こども食堂基金（年2回募集）」→「こども食堂基金」
   */
  private static nameKey(name: string): string {
    const stripped = name
      .replace(/[（(【][^）)】]*[）)】]/g, " ")
      .replace(/20\d{2}\s*年度?|令和\d+\s*年度?|第\s*\d+\s*[回期次]/g, " ");
    const tokens = stripped.split(/[\s、。・&＆×\/／]+/).filter(Boolean);
    const longest = tokens.sort((a, b) => b.length - a.length)[0] ?? "";
    return longest.length >= 5 ? longest : "";
  }

  /** 文字列中の最後の日付を返す */
  private lastDateIn(text: string): Date | null {
    const matches = [
      ...text.matchAll(/(?:令和\d+年|\d{4}年)?\d{1,2}月\d{1,2}日/g),
    ];
    if (matches.length === 0) return null;
    // 年の記載がない「M月D日」は現在年として解釈する
    const last = matches[matches.length - 1][0];
    const hasYear = /令和|\d{4}年/.test(last);
    const withYear = hasYear ? last : `${new Date().getFullYear()}年${last}`;
    let date = this.parseJapaneseDate(withYear);
    // 年の記載がない日付が半年以上前になる場合は、翌年の意味とみなす
    // （例: 12月にページが「締切: 1月20日」と書いているケース）
    if (date && !hasYear) {
      const halfYearAgo = new Date();
      halfYearAgo.setMonth(halfYearAgo.getMonth() - 6);
      if (date < halfYearAgo) {
        date = new Date(
          date.getFullYear() + 1,
          date.getMonth(),
          date.getDate(),
        );
      }
    }
    return date;
  }
}

/** 定番リストを公式ページと突き合わせて返す（searchAllSources から呼ぶ） */
export async function checkKnownGrants(): Promise<Grant[]> {
  return new KnownGrantsChecker().checkAll();
}

/**
 * 任意の助成金リストの公式ページをチェックし、募集検知したものを昇格させて返す。
 * 人間が「関係あり」と判定した発掘品の週次チェックに使う（定番リストと同じ検知ロジック）。
 */
export async function checkGrantsOpening(grants: Grant[]): Promise<Grant[]> {
  const checker = new KnownGrantsChecker();
  const results: Grant[] = [];
  for (const grant of grants) {
    try {
      results.push(await checker.checkOne(grant));
    } catch {
      results.push(grant);
    }
  }
  return results;
}

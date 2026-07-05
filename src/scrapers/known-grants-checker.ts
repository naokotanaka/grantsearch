import { BaseScraper } from './base-scraper';
import { Grant } from '../models/grant';
import { getKnownGrants } from './known-grants';

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
    super('known', '全国');
  }

  /** BaseScraper の抽象メソッド実装（checkAll を使うこと） */
  async search(): Promise<Grant[]> {
    return this.checkAll();
  }

  async checkAll(): Promise<Grant[]> {
    const grants = getKnownGrants();
    const results: Grant[] = [];

    for (const grant of grants) {
      try {
        results.push(await this.checkOne(grant));
      } catch {
        results.push(grant); // 取得失敗時はそのまま（募集前）
      }
    }
    return results;
  }

  /** 1件の公式ページを確認し、募集中と判定できれば昇格させて返す */
  private async checkOne(grant: Grant): Promise<Grant> {
    if (!grant.url) return grant;

    let text: string;
    try {
      const $ = await this.fetchPage(grant.url);
      text = this.cleanText($('body').text());
    } catch (error) {
      console.log(`  [定番チェック] ${grant.name}: ページ取得失敗（募集前のまま）`);
      return grant;
    }

    // 「締切/募集期間」などの語の近くに未来の日付があれば募集中とみなす
    // （無関係な未来日付での誤昇格を避けるため、必ずアンカー語に隣接した範囲だけを見る）
    const now = new Date();
    const horizon = new Date(now);
    horizon.setMonth(horizon.getMonth() + 12); // 1年より先の日付はノイズとみなす

    const anchorPattern = /(締切|締め切り|〆切|応募期間|募集期間|受付期間|申請期間|応募締切|申込期限)[^。｜|]{0,80}/g;
    for (const match of text.matchAll(anchorPattern)) {
      const segment = this.cleanText(match[0]);
      const deadlineDate = this.lastDateIn(segment);
      if (deadlineDate && deadlineDate >= now && deadlineDate <= horizon) {
        console.log(`  [定番チェック] ${grant.name}: 募集を検知（${segment.slice(0, 40)}…）`);
        return {
          ...grant,
          status: '募集中',
          applicationDeadline: segment.length > 60 ? `${segment.slice(0, 60)}…` : segment,
          lastUpdated: new Date().toISOString(),
        };
      }
    }

    return grant; // 検出できず → 募集前のまま
  }

  /** 文字列中の最後の日付を返す */
  private lastDateIn(text: string): Date | null {
    const matches = [...text.matchAll(/(?:令和\d+年|\d{4}年)?\d{1,2}月\d{1,2}日/g)];
    if (matches.length === 0) return null;
    // 年の記載がない「M月D日」は現在年として解釈する
    const last = matches[matches.length - 1][0];
    const withYear = /令和|\d{4}年/.test(last) ? last : `${new Date().getFullYear()}年${last}`;
    return this.parseJapaneseDate(withYear);
  }
}

/** 定番リストを公式ページと突き合わせて返す（searchAllSources から呼ぶ） */
export async function checkKnownGrants(): Promise<Grant[]> {
  return new KnownGrantsChecker().checkAll();
}

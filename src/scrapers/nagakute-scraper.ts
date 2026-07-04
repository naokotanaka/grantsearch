import { BaseScraper } from './base-scraper';
import { Grant } from '../models/grant';

/**
 * 長久手市公式サイトからの助成金・補助金情報スクレイパー
 * https://www.city.nagakute.lg.jp/
 *
 * 市の「補助金等一覧」ページには市民生活全般の補助金（防災・医療・介護・環境など）が
 * 大量に載っているため、当団体の活動分野に関係するものだけに絞り込む。
 * また、家庭・個人が申請する給付（保育料・養育費・予防接種など）は団体向けではないため
 * 対象外とし、添付ファイルやカテゴリ見出しのリンクも除外する。
 */
export class NagakuteScraper extends BaseScraper {
  private urls = [
    'https://www.city.nagakute.lg.jp/soshiki/somubu/zaiseika/1/1/1429.html',
    'https://www.city.nagakute.lg.jp/machizukuri/shiminkatudo/shimin/NPO/11558.html',
  ];

  /** 当団体の活動分野に関係するキーワード（いずれかを含むもののみ残す） */
  private static readonly RELEVANT_KEYWORDS = [
    '子育て', '子ども', 'こども', '子供', '児童', '食堂', 'フードパントリー',
    '外国', '多文化', '居場所', '学習支援', 'NPO', '市民活動', '協働', 'ボランティア',
  ];

  /** 助成金・補助金の項目らしさを示す語（一覧の無関係な行や見出しを除外するため） */
  private static readonly GRANT_TOKENS = [
    '補助金', '助成金', '助成', '給付金', '交付金', '奨励金', '支援金', '基金', '事業',
  ];

  /** 除外する語（添付ファイル・様式・カテゴリ見出しなど、助成金本体ではないもの） */
  private static readonly NOISE_PATTERNS = [
    'ファイル:', '様式', '要綱', '申請書', '報告書', '一覧', '案内',
  ];

  constructor() {
    super('nagakute', '長久手市');
  }

  async search(): Promise<Grant[]> {
    const grants: Grant[] = [];

    for (const url of this.urls) {
      try {
        const pageGrants = await this.scrapePage(url);
        grants.push(...pageGrants);
      } catch (error) {
        console.error(`[長久手市] ページ取得に失敗 (${url}):`, error instanceof Error ? error.message : error);
      }
    }

    // 表とリンクの両方から拾うため、IDで重複を除去
    const unique = new Map<string, Grant>();
    for (const grant of grants) unique.set(grant.id, grant);
    return Array.from(unique.values());
  }

  private async scrapePage(url: string): Promise<Grant[]> {
    const grants: Grant[] = [];
    const $ = await this.fetchPage(url);

    // 補助金一覧テーブルの各行を解析
    $('table tr').each((_, elem) => {
      try {
        const $elem = $(elem);
        const tds = $elem.find('td');
        if (tds.length === 0) return;

        const linkElem = $elem.find('a').first();
        const name = this.cleanText(linkElem.text() || tds.first().text());
        if (!this.isRelevantGrant(name)) return;

        const detailUrl = this.toAbsoluteUrl(linkElem.attr('href'), url);

        grants.push(this.createGrant({
          name,
          organization: '長久手市',
          region: '長久手市',
          url: detailUrl,
          targetProjects: this.extractFromColumns(tds, $),
        }));
      } catch {
        // 個別の要素の解析エラーはスキップ
      }
    });

    // リンク一覧も解析
    $('ul li a, .content a, article a').each((_, elem) => {
      try {
        const $elem = $(elem);
        const name = this.cleanText($elem.text());
        if (!this.isRelevantGrant(name)) return;

        const detailUrl = this.toAbsoluteUrl($elem.attr('href'), url);

        grants.push(this.createGrant({
          name,
          organization: '長久手市',
          region: '長久手市',
          url: detailUrl,
        }));
      } catch {
        // スキップ
      }
    });

    return grants;
  }

  /**
   * 当団体に関係する助成金・補助金だけを残す判定。
   * (1) 活動分野のキーワードを含み、(2) 助成金らしい語を含み、
   * (3) 添付ファイルや見出しなどのノイズ語を含まない、の3条件をすべて満たすもののみ true。
   */
  private isRelevantGrant(name: string): boolean {
    if (!name || name.length < 5) return false;
    if (NagakuteScraper.NOISE_PATTERNS.some(w => name.includes(w))) return false;
    const hasField = NagakuteScraper.RELEVANT_KEYWORDS.some(kw => name.includes(kw));
    const looksLikeGrant = NagakuteScraper.GRANT_TOKENS.some(t => name.includes(t));
    return hasField && looksLikeGrant;
  }

  private toAbsoluteUrl(href: string | undefined, fallback: string): string {
    if (!href) return fallback;
    return href.startsWith('http') ? href : `https://www.city.nagakute.lg.jp${href}`;
  }

  private extractFromColumns(tds: any, $: any): string {
    const texts: string[] = [];
    tds.each((_: number, td: any) => {
      const t = this.cleanText($(td).text());
      if (t) texts.push(t);
    });
    return texts.join(' / ');
  }
}

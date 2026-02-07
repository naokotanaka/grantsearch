import { BaseScraper } from './base-scraper';
import { Grant, SEARCH_KEYWORDS } from '../models/grant';

/**
 * 長久手市公式サイトからの助成金・補助金情報スクレイパー
 * https://www.city.nagakute.lg.jp/
 */
export class NagakuteScraper extends BaseScraper {
  private urls = [
    'https://www.city.nagakute.lg.jp/soshiki/somubu/zaiseika/1/1/1429.html',
    'https://www.city.nagakute.lg.jp/machizukuri/shiminkatudo/shimin/NPO/11558.html',
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

    return grants;
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

        const text = this.cleanText($elem.text());
        const linkElem = $elem.find('a').first();
        const name = this.cleanText(linkElem.text() || tds.first().text());
        const href = linkElem.attr('href');

        if (!name || name.length < 3) return;

        const detailUrl = href
          ? href.startsWith('http')
            ? href
            : `https://www.city.nagakute.lg.jp${href}`
          : url;

        const grant = this.createGrant({
          name,
          organization: '長久手市',
          region: '長久手市',
          url: detailUrl,
          targetProjects: this.extractFromColumns(tds, $),
        });

        grants.push(grant);
      } catch {
        // 個別の要素の解析エラーはスキップ
      }
    });

    // リンク一覧も解析
    $('ul li a, .content a, article a').each((_, elem) => {
      try {
        const $elem = $(elem);
        const name = this.cleanText($elem.text());
        const href = $elem.attr('href');

        if (!name || name.length < 5) return;
        if (!this.isRelevant(name)) return;

        const detailUrl = href
          ? href.startsWith('http')
            ? href
            : `https://www.city.nagakute.lg.jp${href}`
          : url;

        const grant = this.createGrant({
          name,
          organization: '長久手市',
          region: '長久手市',
          url: detailUrl,
        });

        grants.push(grant);
      } catch {
        // スキップ
      }
    });

    return grants;
  }

  private isRelevant(text: string): boolean {
    const keywords = [...SEARCH_KEYWORDS, '補助金', '助成', '支援金', 'NPO'];
    return keywords.some(kw => text.includes(kw));
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

import { BaseScraper } from './base-scraper';
import { Grant, SEARCH_KEYWORDS } from '../models/grant';

/**
 * WAM（独立行政法人 福祉医療機構）助成金情報スクレイパー
 * NPO・福祉団体向け助成事業の情報を取得
 */
export class WamScraper extends BaseScraper {
  private baseUrl = 'https://www.wam.go.jp';

  constructor() {
    super('wam', '全国');
  }

  async search(): Promise<Grant[]> {
    const grants: Grant[] = [];

    try {
      // WAMの助成事業ページ
      const urls = [
        `${this.baseUrl}/hp/cat/cat_jyosei.html`,
        `${this.baseUrl}/hp/cat/cat_kodomo.html`,
      ];

      for (const url of urls) {
        try {
          const pageGrants = await this.scrapePage(url);
          grants.push(...pageGrants);
        } catch (error) {
          console.error(`[WAM] ページ取得に失敗 (${url}):`, error instanceof Error ? error.message : error);
        }
      }
    } catch (error) {
      console.error('[WAM] 検索に失敗:', error instanceof Error ? error.message : error);
    }

    return grants;
  }

  private async scrapePage(url: string): Promise<Grant[]> {
    const grants: Grant[] = [];

    try {
      const $ = await this.fetchPage(url);

      $('table tr, .content li, article, .list-item, a').each((_, elem) => {
        try {
          const $elem = $(elem);
          const linkElem = $elem.is('a') ? $elem : $elem.find('a').first();
          const name = this.cleanText(linkElem.text());
          const href = linkElem.attr('href');

          if (!name || name.length < 5) return;
          if (!this.isRelevant(name)) return;

          const detailUrl = href
            ? href.startsWith('http')
              ? href
              : `${this.baseUrl}${href}`
            : url;

          const text = this.cleanText($elem.text());
          const expenses = this.detectExpenseEligibility(text);

          const grant = this.createGrant({
            name,
            organization: '福祉医療機構（WAM）',
            region: '全国',
            url: detailUrl,
            ...expenses,
            status: this.detectStatus(text),
          });

          grants.push(grant);
        } catch {
          // スキップ
        }
      });
    } catch {
      // ページ取得エラー
    }

    return grants;
  }

  private isRelevant(text: string): boolean {
    return SEARCH_KEYWORDS.some(kw => text.includes(kw));
  }
}

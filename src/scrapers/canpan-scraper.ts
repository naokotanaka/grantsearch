import { BaseScraper } from './base-scraper';
import { Grant, SEARCH_KEYWORDS } from '../models/grant';

/**
 * CANPAN 助成制度データベースからのスクレイパー
 * https://fields.canpan.info/grant/
 */
export class CanpanScraper extends BaseScraper {
  private baseUrl = 'https://fields.canpan.info/grant';

  constructor() {
    super('canpan', '全国');
  }

  async search(): Promise<Grant[]> {
    const grants: Grant[] = [];
    const keywords = ['子ども', '子育て', '外国人', '多文化共生', '児童'];

    for (const keyword of keywords) {
      try {
        const pageGrants = await this.searchByKeyword(keyword);
        grants.push(...pageGrants);
      } catch (error) {
        console.error(`[CANPAN] キーワード「${keyword}」の検索に失敗:`, error instanceof Error ? error.message : error);
      }
    }

    // IDで重複を除去
    const uniqueGrants = new Map<string, Grant>();
    for (const grant of grants) {
      uniqueGrants.set(grant.id, grant);
    }

    return Array.from(uniqueGrants.values());
  }

  private async searchByKeyword(keyword: string): Promise<Grant[]> {
    const grants: Grant[] = [];
    const searchUrl = `${this.baseUrl}/?keyword=${encodeURIComponent(keyword)}&status=1`;

    const $ = await this.fetchPage(searchUrl);

    // CANPANの助成制度一覧ページの各助成情報を取得
    $('table.list tbody tr, .grant-list .grant-item, .result-list li').each((_, elem) => {
      try {
        const $elem = $(elem);
        const nameElem = $elem.find('a').first();
        const name = this.cleanText(nameElem.text());
        const href = nameElem.attr('href');

        if (!name || !this.isRelevant(name)) return;

        const url = href ? (href.startsWith('http') ? href : `https://fields.canpan.info${href}`) : '';
        const tds = $elem.find('td');

        const organization = this.cleanText(tds.eq(1).text() || '');
        const deadline = this.cleanText(tds.eq(2).text() || '');

        const grant = this.createGrant({
          name,
          organization: organization || '要確認',
          region: '全国',
          applicationDeadline: deadline || '要確認',
          url,
          status: this.detectStatus('', deadline),
        });

        grants.push(grant);
      } catch {
        // 個別の要素の解析エラーはスキップ
      }
    });

    return grants;
  }

  private isRelevant(text: string): boolean {
    return SEARCH_KEYWORDS.some(kw => text.includes(kw));
  }
}

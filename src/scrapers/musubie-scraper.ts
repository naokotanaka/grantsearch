import { BaseScraper } from './base-scraper';
import { Grant } from '../models/grant';

/**
 * むすびえ（全国こども食堂支援センター）助成金情報スクレイパー
 * https://musubie.org/news_cat/subsidy/
 */
export class MusubieScraper extends BaseScraper {
  private pageUrl = 'https://musubie.org/news_cat/subsidy/';

  constructor() {
    super('musubie', '全国');
  }

  async search(): Promise<Grant[]> {
    const grants: Grant[] = [];

    try {
      const $ = await this.fetchPage(this.pageUrl);

      // むすびえの助成金情報一覧を解析
      $('article, .post-item, .news-item, .entry-content li, .wp-block-post').each((_, elem) => {
        try {
          const $elem = $(elem);
          const linkElem = $elem.find('a').first();
          const name = this.cleanText(linkElem.text() || $elem.find('h2, h3, .title').text());
          const href = linkElem.attr('href');

          if (!name || name.length < 5) return;

          const text = this.cleanText($elem.text());
          const url = href ? (href.startsWith('http') ? href : `https://musubie.org${href}`) : '';

          // 締切日を抽出
          const deadlineMatch = text.match(/(\d{1,2}\/\d{1,2})\s*〆/) ??
            text.match(/(\d{4}[年\/]\d{1,2}[月\/]\d{1,2}日?)(?:\s*〆|\s*締切)/) ??
            text.match(/締切[：:]?\s*(\d{4}[年\/]\d{1,2}[月\/]\d{1,2}日?)/);
          const deadline = deadlineMatch ? deadlineMatch[1] : '要確認';

          const grant = this.createGrant({
            name,
            organization: this.extractOrganization(name, text),
            region: '全国',
            applicationDeadline: deadline,
            url,
            targetProjects: 'こども食堂・フードパントリー・子どもの居場所づくり',
            status: this.detectStatus(text, deadline),
          });

          grants.push(grant);
        } catch {
          // スキップ
        }
      });
    } catch (error) {
      console.error('[むすびえ] ページ取得に失敗:', error instanceof Error ? error.message : error);
    }

    return grants;
  }

  private extractOrganization(name: string, text: string): string {
    // 助成名から助成元を推定
    const patterns = [
      /(.+?(?:財団|基金|機構|協会|センター))/,
      /(.+?)(?:助成|基金)/,
    ];
    for (const pattern of patterns) {
      const match = name.match(pattern);
      if (match) return match[1];
    }
    return 'むすびえ経由';
  }
}

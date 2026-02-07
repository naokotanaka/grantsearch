import { BaseScraper } from './base-scraper';
import { Grant, SEARCH_KEYWORDS } from '../models/grant';

/**
 * 愛知県社会福祉協議会ボランティアセンター 助成金情報ページからのスクレイパー
 * http://aichivc.jp/volunteer/ouenplaza/plaza_subsidy.html
 */
export class AichiVcScraper extends BaseScraper {
  private pageUrl = 'http://aichivc.jp/volunteer/ouenplaza/plaza_subsidy.html';

  constructor() {
    super('aichi_vc', '愛知県');
  }

  async search(): Promise<Grant[]> {
    const grants: Grant[] = [];

    try {
      const $ = await this.fetchPage(this.pageUrl);

      // 助成金情報の各行を解析
      $('table tr, .content li, article, .entry, .subsidy-item').each((_, elem) => {
        try {
          const $elem = $(elem);
          const text = this.cleanText($elem.text());
          const linkElem = $elem.find('a').first();
          const name = this.cleanText(linkElem.text());
          const href = linkElem.attr('href');

          if (!name || name.length < 5) return;
          if (!this.isRelevant(text)) return;

          const url = href
            ? href.startsWith('http')
              ? href
              : `http://aichivc.jp/volunteer/ouenplaza/${href}`
            : '';

          // テキストから締切を抽出
          const deadlineMatch = text.match(
            /(?:締切|〆切|期限|期日)[：:]?\s*(.+?)(?:\s|$|。|）|\))/
          ) ?? text.match(/(\d{4}[年\/]\d{1,2}[月\/]\d{1,2}日?)/);
          const deadline = deadlineMatch ? deadlineMatch[1] : '要確認';

          const grant = this.createGrant({
            name,
            organization: this.extractOrganization(text) || '要確認',
            region: '愛知県',
            applicationDeadline: deadline,
            url,
            targetProjects: this.extractTargetProjects(text),
            status: this.detectStatus(text, deadline),
          });

          grants.push(grant);
        } catch {
          // 個別の要素の解析エラーはスキップ
        }
      });
    } catch (error) {
      console.error('[愛知VC] ページ取得に失敗:', error instanceof Error ? error.message : error);
    }

    return grants;
  }

  private isRelevant(text: string): boolean {
    return SEARCH_KEYWORDS.some(kw => text.includes(kw));
  }

  private extractOrganization(text: string): string {
    const match = text.match(
      /(?:主催|助成元|実施)[：:]?\s*(.+?)(?:\s|$|。)/
    ) ?? text.match(/(?:財団|基金|機構|センター|協議会)/);
    return match ? this.cleanText(match[1] || match[0]) : '';
  }

  private extractTargetProjects(text: string): string {
    const match = text.match(
      /(?:対象[事業活動]*|助成対象)[：:]?\s*(.+?)(?:\s*(?:締切|金額|期間|詳細)|$|。)/
    );
    return match ? this.cleanText(match[1]) : '';
  }
}

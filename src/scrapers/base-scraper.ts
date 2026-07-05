import axios, { AxiosInstance } from 'axios';
import * as cheerio from 'cheerio';
import crypto from 'crypto';
import { Grant, Region, Eligibility, GrantStatus } from '../models/grant';

export abstract class BaseScraper {
  protected client: AxiosInstance;
  protected sourceName: string;
  protected region: Region;

  constructor(sourceName: string, region: Region) {
    this.sourceName = sourceName;
    this.region = region;
    this.client = axios.create({
      timeout: 30000,
      headers: {
        'User-Agent': 'GrantSearch/1.0 (NPO Grant Research Tool)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ja,en;q=0.5',
      },
    });
  }

  abstract search(): Promise<Grant[]>;

  protected async fetchPage(url: string): Promise<cheerio.CheerioAPI> {
    const response = await this.client.get(url, { responseType: 'text' });
    return cheerio.load(response.data);
  }

  protected generateId(name: string, organization: string): string {
    const hash = crypto.createHash('md5').update(`${name}_${organization}`).digest('hex').slice(0, 8);
    return `${this.sourceName}_${hash}`;
  }

  protected createGrant(partial: Partial<Grant> & { name: string; organization: string }): Grant {
    return {
      id: partial.id ?? this.generateId(partial.name, partial.organization),
      name: partial.name,
      organization: partial.organization,
      region: partial.region ?? this.region,
      targetProjects: partial.targetProjects ?? '',
      grantAmount: partial.grantAmount ?? '要確認',
      grantPeriod: partial.grantPeriod ?? '要確認',
      applicationDeadline: partial.applicationDeadline ?? '要確認',
      expectedPeriod: partial.expectedPeriod ?? '',
      personnelCosts: partial.personnelCosts ?? '不明',
      honorarium: partial.honorarium ?? '不明',
      rent: partial.rent ?? '不明',
      status: partial.status ?? '不明',
      url: partial.url ?? '',
      source: this.sourceName,
      lastUpdated: new Date().toISOString(),
    };
  }

  protected detectExpenseEligibility(text: string): {
    personnelCosts: Eligibility;
    honorarium: Eligibility;
    rent: Eligibility;
  } {
    const result = {
      personnelCosts: '不明' as Eligibility,
      honorarium: '不明' as Eligibility,
      rent: '不明' as Eligibility,
    };

    if (/人件費/.test(text)) {
      result.personnelCosts = /人件費[^。]*不可|人件費[^。]*除く|人件費[^。]*対象外/.test(text) ? '不可' : '可';
    }
    if (/謝金|謝礼/.test(text)) {
      result.honorarium = /謝金[^。]*不可|謝礼[^。]*不可|謝金[^。]*除く/.test(text) ? '不可' : '可';
    }
    if (/家賃|賃借料|賃貸/.test(text)) {
      result.rent = /家賃[^。]*不可|賃借料[^。]*不可|家賃[^。]*除く/.test(text) ? '不可' : '可';
    }

    return result;
  }

  protected detectStatus(text: string, deadline?: string): GrantStatus {
    if (/募集中|受付中|申請受付/.test(text)) return '募集中';
    if (/募集終了|受付終了|締切済/.test(text)) return '募集終了';
    if (/募集予定|近日公開/.test(text)) return '募集前';

    if (deadline) {
      const deadlineDate = this.parseJapaneseDate(deadline);
      if (deadlineDate) {
        const now = new Date();
        if (deadlineDate > now) return '募集中';
        return '募集終了';
      }
    }

    return '不明';
  }

  protected parseJapaneseDate(text: string): Date | null {
    // 令和X年Y月Z日 形式
    const reiwaMatch = text.match(/令和(\d+)年(\d+)月(\d+)日/);
    if (reiwaMatch) {
      const year = 2018 + parseInt(reiwaMatch[1]);
      return new Date(year, parseInt(reiwaMatch[2]) - 1, parseInt(reiwaMatch[3]));
    }

    // 20XX年Y月Z日 形式
    const fullMatch = text.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
    if (fullMatch) {
      return new Date(parseInt(fullMatch[1]), parseInt(fullMatch[2]) - 1, parseInt(fullMatch[3]));
    }

    // 20XX/Y/Z 形式
    const slashMatch = text.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
    if (slashMatch) {
      return new Date(parseInt(slashMatch[1]), parseInt(slashMatch[2]) - 1, parseInt(slashMatch[3]));
    }

    return null;
  }

  protected cleanText(text: string): string {
    return text.replace(/[\s\n\r\t]+/g, ' ').trim();
  }

  /** SNS・検索エンジンなど、公式サイトとして扱わないドメイン */
  private static readonly NON_OFFICIAL =
    /facebook\.com|twitter\.com|x\.com|instagram\.com|youtube\.com|line\.me|linkedin\.com|hatena|google\.[a-z.]+|news\.google/;

  /** まとめサイト等、検索フォールバックで公式サイトとして採用しないドメイン */
  protected static readonly AGGREGATOR_SITES =
    /shimisen-kyoto|canpan\.info|musubie\.org|wikipedia|note\.com|ameblo\.jp|hatenablog/;

  /**
   * まとめ記事・詳細ページを開き、その中から助成元の公式サイトへのリンクを探す。
   * ドメインの出現回数＋リンク文言（公式/詳細等）＋ボタン風クラスでスコアリングし、
   * 最有力のドメインの代表URLを返す。見つからなければ null。
   */
  protected async resolveOfficialUrl(
    pageUrl: string,
    exclude: RegExp,
    containerSelector?: string
  ): Promise<string | null> {
    try {
      const $ = await this.fetchPage(pageUrl);
      const scope = containerSelector && $(containerSelector).length ? $(containerSelector) : $('body');

      const byDomain = new Map<string, { url: string; score: number; bestLinkScore: number }>();
      scope.find('a[href^="http"]').each((_, el) => {
        const href = $(el).attr('href') ?? '';
        if (exclude.test(href) || BaseScraper.NON_OFFICIAL.test(href)) return;

        let domain: string;
        try { domain = new URL(href).hostname; } catch { return; }

        const text = this.cleanText($(el).text());
        const cls = $(el).attr('class') ?? '';
        let score = 1;
        if (/公式|詳細|ホームページ|ウェブサイト|こちら|HP/.test(text)) score += 3;
        if (/btn|external|official/.test(cls)) score += 2;
        if (/\.pdf($|[?#])/i.test(href)) score -= 2;      // 申請書PDFよりページを優先
        if (/contact|otoiawase|inquiry/i.test(href)) score -= 3; // 問い合わせページは避ける

        const current = byDomain.get(domain);
        if (current) {
          current.score += score;
          // ドメイン内で最もスコアの高い個別リンクを代表URLにする
          if (score > current.bestLinkScore) {
            current.url = href;
            current.bestLinkScore = score;
          }
        } else {
          byDomain.set(domain, { url: href, score, bestLinkScore: score });
        }
      });

      let best: { url: string; score: number; bestLinkScore: number } | null = null;
      for (const candidate of byDomain.values()) {
        if (!best || candidate.score > best.score) best = candidate;
      }
      return best && best.score > 0 ? best.url : null;
    } catch {
      return null;
    }
  }

  /**
   * 記事内に公式リンクが無い場合のフォールバック：
   * DuckDuckGo（HTML版・キー不要）で助成金名を検索し、最初のまともな結果を返す。
   */
  protected async searchOfficialSite(query: string, exclude: RegExp): Promise<string | null> {
    try {
      const response = await this.client.get('https://html.duckduckgo.com/html/', {
        params: { q: query },
        responseType: 'text',
      });
      const $ = cheerio.load(response.data);

      let found: string | null = null;
      $('a.result__a').each((_, el) => {
        if (found) return;
        let href = $(el).attr('href') ?? '';
        // DDGは /l/?uddg=<エンコード済みURL> 形式のリダイレクトを挟むことがある
        const redirect = href.match(/uddg=([^&]+)/);
        if (redirect) href = decodeURIComponent(redirect[1]);
        if (!/^https?:\/\//.test(href)) return;
        if (exclude.test(href) || BaseScraper.NON_OFFICIAL.test(href)) return;
        found = href;
      });
      return found;
    } catch {
      return null;
    }
  }
}

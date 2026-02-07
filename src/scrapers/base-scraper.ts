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
}

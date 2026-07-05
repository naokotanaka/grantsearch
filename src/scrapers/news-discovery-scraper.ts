import * as cheerio from 'cheerio';
import { BaseScraper } from './base-scraper';
import { Grant, Region } from '../models/grant';

/**
 * Google News RSS 横断検索による助成金発見スクレイパー
 *
 * ニュース記事・ブログ・プレスリリースを横断検索できる公開RSSを使い、
 * 固定の情報源には載らないマイナーな助成金の告知を発掘する。
 * RSSはXML構造が安定しており、HTMLの構造変化に強い。
 *
 * 発見した記事は「候補」であり、内容の確認はリンク先で行う前提
 * （レポートでは専用セクションに新しい順で掲載する）。
 */
export class NewsDiscoveryScraper extends BaseScraper {
  /** 検索キーワード（それぞれ別々にRSS検索する） */
  private static readonly QUERIES = [
    '子ども食堂 助成金 募集',
    '子育て支援 助成金 募集 NPO',
    '学習支援 助成 募集 団体',
    '外国ルーツ 子ども 助成',
    'フードパントリー 助成 募集',
  ];

  /** 掲載する記事の新しさ（日数） */
  private static readonly MAX_AGE_DAYS = 60;

  /** 全体の掲載上限（レポートが発見候補で溢れないように） */
  private static readonly MAX_ITEMS = 20;

  constructor() {
    super('news', '全国');
  }

  async search(): Promise<Grant[]> {
    const grants: Grant[] = [];

    for (const query of NewsDiscoveryScraper.QUERIES) {
      try {
        const url =
          'https://news.google.com/rss/search?q=' + encodeURIComponent(query) +
          '&hl=ja&gl=JP&ceid=' + encodeURIComponent('JP:ja');
        const response = await this.client.get(url, { responseType: 'text' });
        const $ = cheerio.load(response.data, { xmlMode: true });
        grants.push(...this.parseRss($));
      } catch (error) {
        console.error(`[News発見] 検索「${query}」に失敗:`, error instanceof Error ? error.message : error);
      }
    }

    // IDで重複を除去し、新しい順に上限まで
    const unique = new Map<string, Grant>();
    for (const grant of grants) unique.set(grant.id, grant);
    const result = Array.from(unique.values())
      .sort((a, b) => (a.grantPeriod < b.grantPeriod ? 1 : -1)) // grantPeriod に配信日を格納している
      .slice(0, NewsDiscoveryScraper.MAX_ITEMS);

    if (result.length === 0) {
      console.error('[News発見] 記事を取得できませんでした（RSSの形式が変わった可能性があります）');
    }

    // Google News の転送URLは機械では解決できないため、
    // 記事タイトルで検索して公式サイト（または元記事）のURLに差し替える
    for (const grant of result) {
      const official = await this.searchOfficialSite(
        grant.name.replace(/…$/, ''),
        NewsDiscoveryScraper.AGGREGATOR_SITES
      );
      if (official) grant.url = official;
    }
    return result;
  }

  /** RSS（XML）を解析して助成金告知らしき記事を抽出 */
  private parseRss($: cheerio.CheerioAPI): Grant[] {
    const grants: Grant[] = [];
    const now = new Date();
    const cutoff = new Date(now);
    cutoff.setDate(cutoff.getDate() - NewsDiscoveryScraper.MAX_AGE_DAYS);

    $('item').each((_, elem) => {
      try {
        const $item = $(elem);
        const rawTitle = this.cleanText($item.find('title').first().text());
        const link = this.cleanText($item.find('link').first().text());
        const pubDateText = this.cleanText($item.find('pubDate').first().text());
        const sourceName = this.cleanText($item.find('source').first().text());

        if (!rawTitle || !link) return;

        // タイトル末尾の「 - 配信元」を除去
        const title = this.cleanText(rawTitle.replace(/\s*-\s*[^-]+$/, ''));

        // 助成金の「募集告知」らしい記事のみ（贈呈式・寄付報告などは除外）
        if (!/助成|補助金|支援金|基金/.test(title)) return;
        if (!/募集|公募|受付|応募|申請|案内|開始/.test(title)) return;
        if (/贈呈|寄付を実施|採択|決定しました|報告/.test(title)) return;

        // 配信日（古い記事は除外）
        const published = pubDateText ? new Date(pubDateText) : null;
        if (!published || isNaN(published.getTime()) || published < cutoff) return;

        // 地域の推定
        const region: Region = /長久手/.test(title) ? '長久手市'
          : /愛知|名古屋/.test(title) ? '愛知県' : '全国';

        // タイトルから締切らしき日付を抽出（あれば）
        const deadlineMatch = title.match(/(\d{1,2}月\d{1,2}日)\s*(?:まで|締切|〆)/);

        grants.push(this.createGrant({
          // 同じ記事が複数の配信元から流れるため、IDはタイトルのみから生成して重複を畳む
          id: this.generateId(title, 'news'),
          name: title.length > 70 ? `${title.slice(0, 70)}…` : title,
          organization: sourceName || '要確認（記事参照）',
          region,
          targetProjects: 'ニュース/ブログから自動発見（内容はリンク先で要確認）',
          grantAmount: '要確認',
          grantPeriod: published.toISOString().slice(0, 10), // 配信日（並べ替え用）
          applicationDeadline: deadlineMatch ? deadlineMatch[1] : '要確認（記事参照）',
          url: link,
          status: '不明',
        }));
      } catch {
        // 個別記事の解析エラーはスキップ
      }
    });

    return grants;
  }
}

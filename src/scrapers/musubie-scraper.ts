import * as cheerio from 'cheerio';
import { BaseScraper } from './base-scraper';
import { Grant } from '../models/grant';

/**
 * むすびえ（全国こども食堂支援センター）助成金情報スクレイパー
 * https://musubie.org/news_cat/subsidy/
 *
 * むすびえ自身の基金に加え、企業・財団の「こども食堂向け助成」の告知記事が
 * 随時掲載される。マイナー助成金の発掘源として有用。
 *
 * ページ構造（実HTMLを確認済み）:
 * - 記事は <div class="row-news"> ごと。中に <time datetime="YYYY-MM-DD"> と
 *   <h3 class="entry-title"><a href="...">記事タイトル</a></h3>
 * - 助成金カテゴリの一覧のため、記事はほぼすべて助成関連
 */
export class MusubieScraper extends BaseScraper {
  private pageUrls = [
    'https://musubie.org/news_cat/subsidy/',
    'https://musubie.org/news_cat/subsidy/page/2/',
  ];

  /** 掲載する記事の新しさ（日数）。古い告知は募集終了の可能性が高いため除外 */
  private static readonly MAX_AGE_DAYS = 90;

  constructor() {
    super('musubie', '全国');
  }

  async search(): Promise<Grant[]> {
    const grants: Grant[] = [];

    for (const url of this.pageUrls) {
      try {
        const $ = await this.fetchPage(url);
        grants.push(...this.parseListPage($));
      } catch (error) {
        console.error(`[むすびえ] ページ取得に失敗 (${url}):`, error instanceof Error ? error.message : error);
      }
    }

    // IDで重複を除去
    const unique = new Map<string, Grant>();
    for (const grant of grants) unique.set(grant.id, grant);
    const result = Array.from(unique.values());

    if (result.length === 0) {
      console.error('[むすびえ] 記事を抽出できませんでした（ページ構成が変わった可能性があります）');
    }
    return result;
  }

  /** 記事一覧ページを解析 */
  private parseListPage($: cheerio.CheerioAPI): Grant[] {
    const grants: Grant[] = [];
    const now = new Date();
    const cutoff = new Date(now);
    cutoff.setDate(cutoff.getDate() - MusubieScraper.MAX_AGE_DAYS);

    $('.row-news').each((_, elem) => {
      try {
        const $item = $(elem);
        const linkElem = $item.find('h3.entry-title a, h3 a').first();
        const title = this.cleanText(linkElem.text());
        const href = linkElem.attr('href') ?? '';
        if (!title || title.length < 8) return;

        // 助成関連の記事のみ
        if (!/助成|基金|補助|支援金|応援便|ギフト|寄贈/.test(title)) return;
        // 「募集開始」等の告知でない限り、採択結果・報告系の記事は除外
        const isOpening = /募集開始|募集中|受付開始|公募開始|【助成金情報】/.test(title);
        if (!isOpening && /報告|採択|結果発表|終了しました|発表のお知らせ/.test(title)) return;

        // 記事日付（古い告知は除外）
        const datetime = $item.find('time').attr('datetime') ?? '';
        const published = datetime ? new Date(datetime) : null;
        if (published && published < cutoff) return;

        const url = href.startsWith('http') ? href : `https://musubie.org${href}`;

        // タイトルから締切を抽出できれば利用
        const deadlineMatch = title.match(/(\d{1,2}\/\d{1,2})\s*[〆締]/) ??
          title.match(/締切[：:]?\s*(\d{1,2}月\d{1,2}日)/);
        const deadline = deadlineMatch ? deadlineMatch[1] : '要確認（記事参照）';

        grants.push(this.createGrant({
          name: title.length > 60 ? `${title.slice(0, 60)}…` : title,
          organization: this.extractOrganization(title),
          region: '全国',
          targetProjects: 'こども食堂・フードパントリー・子どもの居場所づくり',
          applicationDeadline: deadline,
          url,
          status: /募集開始|募集中|受付開始|公募/.test(title) ? '募集中' : '不明',
        }));
      } catch {
        // 個別記事の解析エラーはスキップ
      }
    });

    return grants;
  }

  /** 記事タイトルから助成元を推定 */
  private extractOrganization(title: string): string {
    // 先頭の【助成金情報】などのラベルを除去してから推定する
    const stripped = this.cleanText(title.replace(/【[^】]*】/g, ''));
    const patterns = [
      /^([^「『（(]+?(?:財団|基金|株式会社|グループ|ホールディングス))/,
      /^(.+?)[＆&×]/,
      /「?([^「」]+?(?:財団|基金))」?/,
    ];
    for (const pattern of patterns) {
      const match = stripped.match(pattern);
      if (match && match[1].length <= 30) return this.cleanText(match[1]);
    }
    return 'むすびえ掲載情報';
  }
}

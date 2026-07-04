import * as cheerio from 'cheerio';
import { BaseScraper } from './base-scraper';
import { Grant, GrantStatus, Region } from '../models/grant';

/**
 * 愛知県社会福祉協議会ボランティアセンター「助成金等の情報」ページのスクレイパー
 * http://aichivc.jp/volunteer/ouenplaza/plaza_subsidy.html
 *
 * ページ構造（実HTMLを確認済み）:
 * - 各助成金は「<p>◆<strong>助成金名</strong>（助成元）New</p>」の見出し段落で始まり、
 *   説明段落と「■期間：…」「■詳細：<a href>URL</a>」の段落が続く。
 * - ◆と助成金名が別々の<strong>に分かれる場合や、見出しに「（終了）」が付く場合がある。
 * - 2023年度以降の古い助成金も削除されず残るアーカイブ型のページ。
 *
 * そのため、締切日が未来のもの（または New マーク付き）だけを採用し、
 * 終了済み・過年度分は載せない。地域は名称・助成元に「愛知」「名古屋」を
 * 含むものだけ愛知県、それ以外は全国扱いとする。
 */
export class AichiVcScraper extends BaseScraper {
  private pageUrl = 'http://aichivc.jp/volunteer/ouenplaza/plaza_subsidy.html';

  constructor() {
    super('aichi_vc', '愛知県');
  }

  async search(): Promise<Grant[]> {
    try {
      const $ = await this.fetchPage(this.pageUrl);
      const grants = this.parseDocument($);

      if (grants.length === 0) {
        console.error('[愛知VC] 募集中の助成金を抽出できませんでした（ページ構成が変わった可能性があります）');
      }
      return grants;
    } catch (error) {
      console.error('[愛知VC] ページ取得に失敗:', error instanceof Error ? error.message : error);
      return [];
    }
  }

  /** ページ全体を解析し、募集中の助成金だけを返す */
  private parseDocument($: cheerio.CheerioAPI): Grant[] {
    interface Block {
      name: string;
      organization: string;
      isNew: boolean;
      closed: boolean;
      body: string;
      url: string;
    }

    // 全<p>を順に走査し、「◆＋太字」の見出しごとにブロック化する
    const blocks: Block[] = [];
    let current: Block | null = null;

    $('p').each((_, elem) => {
      const $p = $(elem);
      const text = this.cleanText($p.text());
      const strongs = $p.find('strong');

      if (text.startsWith('◆') && strongs.length > 0) {
        if (current) blocks.push(current);

        // 太字タグを全て連結してから装飾の◆を除去（◆が別タグの場合に対応）
        let name = this.cleanText(
          strongs.toArray().map(s => this.cleanText($(s).text())).join('')
        );
        name = this.cleanText(name.replace(/[◆◇♦]/g, ''));

        const rest = text.replace(/[◆◇♦]/g, '').slice(name.length);
        const orgMatch = rest.match(/[（(]([^）)]+)[）)]/);

        current = {
          name,
          organization: orgMatch ? this.cleanText(orgMatch[1]) : '要確認',
          isNew: /New/i.test(rest),
          closed: /（終了）|\(終了\)/.test(text),
          body: '',
          url: '',
        };
      } else if (current) {
        current.body += ' ' + text;
        if (!current.url) {
          const a = $p.find('a[href^="http"]').first();
          if (a.length) current.url = a.attr('href') ?? '';
        }
      }
    });
    if (current) blocks.push(current);

    const now = new Date();
    const grants: Grant[] = [];

    for (const block of blocks) {
      try {
        if (block.closed || block.name.length < 6) continue;

        const deadlineMatch = block.body.match(/期間[：:]\s*([^■]+)/);
        const deadline = deadlineMatch ? this.cleanText(deadlineMatch[1]) : '';
        const deadlineDate = this.lastDateIn(deadline);
        const isOpen = deadlineDate !== null && deadlineDate >= now;

        // 締切が未来のもの、または New マーク付きのものだけ採用（過年度アーカイブを除外）
        if (!isOpen && !block.isNew) continue;

        const amountMatch = block.body.match(/補助額[】\]]?\s*([^）)■【]+[）)]?)/);

        // 名称・助成元に愛知/名古屋を含むものだけ愛知県、他は全国募集とみなす
        const region: Region = /愛知|名古屋/.test(block.name + block.organization) ? '愛知県' : '全国';
        const status: GrantStatus = isOpen ? '募集中' : this.detectStatus(block.body, deadline);

        grants.push(this.createGrant({
          name: block.name,
          organization: block.organization,
          region,
          applicationDeadline: deadline || '要確認',
          grantAmount: amountMatch ? this.cleanText(amountMatch[1]) : '要確認',
          url: block.url || this.pageUrl,
          status,
        }));
      } catch {
        // 個別ブロックの解析エラーはスキップ
      }
    }

    return grants;
  }

  /** 期間文字列の最後に現れる日付（＝締切側）を返す */
  private lastDateIn(text: string): Date | null {
    const matches = [...text.matchAll(/(?:令和\d+年|\d{4}年)\d{1,2}月\d{1,2}日/g)];
    if (matches.length === 0) return null;
    return this.parseJapaneseDate(matches[matches.length - 1][0]);
  }
}

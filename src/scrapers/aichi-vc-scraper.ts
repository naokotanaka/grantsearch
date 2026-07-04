import { BaseScraper } from './base-scraper';
import { Grant } from '../models/grant';

/**
 * 愛知県社会福祉協議会ボランティアセンター「助成金等の情報」ページのスクレイパー
 * http://aichivc.jp/volunteer/ouenplaza/plaza_subsidy.html
 *
 * このページは表ではなく、各助成金が「◆助成金名（助成元）」という見出しで始まり、
 * 続けて説明・「■期間：…」・「■詳細：URL」が本文として並ぶ構成になっている。
 * そのため本文テキストを「◆」で区切って1件ずつ解析する。
 * （詳細URLは本文中にそのまま文字として表示されるため、テキストから抽出できる。）
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

      // 本文コンテナ（見つからなければ body 全体）のテキストを取得
      const root = $('#main, .main, #contents, .contents, .content, article').first();
      const container = root.length ? root : $('body');
      const fullText = this.cleanText(container.text());

      // 「◆（◇・♦）」ごとに助成金ブロックへ分割（先頭の導入文は捨てる）
      const blocks = fullText.split(/[◆◇♦]/).slice(1);

      for (const block of blocks) {
        try {
          const grant = this.parseBlock(block);
          if (grant) grants.push(grant);
        } catch {
          // 個別ブロックの解析エラーはスキップ
        }
      }

      if (grants.length === 0) {
        console.error('[愛知VC] 助成金を抽出できませんでした（ページ構成が変わった可能性があります）');
      }
    } catch (error) {
      console.error('[愛知VC] ページ取得に失敗:', error instanceof Error ? error.message : error);
    }

    // 同名の重複を除去
    const unique = new Map<string, Grant>();
    for (const grant of grants) unique.set(grant.id, grant);
    return Array.from(unique.values());
  }

  /** 「◆」以降の1ブロックから助成金1件を組み立てる。助成金でなければ null。 */
  private parseBlock(block: string): Grant | null {
    const text = this.cleanText(block);
    if (!text) return null;

    // 助成金の見出しらしさの確認（装飾用の◆などを除外）
    if (!/期間|詳細|助成|補助/.test(text)) return null;

    // 助成金名：先頭から「（」「New」「■」のいずれかまで
    const name = this.cleanText(text.split(/[（(]|New|■/)[0]);
    if (!name || name.length < 4) return null;

    // 助成元：最初の（…）の中身
    const orgMatch = text.match(/[（(]([^）)]+)[）)]/);
    const organization = orgMatch ? this.cleanText(orgMatch[1]) : '要確認';

    // 期間（締切）：「期間：」以降、次の「■」まで
    const periodMatch = text.match(/期間[：:]\s*([^■]+)/);
    const deadline = periodMatch ? this.cleanText(periodMatch[1]) : '要確認';

    // 補助額：「補助額】…」以降、最初の閉じ括弧まで（複数コースは先頭のみ）
    const amountMatch = text.match(/補助額[】\]]?\s*([^）)■【]+[）)]?)/);
    const grantAmount = amountMatch ? this.cleanText(amountMatch[1]) : '要確認';

    // 詳細URL：ブロック内に文字として現れる最初の http(s) リンク
    const urlMatch = text.match(/https?:\/\/[^\s　）)、]+/);
    const url = urlMatch ? urlMatch[0] : this.pageUrl;

    return this.createGrant({
      name,
      organization,
      region: '愛知県',
      applicationDeadline: deadline,
      grantAmount,
      url,
      status: this.detectStatus(text, deadline),
    });
  }
}

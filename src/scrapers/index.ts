import { BaseScraper } from './base-scraper';
import { CanpanScraper } from './canpan-scraper';
import { AichiVcScraper } from './aichi-vc-scraper';
import { NagakuteScraper } from './nagakute-scraper';
import { MusubieScraper } from './musubie-scraper';
import { WamScraper } from './wam-scraper';
import { ShimisenScraper } from './shimisen-scraper';
import { NewsDiscoveryScraper } from './news-discovery-scraper';
import { getKnownGrants } from './known-grants';
import { checkKnownGrants } from './known-grants-checker';
import { Grant } from '../models/grant';
import { getDatabase, upsertGrants, logSearch } from '../models/database';

/** 全スクレイパーの一覧 */
function getAllScrapers(): BaseScraper[] {
  return [
    new CanpanScraper(),
    new MusubieScraper(),
    new WamScraper(),
    new AichiVcScraper(),
    new NagakuteScraper(),
    new ShimisenScraper(),
    new NewsDiscoveryScraper(),
  ];
}

/** 全ソースから助成金情報を収集 */
export async function searchAllSources(): Promise<Grant[]> {
  const db = getDatabase();
  const allGrants: Grant[] = [];

  // 1. 定番リストの読み込み＋公式ページとの突き合わせ（募集検知で自動昇格）
  console.log('📋 定番助成金リストを確認中（各公式ページをチェック）...');
  const knownGrants = await checkKnownGrants();
  allGrants.push(...knownGrants);
  upsertGrants(db, knownGrants);
  logSearch(db, 'known', knownGrants.length);
  const openCount = knownGrants.filter(g => g.status === '募集中').length;
  console.log(`  → ${knownGrants.length}件の定番助成金を登録（うち募集検知 ${openCount}件）`);

  // 2. 各Webスクレイパーの実行
  const scrapers = getAllScrapers();

  for (const scraper of scrapers) {
    const scraperName = scraper.constructor.name;
    console.log(`\n🔍 ${scraperName} を実行中...`);

    try {
      const grants = await scraper.search();
      allGrants.push(...grants);
      upsertGrants(db, grants);
      logSearch(db, scraperName, grants.length);
      if (grants.length === 0) {
        // 0件は「該当なし」ではなく解析不全の可能性が高いため、警告として記録する
        console.warn(`  ⚠ ${scraperName}: 0件（ページ構成の変化による解析不全の可能性あり）`);
        logSearch(db, scraperName, 0, '抽出0件（要確認）');
      } else {
        console.log(`  → ${grants.length}件の助成金情報を取得`);
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`  ✗ ${scraperName} でエラー: ${errorMsg}`);
      logSearch(db, scraperName, 0, errorMsg);
    }
  }

  db.close();

  // IDで重複を除去
  const uniqueGrants = new Map<string, Grant>();
  for (const grant of allGrants) {
    uniqueGrants.set(grant.id, grant);
  }

  // 複数の情報源が同じ助成金を載せていることがあるため、名前ベースでも重複を畳む
  const result = dedupeAcrossSources(Array.from(uniqueGrants.values()));
  const statusCounts = {
    募集中: result.filter(g => g.status === '募集中').length,
    募集前: result.filter(g => g.status === '募集前').length,
  };
  console.log(`\n✅ 合計: ${result.length}件（募集中 ${statusCounts.募集中}件 / 募集予定 ${statusCounts.募集前}件）`);

  return result;
}

/**
 * 情報源をまたいだ重複の畳み込み。
 * 正規化した名前の包含関係（例:「子どもぬくもり基金」⊂「日本フィランソロピック財団
 * 第4回 子どもぬくもり基金」）で同一助成金とみなし、情報の充実したほうを残す。
 */
export function dedupeAcrossSources(grants: Grant[]): Grant[] {
  const normalize = (name: string): string =>
    name
      .replace(/[【】「」『』（）()《》\s　・＆&×／/]/g, '')
      .replace(/こども/g, '子ども')
      .replace(/20\d{2}\s*年度?|令和\d+\s*年度?/g, '')
      .replace(/第\s*\d+\s*[回期次]/g, '')
      .replace(/募集|公募/g, '')
      .replace(/[-‐－―…]+$/g, '');

  // 情報の充実度（大きいほど優先して残す）
  const score = (g: Grant): number =>
    (g.status === '募集中' ? 100 : 0) +
    (g.expectedPeriod.includes('発表済み') ? 50 : 0) +
    (g.expectedPeriod.includes('昨年実績') ? 20 : 0) +
    (g.source === 'known' ? 15 : 0) +
    (g.targetProjects ? 10 : 0) +
    (g.grantAmount !== '要確認' ? 5 : 0);

  const kept: { grant: Grant; norm: string }[] = [];

  for (const grant of grants.slice().sort((a, b) => score(b) - score(a))) {
    const norm = normalize(grant.name);
    const isDup = kept.some(k => {
      const [a, b] = [k.norm, norm];
      const shorter = a.length <= b.length ? a : b;
      // 片方がもう片方を含む、または13文字以上の共通部分がある場合は同一助成金とみなす
      if (shorter.length >= 8 && (a.includes(b) || b.includes(a))) return true;
      return longestCommonSubstring(a, b) >= 13;
    });
    if (!isDup) kept.push({ grant, norm });
  }

  return kept.map(k => k.grant);
}

/** 2つの文字列の最長共通部分文字列の長さ */
function longestCommonSubstring(a: string, b: string): number {
  if (!a || !b) return 0;
  let best = 0;
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best) best = cur[j];
      }
    }
    prev = cur;
  }
  return best;
}

export { getKnownGrants };

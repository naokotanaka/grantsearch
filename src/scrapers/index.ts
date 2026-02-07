import { BaseScraper } from './base-scraper';
import { CanpanScraper } from './canpan-scraper';
import { AichiVcScraper } from './aichi-vc-scraper';
import { NagakuteScraper } from './nagakute-scraper';
import { MusubieScraper } from './musubie-scraper';
import { WamScraper } from './wam-scraper';
import { getKnownGrants } from './known-grants';
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
  ];
}

/** 全ソースから助成金情報を収集 */
export async function searchAllSources(): Promise<Grant[]> {
  const db = getDatabase();
  const allGrants: Grant[] = [];

  // 1. 手動登録データの取得
  console.log('📋 既知の助成金データを読み込み中...');
  const knownGrants = getKnownGrants();
  allGrants.push(...knownGrants);
  upsertGrants(db, knownGrants);
  logSearch(db, 'known', knownGrants.length);
  console.log(`  → ${knownGrants.length}件の既知データを登録`);

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
      console.log(`  → ${grants.length}件の助成金情報を取得`);
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

  const result = Array.from(uniqueGrants.values());
  console.log(`\n✅ 合計: ${result.length}件の助成金情報を収集しました`);

  return result;
}

export { getKnownGrants };

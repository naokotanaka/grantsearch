import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { Grant } from "./grant";

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "grants.db");

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

export function getDatabase(): Database.Database {
  ensureDataDir();
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  initializeSchema(db);
  return db;
}

function initializeSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS grants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      organization TEXT NOT NULL,
      region TEXT NOT NULL,
      target_projects TEXT NOT NULL DEFAULT '',
      grant_amount TEXT NOT NULL DEFAULT '',
      grant_period TEXT NOT NULL DEFAULT '',
      application_deadline TEXT NOT NULL DEFAULT '',
      expected_period TEXT NOT NULL DEFAULT '',
      personnel_costs TEXT NOT NULL DEFAULT '不明',
      honorarium TEXT NOT NULL DEFAULT '不明',
      rent TEXT NOT NULL DEFAULT '不明',
      status TEXT NOT NULL DEFAULT '不明',
      url TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT '',
      last_updated TEXT NOT NULL DEFAULT '',
      benefit_type TEXT NOT NULL DEFAULT '不明',
      memo TEXT NOT NULL DEFAULT '',
      manual_url TEXT NOT NULL DEFAULT '',
      hidden INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS search_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      searched_at TEXT NOT NULL,
      grants_found INTEGER NOT NULL DEFAULT 0,
      error TEXT
    );
  `);

  // 既存DB向けの列追加マイグレーション（列が既にあれば無視）
  const migrations = [
    "ALTER TABLE grants ADD COLUMN expected_period TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE grants ADD COLUMN benefit_type TEXT NOT NULL DEFAULT '不明'",
    "ALTER TABLE grants ADD COLUMN memo TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE grants ADD COLUMN manual_url TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE grants ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0",
  ];
  for (const sql of migrations) {
    try {
      db.exec(sql);
    } catch {
      // 列が存在する場合はエラーになるが問題ない
    }
  }
}

export function upsertGrant(db: Database.Database, grant: Grant): void {
  // 注意: memo と manual_url は人間の入力なので、ON CONFLICT の更新対象に含めない
  // （INSERT時の初期値としてのみ使う）。hidden は再登場したら 0（表示）に戻す。
  const stmt = db.prepare(`
    INSERT INTO grants (id, name, organization, region, target_projects, grant_amount,
      grant_period, application_deadline, expected_period, personnel_costs, honorarium, rent,
      status, url, source, last_updated, benefit_type, memo, manual_url, hidden)
    VALUES (@id, @name, @organization, @region, @targetProjects, @grantAmount,
      @grantPeriod, @applicationDeadline, @expectedPeriod, @personnelCosts, @honorarium, @rent,
      @status, @url, @source, @lastUpdated, @benefitType, @memo, @manualUrl, 0)
    ON CONFLICT(id) DO UPDATE SET
      name = @name,
      organization = @organization,
      region = @region,
      target_projects = @targetProjects,
      grant_amount = @grantAmount,
      grant_period = @grantPeriod,
      application_deadline = @applicationDeadline,
      expected_period = @expectedPeriod,
      personnel_costs = @personnelCosts,
      honorarium = @honorarium,
      rent = @rent,
      status = @status,
      url = @url,
      source = @source,
      last_updated = @lastUpdated,
      benefit_type = @benefitType,
      hidden = 0
  `);
  stmt.run(grant);
}

export function upsertGrants(db: Database.Database, grants: Grant[]): void {
  const upsertMany = db.transaction((items: Grant[]) => {
    for (const grant of items) {
      upsertGrant(db, grant);
    }
  });
  upsertMany(grants);
}

export function getAllGrants(db: Database.Database): Grant[] {
  const rows = db
    .prepare("SELECT * FROM grants ORDER BY application_deadline ASC")
    .all() as any[];
  return rows.map(rowToGrant);
}

export function getActiveGrants(db: Database.Database): Grant[] {
  const rows = db
    .prepare(
      "SELECT * FROM grants WHERE status IN ('募集中', '募集前', '不明') ORDER BY application_deadline ASC",
    )
    .all() as any[];
  return rows.map(rowToGrant);
}

export function getGrantsByRegion(
  db: Database.Database,
  region: string,
): Grant[] {
  const rows = db
    .prepare(
      "SELECT * FROM grants WHERE region = ? ORDER BY application_deadline ASC",
    )
    .all(region) as any[];
  return rows.map(rowToGrant);
}

/** 表示対象（hidden=0）の助成金を取得する。レポート生成はこれを使う */
export function getVisibleGrants(db: Database.Database): Grant[] {
  const rows = db
    .prepare(
      "SELECT * FROM grants WHERE hidden = 0 ORDER BY application_deadline ASC",
    )
    .all() as any[];
  return rows.map(rowToGrant);
}

/** idで1件取得する（なければ null） */
export function getGrantById(db: Database.Database, id: string): Grant | null {
  const row = db.prepare("SELECT * FROM grants WHERE id = ?").get(id) as any;
  return row ? rowToGrant(row) : null;
}

/** 人間のメモを更新する（検索・AI読み取りでは変更されない） */
export function updateMemo(
  db: Database.Database,
  id: string,
  memo: string,
): void {
  db.prepare("UPDATE grants SET memo = ? WHERE id = ?").run(memo, id);
}

/** 人間が登録した募集要項URLを更新する */
export function updateManualUrl(
  db: Database.Database,
  id: string,
  url: string,
): void {
  db.prepare("UPDATE grants SET manual_url = ? WHERE id = ?").run(url, id);
}

/** AI再読み取り結果を反映する（memo / manual_url は変更しない） */
export function updateGrantDetails(db: Database.Database, grant: Grant): void {
  db.prepare(
    `UPDATE grants SET
      target_projects = @targetProjects,
      grant_amount = @grantAmount,
      grant_period = @grantPeriod,
      application_deadline = @applicationDeadline,
      personnel_costs = @personnelCosts,
      honorarium = @honorarium,
      rent = @rent,
      status = @status,
      benefit_type = @benefitType,
      last_updated = @lastUpdated
    WHERE id = @id`,
  ).run(grant);
}

/**
 * 最終リストに入らなかった行を非表示にする
 * （情報源をまたぐ重複・AIが対象外と判断したもの・今回見つからなかった古い行）
 */
export function hideGrantsNotIn(db: Database.Database, ids: string[]): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => "?").join(",");
  db.prepare(
    `UPDATE grants SET hidden = 1 WHERE id NOT IN (${placeholders})`,
  ).run(...ids);
}

export function logSearch(
  db: Database.Database,
  source: string,
  grantsFound: number,
  error?: string,
): void {
  db.prepare(
    "INSERT INTO search_log (source, searched_at, grants_found, error) VALUES (?, ?, ?, ?)",
  ).run(source, new Date().toISOString(), grantsFound, error ?? null);
}

function rowToGrant(row: any): Grant {
  return {
    id: row.id,
    name: row.name,
    organization: row.organization,
    region: row.region,
    targetProjects: row.target_projects,
    grantAmount: row.grant_amount,
    grantPeriod: row.grant_period,
    applicationDeadline: row.application_deadline,
    expectedPeriod: row.expected_period ?? "",
    personnelCosts: row.personnel_costs,
    honorarium: row.honorarium,
    rent: row.rent,
    status: row.status,
    url: row.url,
    source: row.source,
    lastUpdated: row.last_updated,
    benefitType: row.benefit_type ?? "不明",
    memo: row.memo ?? "",
    manualUrl: row.manual_url ?? "",
  };
}

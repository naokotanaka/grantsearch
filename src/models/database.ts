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
      last_updated TEXT NOT NULL DEFAULT ''
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
  try {
    db.exec(
      "ALTER TABLE grants ADD COLUMN expected_period TEXT NOT NULL DEFAULT ''",
    );
  } catch {
    // 列が存在する場合はエラーになるが問題ない
  }
}

export function upsertGrant(db: Database.Database, grant: Grant): void {
  const stmt = db.prepare(`
    INSERT INTO grants (id, name, organization, region, target_projects, grant_amount,
      grant_period, application_deadline, expected_period, personnel_costs, honorarium, rent, status, url, source, last_updated)
    VALUES (@id, @name, @organization, @region, @targetProjects, @grantAmount,
      @grantPeriod, @applicationDeadline, @expectedPeriod, @personnelCosts, @honorarium, @rent, @status, @url, @source, @lastUpdated)
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
      last_updated = @lastUpdated
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
  };
}

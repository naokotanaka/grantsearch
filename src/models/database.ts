import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { Grant, GrantAlias, HumanJudgment } from "./grant";
import type {
  TraceFunderRecord,
  TraceResult,
} from "../enrich/supporter-trace";
import type { GovItem, GovRecord } from "../scrapers/gov-koubo-scraper";

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

export function initializeSchema(db: Database.Database): void {
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
      hidden INTEGER NOT NULL DEFAULT 0,
      human_judgment TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS search_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      searched_at TEXT NOT NULL,
      grants_found INTEGER NOT NULL DEFAULT 0,
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS merge_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_at TEXT NOT NULL,
      kept_id TEXT NOT NULL,
      kept_name TEXT NOT NULL,
      folded_name TEXT NOT NULL,
      folded_source TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS watch_sites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT NOT NULL,
      url TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );

    -- 支援元サーチ（enrich/supporter-trace.ts）
    CREATE TABLE IF NOT EXISTS trace_pages (
      url TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      read_at TEXT NOT NULL,
      funders INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS trace_funders (
      key TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      program_name TEXT NOT NULL DEFAULT '',
      clue TEXT NOT NULL DEFAULT '',
      page_url TEXT NOT NULL DEFAULT '',
      checked_at TEXT NOT NULL,
      result TEXT NOT NULL,
      grant_name TEXT NOT NULL DEFAULT '',
      grant_url TEXT NOT NULL DEFAULT '',
      benefit_type TEXT NOT NULL DEFAULT '不明'
    );

    -- 国の公募（scrapers/gov-koubo-scraper.ts）。見たリンクと、AIの振り分けの結果
    CREATE TABLE IF NOT EXISTS gov_items (
      url TEXT PRIMARY KEY,
      site_key TEXT NOT NULL,
      title TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      organization TEXT NOT NULL DEFAULT '',
      first_seen TEXT NOT NULL,
      relevant INTEGER NOT NULL DEFAULT 0,
      reason TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS trace_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_at TEXT NOT NULL,
      pages INTEGER NOT NULL DEFAULT 0,
      mentions INTEGER NOT NULL DEFAULT 0,
      checked INTEGER NOT NULL DEFAULT 0,
      found INTEGER NOT NULL DEFAULT 0,
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
    "ALTER TABLE grants ADD COLUMN human_judgment TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE grants ADD COLUMN aliases TEXT NOT NULL DEFAULT '[]'",
    "ALTER TABLE trace_funders ADD COLUMN page_url TEXT NOT NULL DEFAULT ''",
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
  // 注意: memo・manual_url・human_judgment は人間の入力なので、ON CONFLICT の
  // 更新対象に含めない（INSERT時の初期値としてのみ使う）。
  // hidden は再登場したら 0（表示）に戻す。
  const stmt = db.prepare(`
    INSERT INTO grants (id, name, organization, region, target_projects, grant_amount,
      grant_period, application_deadline, expected_period, personnel_costs, honorarium, rent,
      status, url, source, last_updated, benefit_type, memo, manual_url, hidden, human_judgment,
      aliases)
    VALUES (@id, @name, @organization, @region, @targetProjects, @grantAmount,
      @grantPeriod, @applicationDeadline, @expectedPeriod, @personnelCosts, @honorarium, @rent,
      @status, @url, @source, @lastUpdated, @benefitType, @memo, @manualUrl, 0, @humanJudgment,
      @aliases)
    ON CONFLICT(id) DO UPDATE SET
      aliases = @aliases,
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
  stmt.run({ ...grant, aliases: JSON.stringify(grant.aliases ?? []) });
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

/**
 * 表示対象の助成金を取得する。レポート生成はこれを使う。
 * hidden=1 と、人間が「関係ない」と判定したものは含まない。
 */
export function getVisibleGrants(db: Database.Database): Grant[] {
  const rows = db
    .prepare(
      "SELECT * FROM grants WHERE hidden = 0 AND human_judgment != '関係ない' ORDER BY application_deadline ASC",
    )
    .all() as any[];
  return rows.map(rowToGrant);
}

/** 人間の判定が付いた助成金を取得する（'関係あり' / '関係ない'） */
export function getGrantsByJudgment(
  db: Database.Database,
  judgment: HumanJudgment,
): Grant[] {
  const rows = db
    .prepare("SELECT * FROM grants WHERE human_judgment = ? ORDER BY name ASC")
    .all(judgment) as any[];
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

/** 人間の判定（関係あり/関係ない/空=取り消し）を更新する */
export function updateHumanJudgment(
  db: Database.Database,
  id: string,
  judgment: HumanJudgment,
): void {
  // 「関係ない」以外へ変えるとき（取り消し・関係あり）は hidden も解除する。
  // 👎 → 検索実行 → 「戻す」の順だと hidden=1 が残り、本体にも折りたたみにも
  // 表示されない迷子になるため、戻した行は必ず再表示する
  db.prepare(
    "UPDATE grants SET human_judgment = ?, hidden = CASE WHEN ? = '関係ない' THEN hidden ELSE 0 END WHERE id = ?",
  ).run(judgment, judgment, id);
}

/** AI再読み取り結果を反映する（memo / manual_url / human_judgment は変更しない） */
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

/** 巡回サイト（毎週の検索でページ内の助成金リンクを拾う対象） */
export interface WatchSite {
  id: number;
  label: string;
  url: string;
  createdAt: string;
}

export function getWatchSites(db: Database.Database): WatchSite[] {
  const rows = db
    .prepare("SELECT * FROM watch_sites ORDER BY id ASC")
    .all() as any[];
  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    url: row.url,
    createdAt: row.created_at,
  }));
}

/** 巡回サイトを追加する（同じURLが登録済みならラベルだけ更新） */
export function addWatchSite(
  db: Database.Database,
  label: string,
  url: string,
): void {
  db.prepare(
    `INSERT INTO watch_sites (label, url, created_at) VALUES (?, ?, ?)
     ON CONFLICT(url) DO UPDATE SET label = excluded.label`,
  ).run(label, url, new Date().toISOString());
}

export function deleteWatchSite(db: Database.Database, id: number): void {
  db.prepare("DELETE FROM watch_sites WHERE id = ?").run(id);
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
    humanJudgment: row.human_judgment ?? "",
    aliases: parseAliases(row.aliases),
  };
}

function parseAliases(raw: unknown): GrantAlias[] {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** 同一と判定してまとめた組の記録（1回の検索実行分） */
export interface MergeRecord {
  keptId: string;
  keptName: string;
  foldedName: string;
  foldedSource: string;
  reason: string;
}

/** まとめた組を記録する（run_at は検索実行の開始時刻で揃える） */
export function logMerges(
  db: Database.Database,
  runAt: string,
  merges: MergeRecord[],
): void {
  const stmt = db.prepare(
    "INSERT INTO merge_log (run_at, kept_id, kept_name, folded_name, folded_source, reason) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const insertMany = db.transaction((items: MergeRecord[]) => {
    for (const m of items) {
      stmt.run(runAt, m.keptId, m.keptName, m.foldedName, m.foldedSource, m.reason);
    }
  });
  insertMany(merges);
}

/** 支援元サーチの結果を記録する（読んだページ・調べた助成元・実行の記録） */
export function saveTraceResult(
  db: Database.Database,
  runAt: string,
  result: TraceResult,
  error?: string,
): void {
  const pageStmt = db.prepare(
    `INSERT INTO trace_pages (url, kind, read_at, funders) VALUES (?, ?, ?, ?)
     ON CONFLICT(url) DO UPDATE SET kind = excluded.kind, read_at = excluded.read_at, funders = excluded.funders`,
  );
  const funderStmt = db.prepare(
    `INSERT INTO trace_funders (key, name, program_name, clue, page_url, checked_at, result, grant_name, grant_url, benefit_type)
     VALUES (@key, @name, @programName, @clue, @pageUrl, @checkedAt, @result, @grantName, @grantUrl, @benefitType)
     ON CONFLICT(key) DO UPDATE SET name = excluded.name, program_name = excluded.program_name,
       clue = excluded.clue, page_url = excluded.page_url, checked_at = excluded.checked_at, result = excluded.result,
       grant_name = excluded.grant_name, grant_url = excluded.grant_url, benefit_type = excluded.benefit_type`,
  );
  const runStmt = db.prepare(
    "INSERT INTO trace_runs (run_at, pages, mentions, checked, found, error) VALUES (?, ?, ?, ?, ?, ?)",
  );
  db.transaction(() => {
    for (const p of result.pages) pageStmt.run(p.url, p.kind, runAt, p.funders);
    for (const f of result.funders) funderStmt.run({ ...f, checkedAt: runAt });
    const s = result.stats;
    runStmt.run(runAt, s.pages, s.mentions, s.checked, s.found, error ?? null);
  })();
}

/** 指定日時以降に読んだページのURL */
export function getRecentTracePages(
  db: Database.Database,
  sinceIso: string,
): Set<string> {
  const rows = db
    .prepare("SELECT url FROM trace_pages WHERE read_at >= ?")
    .all(sinceIso) as { url: string }[];
  return new Set(rows.map((r) => r.url));
}

/** 指定日時以降に調べた助成元のキー */
export function getRecentTraceFunders(
  db: Database.Database,
  sinceIso: string,
): Set<string> {
  const rows = db
    .prepare("SELECT key FROM trace_funders WHERE checked_at >= ?")
    .all(sinceIso) as { key: string }[];
  return new Set(rows.map((r) => r.key));
}

/** 月曜の検索に取り込む候補（指定日時以降に見つかった助成金） */
export function getTraceCandidates(
  db: Database.Database,
  sinceIso: string,
): TraceFunderRecord[] {
  const rows = db
    .prepare(
      "SELECT * FROM trace_funders WHERE result = 'found' AND checked_at >= ? ORDER BY checked_at, key",
    )
    .all(sinceIso) as any[];
  return rows.map((r) => ({
    key: r.key,
    name: r.name,
    programName: r.program_name,
    clue: r.clue,
    pageUrl: r.page_url ?? "",
    result: "found",
    grantName: r.grant_name,
    grantUrl: r.grant_url,
    benefitType: r.benefit_type,
  }));
}

export interface TraceRun {
  runAt: string;
  pages: number;
  mentions: number;
  checked: number;
  found: number;
  error: string | null;
}

/** 直近の支援元サーチの実行記録（無ければ null） */
export function getLatestTraceRun(db: Database.Database): TraceRun | null {
  const row = db
    .prepare("SELECT * FROM trace_runs ORDER BY run_at DESC, id DESC LIMIT 1")
    .get() as any;
  if (!row) return null;
  return {
    runAt: row.run_at,
    pages: row.pages,
    mentions: row.mentions,
    checked: row.checked,
    found: row.found,
    error: row.error ?? null,
  };
}

/** 国の公募：今回新しく見たリンクと振り分けの結果を記録する（既にあれば変えない） */
export function saveGovItems(
  db: Database.Database,
  seenAt: string,
  items: GovItem[],
): void {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO gov_items (url, site_key, title, name, organization, first_seen, relevant, reason)
     VALUES (@url, @siteKey, @title, @name, @organization, @seenAt, @relevantInt, @reason)`,
  );
  db.transaction(() => {
    for (const item of items)
      stmt.run({ ...item, seenAt, relevantInt: item.relevant ? 1 : 0 });
  })();
}

/** 国の公募：これまでに見たリンク（AIに渡し直さない） */
export function getSeenGovUrls(db: Database.Database): Set<string> {
  const rows = db.prepare("SELECT url FROM gov_items").all() as { url: string }[];
  return new Set(rows.map((r) => r.url));
}

/** 国の公募：月曜の検索に取り込む（指定日時以降に見つけ、対象と判定したもの） */
export function getRelevantGovItems(
  db: Database.Database,
  sinceIso: string,
): GovRecord[] {
  const rows = db
    .prepare(
      "SELECT * FROM gov_items WHERE relevant = 1 AND first_seen >= ? ORDER BY first_seen, url",
    )
    .all(sinceIso) as any[];
  return rows.map((r) => ({
    url: r.url,
    siteKey: r.site_key,
    title: r.title,
    name: r.name,
    organization: r.organization,
  }));
}

/** 直近の検索実行でまとめた組（レポート下部の確認用） */
export function getLatestMerges(db: Database.Database): MergeRecord[] {
  const rows = db
    .prepare(
      `SELECT kept_id, kept_name, folded_name, folded_source, reason FROM merge_log
       WHERE run_at = (SELECT MAX(run_at) FROM merge_log) ORDER BY id`,
    )
    .all() as any[];
  return rows.map((r) => ({
    keptId: r.kept_id,
    keptName: r.kept_name,
    foldedName: r.folded_name,
    foldedSource: r.folded_source,
    reason: r.reason ?? "",
  }));
}

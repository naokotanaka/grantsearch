# CLAUDE.md

This file guides AI assistants (Claude Code and others) working in this repository.

## Project overview

**grantsearch** (助成金・補助金 定期検索システム) is a TypeScript/Node.js tool that
periodically collects Japanese grant and subsidy (助成金・補助金) information relevant to
an NPO working in:

- 子育て支援 (childcare support)
- 子ども食堂・フードパントリー (children's cafeterias / food pantries)
- 外国にルーツを持つ人の支援 (support for people with foreign roots)
- 児童の健全育成・居場所づくり (healthy child development / community spaces)
- 学習支援 (learning support)

Target regions: **全国 (nationwide)**, **愛知県 (Aichi Prefecture)**, **長久手市 (Nagakute City)**.

The tool scrapes and aggregates grant data, stores it in SQLite, and produces
Markdown + HTML reports. A weekly GitHub Actions workflow runs the search, commits
the reports, and publishes the latest one to GitHub Pages. There is also a small
built-in web dashboard for running searches manually from a phone.

The primary user is non-technical and Japanese-speaking, so **user-facing strings,
console output, comments, and reports are written in Japanese**. Preserve this
convention when editing existing code.

## Commands

All commands run through npm scripts (defined in `package.json`):

| Command | What it does |
|---------|--------------|
| `npm run build` | Compile TypeScript (`src/` → `dist/`) via `tsc` |
| `npm run dev` | Run `src/index.ts` directly with `ts-node` (no build step) |
| `npm run search` | Scrape all sources, store to DB, generate reports (`dist/index.js search`) |
| `npm run report` | Regenerate reports from existing DB data only (no scraping) |
| `npm run server` | Start the web dashboard (default port 3000, override with `PORT`) |
| `npm run schedule` | Run in-process cron scheduler (default: weekly Mon 09:00) |
| `npm start -- schedule "0 9 * * 1"` | Scheduler with a custom cron expression |

`npm run build` must be run before the `start`/`search`/`report`/`server`/`schedule`
scripts, which execute compiled JS from `dist/`. During development prefer `npm run dev`.

The CLI entry point (`src/index.ts`) dispatches on `process.argv[2]`
(`search` | `report` | `server` | `schedule` | `help`), defaulting to `search`.

There is currently **no test runner and no linter configured** — verify changes by
building (`npm run build`) and running the relevant command.

## Architecture & data flow

```
sources ──► scrapers ──► Grant[] ──► SQLite (data/grants.db) ──► reports (output/)
                            │                                        ├─ *.md
  known-grants.ts (manual)  │                                        └─ *.html
  CANPAN / むすびえ / WAM /  │                                    generate-pages.ts
  愛知県VC / 長久手市 (web)  ┘                                        └─ pages/index.html (GitHub Pages)
```

1. **`searchAllSources()`** (`src/scrapers/index.ts`) is the orchestrator. It:
   - Loads manually-curated grants from `getKnownGrants()` first.
   - Runs each scraper in `getAllScrapers()` sequentially, catching per-scraper
     errors so one failure never aborts the whole run.
   - Upserts every result into SQLite and writes a row to `search_log`.
   - Deduplicates by `Grant.id` and returns the merged list.
2. **`generateAllReports(grants?)`** (`src/reports/report-generator.ts`) writes a
   Markdown report, an HTML report (dated `grants-report-YYYY-MM-DD.{md,html}`), and
   a console summary. If `grants` is omitted it reads all grants from the DB, so
   `npm run report` works without re-scraping.
3. **`generate-pages.ts`** is a standalone script (run as `node dist/generate-pages.js`,
   not imported by `index.ts`). It copies `output/` into a fresh `pages/` directory and
   makes the newest HTML report `pages/index.html` for GitHub Pages.

### Key files

- `src/index.ts` — CLI entry point / command dispatcher.
- `src/models/grant.ts` — the central `Grant` interface plus `Region`,
  `Eligibility`, `GrantStatus` types and the `SEARCH_KEYWORDS` / `TARGET_FIELDS`
  constants. **Start here when changing the data shape.**
- `src/models/database.ts` — `better-sqlite3` access layer: schema init,
  `upsertGrant(s)`, query helpers (`getAllGrants`, `getActiveGrants`,
  `getGrantsByRegion`), and `logSearch`. Column names are snake_case in SQL and
  mapped to camelCase `Grant` fields via `rowToGrant` / the named upsert params.
- `src/scrapers/base-scraper.ts` — abstract `BaseScraper`. Provides the shared
  axios client, `fetchPage` (cheerio), `generateId` (md5 of name+org), `createGrant`
  (fills defaults), and Japanese-aware helpers: `detectExpenseEligibility`,
  `detectStatus`, `parseJapaneseDate` (handles 令和/西暦/slash formats), `cleanText`.
- `src/scrapers/*-scraper.ts` — one concrete scraper per source, each extending
  `BaseScraper` and implementing `search(): Promise<Grant[]>`.
- `src/scrapers/known-grants.ts` — hand-curated grants that scraping can't reliably
  capture. Update these manually when grant terms change.
- `src/scrapers/index.ts` — registers scrapers in `getAllScrapers()` and orchestrates.
- `src/reports/report-generator.ts` — Markdown/HTML/console report rendering.
- `src/server.ts` — dependency-free `http` dashboard: `GET /` (control panel),
  `POST /api/search` (run a search), `GET /api/report` (serve newest HTML report).
- `src/scheduler.ts` — `node-cron` in-process scheduler with SIGINT/SIGTERM cleanup.
- `.github/workflows/search.yml` — weekly + manual CI that searches, commits
  `output/`, and deploys to GitHub Pages.

## The `Grant` model

`Grant` (in `src/models/grant.ts`) is the single shared record type. Fields:
`id`, `name`, `organization`, `region`, `targetProjects`, `grantAmount`,
`grantPeriod`, `applicationDeadline`, `personnelCosts`, `honorarium`, `rent`,
`status`, `url`, `source`, `lastUpdated`.

Constrained value types (use these literals, not free strings):

- `Region`: `'全国' | '愛知県' | '長久手市'`
- `Eligibility` (人件費/謝金/家賃): `'可' | '不可' | '要確認' | '不明'`
- `GrantStatus`: `'募集中' | '募集前' | '募集終了' | '不明'`

`id` convention: `` `${source}_${md5(name+organization).slice(0,8)}` `` (via
`BaseScraper.generateId`), or a stable hand-written id like `known_musubie_fund` for
curated entries. Dedup throughout relies on `id`, so keep it deterministic.

If you add or rename a `Grant` field, update **all** of: the interface, the SQLite
schema + `upsertGrant` params + `rowToGrant` in `database.ts`, `createGrant` defaults
in `base-scraper.ts`, and both report renderers.

## Conventions

- **Language:** Japanese for anything a user sees (console logs, report text, HTML,
  dashboard, commit messages in CI). Code identifiers stay English.
- **TypeScript:** strict mode is on (`tsconfig.json`). Target ES2020, CommonJS
  modules, `outDir: dist`, `rootDir: src`. Keep the build clean.
- **Error handling:** scrapers must be resilient — swallow/log per-item and
  per-source failures so a single broken page doesn't fail the whole run (see the
  try/catch patterns in `searchAllSources` and each scraper). Log a `search_log`
  row with the error message on failure.
- **Politeness:** the axios client sends a descriptive `User-Agent`
  (`GrantSearch/1.0 ...`) and a 30s timeout. Preserve considerate scraping; avoid
  hammering source sites.
- **Dependencies** (kept intentionally small): `axios`, `cheerio`, `better-sqlite3`,
  `node-cron`, `dayjs`. The web server uses only the Node `http` module — no Express.

## Adding a new scraper

1. Create `src/scrapers/<source>-scraper.ts` with a class extending `BaseScraper`.
2. Call `super('<source-key>', '<Region>')` and implement
   `async search(): Promise<Grant[]>`, building each result via `this.createGrant(...)`
   and reusing the base helpers (`fetchPage`, `detectStatus`, `parseJapaneseDate`, etc.).
3. Filter by relevance using `SEARCH_KEYWORDS` (see `CanpanScraper.isRelevant`).
4. Register the scraper in `getAllScrapers()` in `src/scrapers/index.ts`.
5. Build and run `npm run search`; confirm the new source appears in the console
   output and reports.

Existing scrapers to model after: `canpan` (nationwide DB), `musubie`, `wam`
(独立行政法人福祉医療機構) — nationwide; `aichi_vc` (愛知県ボランティアセンター) — 愛知県;
`nagakute` — 長久手市.

## Generated / ignored paths

`.gitignore` excludes `node_modules/`, `dist/`, `data/` (the SQLite DB), `output/`,
compiled `*.js.map` / `*.d.ts`, and `.env`.

Note: **`output/` is git-ignored but is force-added by CI** (`git add -f output/`),
so dated report files are intentionally committed by the GitHub Actions workflow.
Don't be surprised to see report files tracked despite the ignore rule. The `pages/`
directory is a build artifact of `generate-pages.ts` and should not be hand-edited.

## CI / deployment

`.github/workflows/search.yml` runs on `workflow_dispatch` (manual, phone-friendly)
and weekly `schedule` (`cron: '0 0 * * 1'` UTC = Mon 09:00 JST). It installs deps,
`npm run build`, runs `node dist/index.js search`, uploads `output/` as an artifact,
commits `output/` back to the repo, then builds `pages/` and deploys to GitHub Pages.
The scheduling in `src/scheduler.ts` (in-process cron) and the CI cron are separate
mechanisms — production scheduling is handled by GitHub Actions.

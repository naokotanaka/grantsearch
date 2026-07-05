# CLAUDE.md

このファイルは、本リポジトリで作業する AI アシスタント（Claude Code など）向けのガイドです。

## プロジェクト概要

**grantsearch**（助成金・補助金 定期検索システム）は、NPO の活動に関連する日本の
助成金・補助金情報を定期的に収集する TypeScript / Node.js 製のツールです。対象分野は
以下のとおりです。

- 子育て支援
- 子ども食堂・フードパントリー
- 外国にルーツを持つ人の支援
- 児童の健全育成・居場所づくり
- 学習支援

対象地域：**全国**、**愛知県**、**長久手市**。

このツールは助成金データをスクレイピングして集約し、SQLite に保存したうえで
Markdown・HTML のレポートを生成します。GitHub Actions のワークフローが毎週検索を実行し、
生成したレポートをコミットして最新版を GitHub Pages に公開します。加えて、スマホから
手動で検索を実行できる簡易 Web ダッシュボードも備えています。

主な利用者は非エンジニアの日本語話者です。そのため、**ユーザーに表示される文字列・
コンソール出力・コメント・レポートはすべて日本語**で書かれています。既存コードを編集する
際もこの方針を維持してください。

## コマンド一覧

すべて `package.json` に定義された npm スクリプト経由で実行します。

| コマンド | 内容 |
|---------|------|
| `npm run build` | TypeScript をコンパイル（`src/` → `dist/`、`tsc`） |
| `npm run dev` | `ts-node` で `src/index.ts` を直接実行（ビルド不要） |
| `npm run search` | 全ソースをスクレイピングし、DB 保存＋レポート生成（`dist/index.js search`） |
| `npm run report` | スクレイピングせず既存 DB データからレポートを再生成 |
| `npm run server` | Web ダッシュボードを起動（デフォルト 3000 番、`PORT` で変更可） |
| `npm run schedule` | プロセス内 cron スケジューラを起動（デフォルト：毎週月曜 9:00） |
| `npm start -- schedule "0 9 * * 1"` | カスタム cron 式でスケジューラ起動 |

`start` / `search` / `report` / `server` / `schedule` スクリプトは `dist/` 内の
コンパイル済み JS を実行するため、事前に `npm run build` が必要です。開発時は
`npm run dev` を推奨します。

CLI のエントリポイント（`src/index.ts`）は `process.argv[2]`
（`search` | `report` | `server` | `schedule` | `help`）で処理を振り分け、
デフォルトは `search` です。

現時点で **テストランナーもリンターも設定されていません**。変更の確認は
`npm run build` と該当コマンドの実行で行ってください。

## アーキテクチャとデータフロー

```
ソース ──► スクレイパー ──► Grant[] ──► SQLite (data/grants.db) ──► レポート (output/)
                              │                                        ├─ *.md
  known-grants.ts (定番カタログ │                                        └─ *.html
   ＋checkerで毎週募集検知)     │                                    generate-pages.ts
  CANPAN / むすびえ / WAM /     │                                        └─ pages/index.html (GitHub Pages)
  愛知県VC / 長久手市 /         │
  しみせん / Google News RSS   ┘
```

1. **`searchAllSources()`**（`src/scrapers/index.ts`）が全体を統括します。
   - まず `checkKnownGrants()`（known-grants-checker）が定番リストの各公式ページを
     フェッチし、今年度の募集告知を検知したエントリを「募集中＋実締切」へ自動昇格させます。
   - `getAllScrapers()` の各スクレイパーを順次実行し、スクレイパーごとに例外を
     捕捉して 1 つの失敗が全体を止めないようにします。**抽出0件は解析不全の
     可能性が高いため警告ログ＋`search_log` に記録**します（沈黙故障の検知）。
   - すべての結果を SQLite に upsert し、`search_log` に 1 行記録します。
   - `Grant.id` で重複除去後、`dedupeAcrossSources()` が**情報源をまたいだ同一助成金**
     （正規化名の包含・13文字以上の共通部分）を畳み、情報の充実した方を残します。
   - `EXCLUDE_KEYWORDS`（被災・災害・復興など、当団体の分野外）に該当するものを除外し、
     最後に **`enrichGrants()`（`src/enrich/ai-enricher.ts`）** が各助成金の公式ページを
     読んで詳細情報を充填します（下記「AIエンリッチメント」参照）。
2. **`generateAllReports(grants?)`**（`src/reports/report-generator.ts`）は
   Markdown・HTML（`grants-report-YYYY-MM-DD.{md,html}`）・コンソール要約を
   **状態別の4部構成**で出力します：
   - 🟢 **今募集中**（締切昇順）／🟡 **募集予定・例年この時期**（次に来る月順、
     昨年実績を表示）／🔎 **新着・発見**（News発掘、新しい順）／⚪ **要確認**。
   - `募集終了` は表示しません。`grants` を省略すると DB から全件を読み込むため、
     `npm run report` は再スクレイピングなしで動作します。
3. **`generate-pages.ts`** は単独スクリプトです（`index.ts` からは import されず、
   `node dist/generate-pages.js` として実行）。`output/` を新しい `pages/` ディレクトリへ
   コピーし、最新の HTML レポートを `pages/index.html` にして GitHub Pages 用に整えます。

### 主要ファイル

- `src/index.ts` — CLI エントリポイント／コマンド振り分け。
- `src/models/grant.ts` — 中核となる `Grant` インターフェース、`Region`・
  `Eligibility`・`GrantStatus` 型、`SEARCH_KEYWORDS` / `TARGET_FIELDS` 定数。
  **データ構造を変更するときはまずここを見てください。**
- `src/models/database.ts` — `better-sqlite3` のアクセス層。スキーマ初期化、
  `upsertGrant(s)`、クエリ補助関数（`getAllGrants`・`getActiveGrants`・
  `getGrantsByRegion`）、`logSearch`。SQL の列名は snake_case で、`rowToGrant` と
  名前付き upsert パラメータを介して camelCase の `Grant` フィールドに対応づけます。
- `src/scrapers/base-scraper.ts` — 抽象クラス `BaseScraper`。共有の axios クライアント、
  `fetchPage`（cheerio）、`generateId`（name+org の md5）、`createGrant`（デフォルト値の補完）、
  および日本語対応の補助関数（`detectExpenseEligibility`、`detectStatus`、
  `parseJapaneseDate`：令和／西暦／スラッシュ形式に対応、`cleanText`）を提供します。
- `src/scrapers/*-scraper.ts` — ソースごとの具象スクレイパー。`BaseScraper` を継承し
  `search(): Promise<Grant[]>` を実装します。
- `src/scrapers/known-grants.ts` — 毎年恒例の定番助成金カタログ（status `募集前`＋
  `expectedPeriod` の例年時期）。募集要項が変わったら手動で更新します。
- `src/scrapers/known-grants-checker.ts` — 定番リストの各公式ページを毎週フェッチし、
  「締切/募集期間」語の近くの未来日付を検知したら `募集中` に自動昇格させます。
- `src/scrapers/news-discovery-scraper.ts` — Google News RSS 横断検索によるマイナー
  助成金の発掘（60日以内・上限20件、レポートの🔎セクションに掲載）。
- `src/scrapers/shimisen-scraper.ts` — しみせん（京都市市民活動総合センター）の助成
  情報まとめ。京都限定は除外し全国応募可のものを採用。
- `src/scrapers/index.ts` — `getAllScrapers()` でスクレイパーを登録し、全体を統括。
  `dedupeAcrossSources()`（情報源をまたぐ重複の畳み込み）もここにあります。
- `src/enrich/ai-enricher.ts` — 公式ページ読み取りによる詳細情報の充填
  （AIエンリッチメント）。下記の専用セクション参照。
- `src/reports/report-generator.ts` — Markdown / HTML / コンソールのレポート描画。
- `src/server.ts` — 依存ライブラリ不要の `http` ダッシュボード。`GET /`（操作パネル）、
  `POST /api/search`（検索実行）、`GET /api/report`（最新 HTML レポート配信）。
- `src/scheduler.ts` — `node-cron` によるプロセス内スケジューラ。SIGINT/SIGTERM の
  クリーンアップ付き。
- `.github/workflows/search.yml` — 毎週＋手動実行の CI。検索し、`output/` をコミットして
  GitHub Pages にデプロイします。

## `Grant` モデル

`Grant`（`src/models/grant.ts`）は全体で共有される唯一のレコード型です。フィールド：
`id`、`name`、`organization`、`region`、`targetProjects`、`grantAmount`、
`grantPeriod`、`applicationDeadline`、`expectedPeriod`、`personnelCosts`、
`honorarium`、`rent`、`status`、`url`、`source`、`lastUpdated`。

`expectedPeriod` は「例年の募集時期」（例:「例年6〜7月頃（昨年実績: 2025/6/1〜7/9）」）で、
`募集前`（＝🟡募集予定）のときにレポートへ表示されます。

値が制限された型（自由文字列ではなく、以下のリテラルを使うこと）：

- `Region`：`'全国' | '愛知県' | '長久手市'`
- `Eligibility`（人件費／謝金／家賃）：`'可' | '不可' | '要確認' | '不明'`
- `GrantStatus`：`'募集中' | '募集前' | '募集終了' | '不明'`
  - `募集中`＝締切確認済みで今応募できる／`募集前`＝昨年度実績あり・新年度未発表
    （例年時期を表示）／`募集終了`＝レポート非表示／`不明`＝要確認として表示

`id` の規則：`` `${source}_${md5(name+organization).slice(0,8)}` ``
（`BaseScraper.generateId` による）。手動登録では `known_musubie_fund` のような安定した
手書き id を使います。全体の重複除去が `id` に依存しているため、決定的な値を保ってください。

`Grant` のフィールドを追加・改名する場合は、**以下すべて**を更新してください：
インターフェース、`database.ts` の SQLite スキーマ＋`upsertGrant` パラメータ＋`rowToGrant`、
`base-scraper.ts` の `createGrant` デフォルト値、両方のレポート描画処理。

## AIエンリッチメント（公式ページ読み取り）

`src/enrich/ai-enricher.ts` の `enrichGrants()` は、収集・重複除去後の各助成金の
公式ページ本文を取得し、Claude（構造化出力）で以下を抽出して `Grant` に反映します：

- **応募可否**（対象団体・対象地域・活動分野で判断）——「対象外」と判断されたものは
  **レポートに掲載しない**（他県市限定、被災地・災害支援限定、分野が明らかに無関係）
- 対象団体、助成額、期間、締切、人件費／謝金／家賃の可否、一言要約

動作の要点：

- **APIキー**：環境変数 `ANTHROPIC_API_KEY`（CI では GitHub Secrets 経由で
  `search.yml` が注入）。**未設定でも壊れず**、ルールベースの簡易抽出
  （正規表現）にフォールバックします。
- **モデル**：既定 `claude-haiku-4-5`（低コスト）。環境変数 `CLAUDE_MODEL` で上書き可。
- **安全弁**：1回の実行で読むページは最大150件（`MAX_PAGES`）、本文は8,000字まで。
  ページ取得失敗・AI呼び出し失敗時はその助成金を**そのまま掲載**します（消さない）。
- **上書きしない**：スクレイパーが既に良い値を持つ項目（`要確認`/`不明` 以外）は
  AI の抽出結果で上書きしません。
- 当団体のプロフィール（`NPO_PROFILE`）と判断ルールは同ファイルの
  `SYSTEM_PROMPT` にあります。応募可否の方針を変える場合はここを編集してください。

## 規約

- **言語：** ユーザーが目にするもの（コンソールログ、レポート文言、HTML、ダッシュボード、
  CI のコミットメッセージ）はすべて日本語。コード上の識別子は英語のまま。
- **TypeScript：** strict モード有効（`tsconfig.json`）。ターゲット ES2020、CommonJS、
  `outDir: dist`、`rootDir: src`。ビルドを常にクリーンに保つこと。
- **エラー処理：** スクレイパーは堅牢であること。要素単位・ソース単位の失敗を握りつぶす／
  ログに残すことで、1 つの壊れたページが全体を失敗させないようにします
  （`searchAllSources` と各スクレイパーの try/catch を参照）。失敗時は
  `search_log` にエラーメッセージ付きの行を記録します。
- **礼儀正しいスクレイピング：** axios クライアントは説明的な `User-Agent`
  （`GrantSearch/1.0 ...`）と 30 秒のタイムアウトを送ります。ソースサイトへ過度な負荷を
  かけないよう配慮を維持してください。
- **依存関係**（意図的に最小限）：`axios`、`cheerio`、`better-sqlite3`、`node-cron`、
  `dayjs`、`@anthropic-ai/sdk`（AIエンリッチメント用）。Web サーバは Node の
  `http` モジュールのみを使用（Express なし）。

## 新しいスクレイパーの追加手順

1. `src/scrapers/<source>-scraper.ts` を作成し、`BaseScraper` を継承するクラスを定義します。
2. `super('<source-key>', '<Region>')` を呼び出し、`async search(): Promise<Grant[]>` を
   実装します。各結果は `this.createGrant(...)` で生成し、基底クラスの補助関数
   （`fetchPage`、`detectStatus`、`parseJapaneseDate` など）を再利用します。
3. `SEARCH_KEYWORDS` を使って関連性で絞り込みます（`CanpanScraper.isRelevant` を参照）。
4. `src/scrapers/index.ts` の `getAllScrapers()` にスクレイパーを登録します。
5. ビルドして `npm run search` を実行し、新しいソースがコンソール出力とレポートに
   現れることを確認します。

**重要：解析ロジックは必ず実ページのHTMLで検証してから登録すること。**
この環境から対象サイトへ直接アクセスできない場合は、デバッグ用ブランチに
「push で起動し curl でページを取得して debug/ にコミットする一時ワークフロー」を
作って実HTMLを入手し、コンパイル済みコードをそのHTMLに対して実行して件数・内容を
確認します（過去に当て推量のセレクタで3ソースが沈黙0件になっていた教訓）。
抽出0件時は警告ログを出す実装にしてください。

参考にできる既存スクレイパー：`canpan`（全国 DB・一覧全ページ取得＋関連絞り込み）、
`musubie`（.row-news 記事解析）、`wam`（募集情報アーカイブ→最新年度の詳細を判定）、
`aichi_vc`（アーカイブをグループ化し募集中/募集前を判定）＝愛知県、
`nagakute`＝長久手市、`shimisen`（まとめサイト・地域限定除外）、
`news`（Google News RSS 発掘）。

## 生成物・無視されるパス

`.gitignore` は `node_modules/`、`dist/`、`data/`（SQLite DB）、`output/`、
コンパイル済みの `*.js.map` / `*.d.ts`、`.env` を除外します。

注意：**`output/` は git 管理から除外されているが、CI が強制追加します**
（`git add -f output/`）。そのため日付付きレポートは GitHub Actions ワークフローによって
意図的にコミットされます。ignore ルールがあってもレポートが追跡されているのは正常です。
`pages/` ディレクトリは `generate-pages.ts` の生成物であり、手動編集しないでください。

## CI / デプロイ

`.github/workflows/search.yml` は `workflow_dispatch`（手動、スマホから実行可能）と
毎週の `schedule`（`cron: '0 0 * * 1'` UTC ＝ 月曜 9:00 JST）で動作します。依存関係を
インストールし、`npm run build`、`node dist/index.js search` を実行、`output/` を
アーティファクトとしてアップロードしたうえでリポジトリにコミットし、`pages/` を構築して
GitHub Pages にデプロイします。`src/scheduler.ts`（プロセス内 cron）と CI の cron は別々の
仕組みで、本番のスケジューリングは GitHub Actions が担います。

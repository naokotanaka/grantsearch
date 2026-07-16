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
Markdown・HTML のレポートを生成します。本番は社内サーバー（192.168.0.25）で
pm2 常駐し、`https://nagaiku.top/grantsearch/` で公開しています（共通ログイン
gate で保護）。常駐プロセスが週次自動検索（毎週月曜 9:00 JST）と、スマホから
手動で検索を実行できる簡易 Web ダッシュボードの両方を担います。
詳細は `docs/2026-07-11-nagaiku-top-deploy-design.md` を参照。

主な利用者は非エンジニアの日本語話者です。そのため、**ユーザーに表示される文字列・
コンソール出力・コメント・レポートはすべて日本語**で書かれています。既存コードを編集する
際もこの方針を維持してください。

## コマンド一覧

すべて `package.json` に定義された npm スクリプト経由で実行します。

| コマンド                            | 内容                                                                        |
| ----------------------------------- | --------------------------------------------------------------------------- |
| `npm run build`                     | TypeScript をコンパイル（`src/` → `dist/`、`tsc`）                          |
| `npm run dev`                       | `ts-node` で `src/index.ts` を直接実行（ビルド不要）                        |
| `npm run search`                    | 全ソースをスクレイピングし、DB 保存＋レポート生成（`dist/index.js search`） |
| `npm run report`                    | スクレイピングせず既存 DB データからレポートを再生成                        |
| `npm run server`                    | Web ダッシュボード＋週次スケジューラを起動（`PORT`・`HOST` で変更可）       |
| `npm run schedule`                  | プロセス内 cron スケジューラを起動（デフォルト：毎週月曜 9:00）             |
| `npm start -- schedule "0 9 * * 1"` | カスタム cron 式でスケジューラ起動                                          |

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
     **`enrichGrants()`（`src/enrich/ai-enricher.ts`）** が各助成金の公式ページ＋
     リンクされた募集要項PDF（最大2件）を読んで詳細情報を充填します
     （下記「AIエンリッチメント」参照）。
   - **最後に、確定した最終リストをDBへ再upsertし、リストに入らなかった行を
     `hidden=1` にします。DBが正本**で、レポートは常にDB（`hidden=0`）から生成されます。
2. **`generateAllReports()`**（`src/reports/report-generator.ts`）は
   DB（`getVisibleGrants`）から読んで Markdown・HTML
   （`grants-report-YYYY-MM-DD.{md,html}`）・コンソール要約を
   **状態別の4部構成**で出力します：
   - 🟢 **今募集中**（締切昇順）／🟡 **募集予定・例年この時期**（次に来る月順、
     12ヶ月の帯で募集月・助成期間・今月を表示）／🔎 **新着・発見**（News発掘＋
     採択報告からの発掘、新しい順）／⚪ **要確認**。
   - `募集終了` と `hidden=1` は表示しません。DBから読むため
     `npm run report` は再スクレイピングなしで動作し、メモ保存後の再生成も同一経路です。
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
- `src/scrapers/news-discovery-scraper.ts` — Web横断検索によるマイナー助成金の発掘
  （レポートの🔎セクションに掲載）。Google News RSS（募集告知60日以内・上限20件＋
  採択報告）と DuckDuckGo検索（キー不要。ブログ・団体サイトの「〇〇助成で開催しました」
  という活動報告から助成金名をAI抽出）の2系統。
- `src/scrapers/shimisen-scraper.ts` — しみせん（京都市市民活動総合センター）の助成
  情報まとめ。京都限定は除外し全国応募可のものを採用。
- `src/scrapers/index.ts` — `getAllScrapers()` でスクレイパーを登録し、全体を統括。
  `dedupeAcrossSources()`（情報源をまたぐ重複の畳み込み）もここにあります。
- `src/enrich/ai-enricher.ts` — 公式ページ読み取りによる詳細情報の充填
  （AIエンリッチメント）。下記の専用セクション参照。
- `src/reports/report-generator.ts` — Markdown / HTML / コンソールのレポート描画。
- `src/search-runner.ts` — 検索実行の一元管理（実行中フラグ＋最終結果）。手動
  （ダッシュボード）と自動（週次）の同時実行を防ぎます。検索を起動する処理は
  必ずここを通してください。
- `src/server.ts` — 依存ライブラリ不要の `http` ダッシュボード。`GET /`（操作パネル）、
  `POST /api/search`（検索をバックグラウンド開始、即応答）、`GET /api/status`
  （実行状態。フロントが5秒間隔でポーリング）、`GET /api/report`（最新 HTML レポート配信）、
  `POST /api/memo`（メモ保存→レポート再生成）、`POST /api/manual-url`
  （募集要項URL登録→その場でAI読み取り→レポート再生成。レポートHTML内の✏/📎ボタンから呼ばれる）。
  HTML 内の URL は**相対パス**（nginx が `/grantsearch/` を除去して転送するため。
  絶対パス `/api/...` に戻すと本番で壊れます）。既定バインドは `127.0.0.1`
  （gate 素通り防止。`HOST` で変更可）。
- `src/scheduler.ts` — `node-cron` によるプロセス内スケジューラ（`Asia/Tokyo` 固定）。
  SIGINT/SIGTERM のクリーンアップ付き。`server` コマンドでも同時起動されます。

## `Grant` モデル

`Grant`（`src/models/grant.ts`）は全体で共有される唯一のレコード型です。フィールド：
`id`、`name`、`organization`、`region`、`targetProjects`、`grantAmount`、
`grantPeriod`、`applicationDeadline`、`expectedPeriod`、`personnelCosts`、
`honorarium`、`rent`、`benefitType`、`status`、`url`、`source`、`lastUpdated`、
`memo`、`manualUrl`。

**`memo`（人間のメモ）と `manualUrl`（人間が登録した募集要項URL）は人間の入力**です。
`upsertGrant` の ON CONFLICT 更新対象から意図的に外してあり、再検索・AI読み取りで
消えません。システム側のコードでこの2つを書き換えないこと（専用の `updateMemo` /
`updateManualUrl` だけが書き換える）。

`expectedPeriod` は「例年の募集時期」（例:「例年6〜7月頃（昨年実績: 2025/6/1〜7/9）」）で、
`募集前`（＝🟡募集予定）のときにレポートへ表示されます。

値が制限された型（自由文字列ではなく、以下のリテラルを使うこと）：

- `Region`：`'全国' | '愛知県' | '長久手市'`
- `Eligibility`（人件費／謝金／家賃）：`'可' | '不可' | '要確認' | '不明'`
- `BenefitType`（種別）：`'資金' | '物品' | '資金＋物品' | 'その他' | '不明'`
  - 資金以外はレポートの助成額欄にバッジ（【物品】等）が付く
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

- **APIキー**：環境変数 `ANTHROPIC_API_KEY`（本番はサーバーの `.env` に設定）。
  **未設定でも壊れず**、ルールベースの簡易抽出（正規表現）にフォールバックします。
- **モデル**：既定 `claude-haiku-4-5`（低コスト）。環境変数 `CLAUDE_MODEL` で上書き可。
- **安全弁**：1回の実行で読むページは最大150件（`MAX_PAGES`）、本文は8,000字まで。
  ページ取得失敗・AI呼び出し失敗時はその助成金を**そのまま掲載**します（消さない）。
- **上書きしない**：スクレイパーが既に良い値を持つ項目（`要確認`/`不明` 以外）は
  AI の抽出結果で上書きしません。
- 当団体のプロフィール（`NPO_PROFILE`）と判断ルールは同ファイルの
  `SYSTEM_PROMPT` にあります。応募可否の方針を変える場合はここを編集してください。

## 規約

- **言語：** ユーザーが目にするもの（コンソールログ、レポート文言、HTML、ダッシュボード、
  コミットメッセージ）はすべて日本語。コード上の識別子は英語のまま。
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
  `dayjs`、`@anthropic-ai/sdk`（AIエンリッチメント用）、`pdf-parse`（募集要項PDFの
  テキスト抽出用）。Web サーバは Node の `http` モジュールのみを使用（Express なし）。

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

注意：リポジトリには GitHub Actions 時代にコミットされた古い `output/` レポートが
履歴として残っていますが、現在レポートはサーバー上でのみ生成・保持され、コミット
しません。`pages/` と `generate-pages.ts` は GitHub Pages 時代の遺物です。

## デプロイ（本番 = 社内サーバー）

本番は社内サーバー `192.168.0.25`（`ssh tanaka@192.168.0.25`）です。

- 公開URL: `https://nagaiku.top/grantsearch/`（LAN内: `http://192.168.0.25/grantsearch/`）。
  nginx が `/grantsearch/` プレフィックスを除去してアプリへプロキシし、共通ログイン
  gate（`auth_request /internal/gate-verify`）で保護します。
- 常駐: pm2 プロセス `grantsearch` 1個（`node --env-file=.env dist/index.js server`）。
  **cwd はリポジトリ直下必須**（`data/`・`output/` が `process.cwd()` 基準のため）。
- 環境変数: サーバーのリポジトリ直下 `.env` に `PORT`・`HOST`・`ANTHROPIC_API_KEY`。
- 週次自動検索はこの常駐プロセス内の node-cron（毎週月曜 9:00 JST）が実行します。
  GitHub Actions による定期実行・GitHub Pages 公開は 2026-07 に廃止しました。
- 反映手順: サーバー上で `git pull` → `npm install`（依存が変わったときのみ）→
  `npm run build` → `pm2 restart grantsearch`。

設計の経緯は `docs/2026-07-11-nagaiku-top-deploy-design.md` を参照。

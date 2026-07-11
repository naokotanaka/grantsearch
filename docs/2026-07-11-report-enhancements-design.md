# grantsearch レポート強化：PDF読み取り・メモ欄・12ヶ月帯・種別表示

## Context

nagaiku.top/grantsearch のレポートに対するユーザーフィードバック対応：

1. **「不明」が多すぎる** — 募集要項がPDFにしかないサイトが多く、現在はPDFを読まずスキップしている（`ai-enricher.ts:169` でPDF URL除外、`fetchPageText` はHTML専用）
2. **人間が調べて分かったことを書き残したい** — 再検索しても消えないメモ欄。入力は「レポートの行で直接（✏ボタン）」と決定済み
3. **募集予定セクションの時期を視覚的に** — 「12ヶ月の帯（募集月を色塗り・今月に縦線・助成期間は別色）」と決定済み
4. **資金でない助成は「物品」などと種別表示** — AIに種別を判定させてバッジ表示
5. **採択報告からの発掘** — 他団体のブログ・お知らせの「〇〇助成に採択されました」という記事から助成金名を取得し、未知の助成金の手がかりにする
6. **募集要項URLの手動登録→AI再読み取り** — 自動でPDF等を見つけられなかった助成金に、人間が募集要項のURLを登録すると、AIがそれを読んで詳細（締切・経費可否等）をその場で埋め直す

## 前提となる構造変更：DBを正本にする

調査で判明した現状：`searchAllSources()`（scrapers/index.ts）は**enrich前の生データをupsert**し、enrich済み結果は戻り値のみ→レポートへ直接渡る。DBには重複・対象外・未enrichデータが残る。

このままではメモ保存時にレポートを再生成できない（DBから作ると劣化する）ため：

- enrich後の最終リストを**DBに再upsert**する
- `hidden INTEGER DEFAULT 0` カラムを追加し、最終リストに**入らなかった行は hidden=1**（重複・AI対象外・今回見つからなかった古い行）。upsert時は hidden=0 に戻す
- レポートは常に **DB（hidden=0）から生成**（検索直後・メモ保存後・`npm run report` すべて同一経路になる）
- 検索完了メッセージの件数は従来どおり戻り値の件数を使う

## 変更ファイル

### 1. `src/models/grant.ts`

- `Grant` に `memo: string`（人間のメモ・システムは上書きしない）と `benefitType: BenefitType` を追加
- `export type BenefitType = "資金" | "物品" | "資金＋物品" | "その他" | "不明"`
- `manualUrl: string` も追加（人間が登録した募集要項URL。デフォルト `""`・システムは上書きしない）

### 2. `src/models/database.ts`

- CREATE TABLE に `memo TEXT NOT NULL DEFAULT ''`・`manual_url TEXT NOT NULL DEFAULT ''`・`benefit_type TEXT NOT NULL DEFAULT '不明'`・`hidden INTEGER NOT NULL DEFAULT 0` を追加＋既存の try/catch ALTER TABLE マイグレーションパターン（53-60行の流儀）で4本追加
- `upsertGrant`: INSERT には全カラムを含めるが、**ON CONFLICT の UPDATE SET に memo / manual_url を含めない**（人間の入力は再検索で消えない）。benefit_type は更新、hidden は 0 に戻す
- `rowToGrant` に memo / manualUrl / benefitType を追加
- 新規エクスポート: `updateMemo(db, id, memo)`、`updateManualUrl(db, id, url)`、`updateGrantDetails(db, grant)`（AI再読み取り結果の反映用・memo/manual_url以外を更新）、`hideGrantsNotIn(db, ids: string[])`（`UPDATE grants SET hidden=1 WHERE id NOT IN (...)`。ids は数百件想定なのでプレースホルダ展開でよい）、`getVisibleGrants(db)`（`WHERE hidden = 0`）

### 3. `src/scrapers/base-scraper.ts`

- `createGrant` のデフォルトに `memo: ""`、`benefitType: "不明"` を追加（CLAUDE.mdのフィールド追加ルールに従う）

### 4. `src/enrich/ai-enricher.ts` — PDF読み取り＋種別判定

- **依存追加**: `pdf-parse`（+ devDep `@types/pdf-parse`）
- `isEnrichable`: PDF除外（169行）を削除し、PDF URLも対象にする
- `fetchPageText` を `fetchSourceText` に発展させる：
  - URL が `.pdf` → バッファ取得（10MB上限・responseType: arraybuffer）→ pdf-parse でテキスト抽出
  - HTML → 本文抽出（従来どおり）＋ ページ内の `<a>` から **募集要項らしいPDFリンクを最大2件**拾って読む。優先順位: アンカーテキストか href が `募集要項|実施要領|応募要領|申請要領|要項|要領|募集案内` にマッチ → 次に単なる `.pdf` リンク。相対URLは `new URL(href, pageUrl)` で解決
  - 予算配分: ページ本文 6,000字＋PDF 各3,000字（合計 `MAX_TEXT_LENGTH`=12,000字）。PDFは `【添付PDF: ファイル名】` の見出し付きで連結
  - PDF取得・解析の失敗は握りつぶしてページ本文のみで続行（既存のエラー方針を踏襲）
- `EXTRACTION_SCHEMA` / `ExtractionResult` に `benefitType`（enum: 資金/物品/資金＋物品/その他/不明）を追加。SYSTEM_PROMPT に判定ルールを追記
- `grantAmount` の指示を変更：「物品：」prefix をやめ、内容だけ書かせる（例:「フルーツ5〜7万円相当」）。物品かどうかは benefitType が担い、表示はレポート側のバッジで行う（二重表示を避ける）
- `applyExtraction`: `benefitType` は現在値が「不明」のときだけ採用。**memo / manualUrl には一切触らない**
- **手動URL対応**: `enrichGrants` のループで `grant.manualUrl` があれば `grant.url` の代わりにそれを読む。さらに**単発再読み取り用に `enrichSingleGrant(grant): Promise<Grant>` をエクスポート**（fetchSourceText → extractWithAI → applyExtraction の1件版。/api/manual-url から使う）
- **人間が登録した助成金は「対象外」で消さない**: manualUrl 付きの場合、AIが「対象外」と判定しても除外せず「要確認」扱いにする（人間が関係あると判断して登録したものをAIが黙って消さない）

### 5. `src/scrapers/index.ts`

- `searchAllSources()` の末尾（enrich後）: DBを開き直し `upsertGrants(db, result)` → `hideGrantsNotIn(db, result.map(g => g.id))` → close

### 6. `src/reports/report-generator.ts`

- `generateAllReports()`: `getAllGrants` → `getVisibleGrants` に変更。**呼び出し側（index.ts / search-runner.ts）は引数なしで呼ぶ**よう変更（DB正本化）
- **メモ列**を4セクション全テーブルに追加（Markdown・HTML両方。escapeHtml必須）
  - HTML: `<td class="memo-cell" data-id="..."><span>メモ本文</span> <button class="memo-btn">✏</button> <button class="url-btn">📎</button></td>`
  - HTMLテンプレートに小さな `<script>` を追加：
    - ✏ → `prompt("メモ", 現在値)` → `fetch("memo", {method:"POST", ...})` → 成功したらセルのテキストを差し替え
    - 📎 → `prompt("募集要項のURL（PDF可）")` → `fetch("manual-url", ...)` → 「AIが読み取り中…」表示 → 完了レスポンスで `location.reload()`（埋まった行を見せる）
    - **相対パス `"memo"` / `"manual-url"` を使う**（レポートURLが `.../api/report` なので `.../api/memo` 等に解決される。ダッシュボードと同じ相対パス原則）
- **種別バッジ**: `benefitType` が 物品/資金＋物品/その他 のとき、助成額セルの先頭に `<span class="type-badge">物品</span>` 等を表示（Markdownは `【物品】` prefix）
- **12ヶ月の帯**（upcoming セクションのみ・HTML）:
  - `parseMonths(text): Set<number>` ヘルパー — `例年X月〜Y月頃`（12月〜1月の年またぎ対応）・`例年X月頃`・`春=3-5/夏=6-8/秋=9-11/冬=12-2` の季節語・複数記述（`4月頃 / 10月頃`）を拾う。既存の `monthsAway`（53-57行）の正規表現を包含する形で実装し、monthsAway もこれを使うよう揃える
  - 募集時期: `expectedPeriod` の「（昨年実績:」より前の部分から解析。助成期間: `grantPeriod` が `X月1日〜翌年Y月31日` 型のときだけ解析（「1年間」「当該年度」は帯なし）
  - 描画: 「例年の募集時期」列の中にテキストの上へ `<div class="month-strip">`（12個の `<span class="m">`、募集月= `.m-recruit`（黄）、助成期間= `.m-period`（下側の細帯・緑）、今月= `.m-now`（縦線））。CSSは既存 `<style>`（285-314行）に追加。月が1つも取れない行は帯を出さずテキストのみ
  - Markdown版は変更しない（テキストのまま）

### 6.5 `src/scrapers/news-discovery-scraper.ts` — 採択報告からの発掘

- 既存の Google News RSS 検索クエリ群に**採択報告向けクエリ**を追加：`"採択されました" 助成`、`"採択" 助成金 子ども食堂`、`"助成が決定" NPO` など（既存の分野キーワードと組み合わせ）
- ヒットした記事のタイトルは「〇〇（団体名）が△△助成に採択」形式が多く、**記事タイトル≠助成金名**。そこで拾った記事タイトル群をまとめて1回のAI呼び出し（ai-enricher と同じクライアント・構造化出力）に渡し、`{ 助成金名, 助成元 }` を抽出する。抽出できないタイトルはスキップ
  - AIキー未設定時は「〜助成」「〜基金」「〜プログラム」を含む部分を正規表現で切り出すフォールバック（精度は低くてよい）
- 抽出した助成金は `createGrant` で `source: "news"`・`status: "不明"`・`targetProjects: "採択報告から発見（記事: タイトル）"` として登録 → 既存の 🔎新着・発見 セクションに載る
- 既に追跡済みの助成金は `dedupeAcrossSources`（正規化名の包含判定）が畳んでくれるので、新規のものだけが残る
- 件数上限: 採択報告由来は1回の検索で最大10件（既存の news 上限20件とは別枠）

### 7. `src/server.ts`

- ボディ読み取りヘルパー `readJsonBody(req, 上限10KB)` を新設（現状ボディ解析処理が無いため）
- `POST /api/memo` を追加：`{id, memo}` を検証（id がDBに存在・memo は文字列・500字で切る）→ `updateMemo` → `generateAllReports()` で output/ を再生成 → `{status:"ok"}`。不正なら 400
- `POST /api/manual-url` を追加：`{id, url}` を検証（http(s) URLのみ）→ `updateManualUrl` → **その場で `enrichSingleGrant` を実行**（そのURLをAIが読んで締切・経費可否等を抽出）→ `updateGrantDetails` でDB反映 → `generateAllReports()` → `{status:"ok", message:"読み取り完了"}` を返す（AI読み取り込みで10〜20秒程度の同期処理。nginxの既定タイムアウト60秒内に収まる想定）。AIキー未設定時はURL保存だけ行い、次回の週次検索で読む旨を返す
- gate 配下なので認証は nginx 任せ（既存方針どおり）

### 8. `src/index.ts` / `src/search-runner.ts`

- `generateAllReports(grants)` → `generateAllReports()`（引数なし・DB正本）に変更。完了メッセージの件数は `searchAllSources()` の戻り値を使う（従来どおり）

## 実装順序

1. モデル＋DB（grant.ts → database.ts → base-scraper.ts）→ ビルド確認
2. DB正本化（scrapers/index.ts → report-generator の getVisibleGrants → index.ts / search-runner.ts）
3. AIエンリッチメント（pdf-parse導入 → fetchSourceText → benefitType）
4. 採択報告からの発掘（news-discovery-scraper 拡張）
5. レポート表示（メモ列＋バッジ＋12ヶ月帯＋メモ編集script）
6. サーバー（/api/memo）

## 検証

1. `npm run build` が通る
2. ローカルで `npm run server` 起動 → `curl -X POST /api/memo`（存在しないid→400、正しいid→ok）
3. サーバーへデプロイ（git pull → npm install → build → pm2 restart）して再検索を実行し、新レポートで確認：
   - PDF読み取りで人件費/謝金/家賃の「不明」が減っている（前回: ほぼ全行不明）
   - 物品系の行（おむすび・フルーツ等）にバッジが出る
   - 募集予定セクションに12ヶ月帯が出て、今月線・募集月が正しい（例: `例年12月〜1月頃` → 12・1月が塗られる）
4. レポート画面で✏からメモを保存 → 表示に反映 → **もう一度検索を実行してもメモが残っている**（最重要）
5. `npm run report`（DBから再生成）が検索直後と同じ内容になる（重複・対象外が復活しない）
6. 🔎新着・発見セクションに「採択報告から発見」の行が出る（出なければ検索ログで採択クエリのヒット数を確認。時期によっては0件もあり得る）
7. 「不明」だらけの行に 📎 で募集要項PDFのURLを登録 → 10〜20秒後に締切・経費可否が埋まる → 再検索してもURLとメモが残っている

## 注意点

- 検索実行時間は PDF 取得のぶん伸びる（+数分想定）。MAX_PAGES=150 とPDF上限2件/ページで暴走は抑制
- AIコスト: 1回の入力が最大8,000→12,000字に増えるが Haiku なので月数百円規模のまま
- dedupeAcrossSources で残る側の id が回によって入れ替わると、メモが別 id に付いたまま非表示になる可能性がある（既知の限界として許容。メモは消えず、同じ側が再び勝てば再表示される）

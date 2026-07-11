# nagaiku.top/grantsearch 公開 設計書（2026-07-11）

## 目的

GitHub Actions + GitHub Pages で運用していた助成金検索システムを、
社内サーバー（192.168.0.25）へ全面移行し、`https://nagaiku.top/grantsearch/`
（LAN内: `http://192.168.0.25/grantsearch/`）でスタッフが使えるようにする。

## 役割分担の変更

| 項目             | 旧                                  | 新                                                   |
| ---------------- | ----------------------------------- | ---------------------------------------------------- |
| 週次自動検索     | GitHub Actions（毎週月曜 9:00 JST） | サーバーのプロセス内 cron（同時刻、Asia/Tokyo 指定） |
| 手動検索         | GitHub Actions の Run workflow      | ダッシュボードの「検索を実行」ボタン                 |
| レポート公開     | GitHub Pages                        | サーバーの `GET api/report`                          |
| データ（SQLite） | Actions 実行環境（毎回使い捨て）    | サーバーの `data/grants.db` に蓄積                   |
| コード置き場     | GitHub リポジトリ                   | 変わらず（サーバーへは git pull で反映）             |

GitHub Actions のワークフローは削除する。GitHub Pages は古いレポートが
残り続けると誤解のもとになるため、公開を無効化する。

## アクセス制限

既存の共通ログイン **gate**（127.0.0.1:9000 の認証サービス + nginx `auth_request`）に相乗りする。

- nginx の `location /grantsearch/` に `auth_request /internal/gate-verify;` と
  `error_page 401 = @gate_login;` を付ける（schedule / budget3 / naga-anchor と同じ形）
- アプリ側に認証コードは持たない
- スタッフは他アプリでログイン済みならそのまま使える

## パス対応（/grantsearch/ 配下で動かす）

方式: **相対パス化 + nginx でプレフィックス除去**。

- ダッシュボード HTML 内の URL を相対パスにする（`/api/report` → `api/report` など）
- nginx が `/grantsearch/` を除去してアプリの `/` に転送する
- 末尾スラッシュなしの `/grantsearch` は `/grantsearch/` へリダイレクトする
  （nginx に 1 行追加。忘れると共有リンクで 404 になる）

## 検索実行の非同期化（設計変更・dev-council 反映）

同期 POST で数分待つ現行設計は、nginx `proxy_read_timeout`（既定 60 秒）と
Cloudflare（約 100 秒）のタイムアウトに必ず引っかかる。また、スマホで
画面を閉じると結果が受け取れない。よって以下に変更する。

- `POST api/search` — 実行中でなければ検索をバックグラウンドで開始し、
  **即座に** `{ status: 'started' }` を返す。実行中なら `{ status: 'running' }`
- `GET api/status` — `{ running, startedAt, last: { finishedAt, status, message, count } }` を返す
- フロントは開始後 5 秒おきに `api/status` をポーリングして結果を表示する
- 実行状態はプロセス内メモリのフラグ 1 個で管理する（`src/search-runner.ts` に集約）。
  ジョブキュー等は導入しない（最小実装）
- 週次スケジューラも同じ `search-runner` を通すため、手動と自動の同時実行は起きない

## プロセス構成

pm2 のプロセス 1 個。`server` コマンドが Web サーバーと週次スケジューラの
両方を起動する（`npm run schedule` 単独起動も残す）。

- バインドは `127.0.0.1`（環境変数 `HOST` で変更可）。
  `0.0.0.0` のままだと LAN 内から gate を素通りして直接アクセスできてしまうため
- `Access-Control-Allow-Origin: *` は削除する（nginx 配下では同一オリジン）
- cron は `Asia/Tokyo` を明示する（サーバーのタイムゾーン設定に依存させない）

## サーバー構成

- 配置: 他アプリと同じ流儀で `git clone`（場所はサーバーの既存配置に合わせる）
- ポート: **6100**（空き確認済み。`.env` の `PORT` で管理、コードにハードコードしない）
- `.env`: `PORT=6100`、`HOST=127.0.0.1`、`ANTHROPIC_API_KEY=...`（AIエンリッチメント用）
- 起動: `node --env-file=.env dist/index.js server` を pm2 で常駐（cwd はリポジトリ直下必須。
  `data/` と `output/` が `process.cwd()` 基準のため、間違えると「動くのにレポートが無い」沈黙故障になる）
- `pm2 save` で再起動後も自動復帰

## データ移行

しない。サーバーは空 DB からスタートし、初回デプロイ時に一度検索を実行して
データを貯める（レポートは毎回全件再生成なので、これで実用上完全な状態になる）。

## 検証項目（デプロイ時）

1. `https://nagaiku.top/grantsearch/` が未ログイン時に gate のログイン画面へ飛ぶ
2. `/grantsearch`（スラッシュなし）が `/grantsearch/` にリダイレクトされる
3. ログイン後にダッシュボードが表示され、「検索を実行」→ ポーリング → 完了表示まで動く
4. `api/report` で最新レポートが表示される
5. `data/grants.db` と `output/` がリポジトリ直下にできている（cwd 確認）
6. LAN 内から `192.168.0.25:6100` へ直接アクセスできない（127.0.0.1 バインド確認）
7. pm2 再起動（`pm2 restart` / サーバー再起動想定）後も復帰する

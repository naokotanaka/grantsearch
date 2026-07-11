import http from "http";
import fs from "fs";
import path from "path";
import { getSearchState, startSearch } from "./search-runner";
import {
  getDatabase,
  getGrantById,
  updateMemo,
  updateManualUrl,
  updateGrantDetails,
} from "./models/database";
import { generateAllReports } from "./reports/report-generator";
import { enrichSingleGrant } from "./enrich/ai-enricher";

const PORT = parseInt(process.env.PORT ?? "3000", 10);
// nginx 経由での公開を前提に、既定はループバックのみ待ち受ける
// （0.0.0.0 だと LAN 内から認証ゲートを素通りして直接アクセスできてしまう）
const HOST = process.env.HOST ?? "127.0.0.1";

/** リクエストボディをJSONとして読む（上限10KB） */
function readJsonBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 10 * 1024) {
        reject(new Error("リクエストが大きすぎます"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("JSONを解析できません"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, code: number, data: object): void {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

export function startServer(): void {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

    if (url.pathname === "/" && req.method === "GET") {
      // トップページ（操作パネル）
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(getDashboardHtml());
    } else if (url.pathname === "/api/search" && req.method === "POST") {
      // 検索開始API（バックグラウンドで実行し、即座に応答を返す）
      const started = startSearch("ダッシュボード");
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      if (started) {
        res.end(
          JSON.stringify({ status: "started", message: "検索を開始しました" }),
        );
      } else {
        res.end(
          JSON.stringify({
            status: "running",
            message: "すでに検索を実行中です",
          }),
        );
      }
    } else if (url.pathname === "/api/status" && req.method === "GET") {
      // 検索の実行状態を返す（フロントがポーリングする）
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(getSearchState()));
    } else if (url.pathname === "/api/memo" && req.method === "POST") {
      // メモの保存（人間の入力。再検索でも消えない）
      try {
        const body = await readJsonBody(req);
        const id = String(body.id ?? "");
        const memo = String(body.memo ?? "").slice(0, 500);
        const db = getDatabase();
        try {
          if (!id || !getGrantById(db, id)) {
            sendJson(res, 400, {
              status: "error",
              message: "対象の助成金が見つかりません",
            });
            return;
          }
          updateMemo(db, id, memo);
        } finally {
          db.close();
        }
        generateAllReports(); // メモ入りのレポートに作り直す
        sendJson(res, 200, { status: "ok", message: "メモを保存しました" });
      } catch (error) {
        sendJson(res, 400, {
          status: "error",
          message: error instanceof Error ? error.message : "不正なリクエスト",
        });
      }
    } else if (url.pathname === "/api/manual-url" && req.method === "POST") {
      // 募集要項URLの手動登録 → その場でAIが読み取って詳細を埋める
      try {
        const body = await readJsonBody(req);
        const id = String(body.id ?? "");
        const manualUrl = String(body.url ?? "").trim();
        if (!/^https?:\/\//.test(manualUrl)) {
          sendJson(res, 400, {
            status: "error",
            message: "http(s) のURLを入力してください",
          });
          return;
        }

        const db = getDatabase();
        let grant;
        try {
          grant = getGrantById(db, id);
          if (!grant) {
            sendJson(res, 400, {
              status: "error",
              message: "対象の助成金が見つかりません",
            });
            return;
          }
          updateManualUrl(db, id, manualUrl);
          grant.manualUrl = manualUrl;
        } finally {
          db.close();
        }

        // AIで読み取り（キー未設定・ページが読めない場合は null）
        const enriched = await enrichSingleGrant(grant);
        if (enriched) {
          const db2 = getDatabase();
          try {
            updateGrantDetails(db2, enriched);
          } finally {
            db2.close();
          }
          generateAllReports();
          sendJson(res, 200, {
            status: "ok",
            message: "URLを登録し、AIが読み取って詳細を更新しました",
          });
        } else if (!process.env.ANTHROPIC_API_KEY) {
          sendJson(res, 200, {
            status: "ok",
            message:
              "URLを登録しました（AIキー未設定のため、読み取りは次回の検索時に行います）",
          });
        } else {
          sendJson(res, 200, {
            status: "ok",
            message:
              "URLを登録しましたが、ページを読み取れませんでした（次回の検索時に再試行します）",
          });
        }
      } catch (error) {
        sendJson(res, 400, {
          status: "error",
          message: error instanceof Error ? error.message : "不正なリクエスト",
        });
      }
    } else if (url.pathname === "/api/report" && req.method === "GET") {
      // 最新レポート取得
      const outputDir = path.join(process.cwd(), "output");
      try {
        const files = fs
          .readdirSync(outputDir)
          .filter((f) => f.endsWith(".html"))
          .sort()
          .reverse();

        if (files.length > 0) {
          const html = fs.readFileSync(path.join(outputDir, files[0]), "utf-8");
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(html);
        } else {
          res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
          res.end(
            "<h1>レポートがまだありません。先に検索を実行してください。</h1>",
          );
        }
      } catch {
        res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          "<h1>レポートがまだありません。先に検索を実行してください。</h1>",
        );
      }
    } else {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not Found");
    }
  });

  server.listen(PORT, HOST, () => {
    console.log(`\n🌐 助成金検索サーバーが起動しました`);
    console.log(`   http://${HOST}:${PORT}`);
    console.log(`   Ctrl+C で停止\n`);
  });
}

function getDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>助成金検索システム</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, 'Hiragino Kaku Gothic ProN', 'Noto Sans JP', sans-serif;
      background: #f0f4f8;
      color: #333;
      min-height: 100vh;
    }
    .container {
      max-width: 600px;
      margin: 0 auto;
      padding: 20px;
    }
    h1 {
      text-align: center;
      font-size: 1.5em;
      padding: 20px 0;
      color: #2c3e50;
    }
    .card {
      background: white;
      border-radius: 12px;
      padding: 20px;
      margin-bottom: 16px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
    }
    .card h2 {
      font-size: 1.1em;
      color: #555;
      margin-bottom: 12px;
    }
    .btn {
      display: block;
      width: 100%;
      padding: 16px;
      font-size: 1.1em;
      font-weight: bold;
      border: none;
      border-radius: 8px;
      cursor: pointer;
      margin-bottom: 10px;
      transition: transform 0.1s, opacity 0.2s;
    }
    .btn:active { transform: scale(0.98); }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-primary {
      background: #3498db;
      color: white;
    }
    .btn-success {
      background: #27ae60;
      color: white;
    }
    .status {
      padding: 12px;
      border-radius: 8px;
      margin-top: 12px;
      font-size: 0.95em;
      display: none;
    }
    .status.show { display: block; }
    .status.running { background: #fff3cd; color: #856404; }
    .status.completed { background: #d4edda; color: #155724; }
    .status.error { background: #f8d7da; color: #721c24; }
    .info {
      font-size: 0.95em;
      color: #555;
      line-height: 1.6;
    }
    .spinner {
      display: inline-block;
      width: 16px;
      height: 16px;
      border: 2px solid #856404;
      border-top-color: transparent;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      vertical-align: middle;
      margin-right: 6px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="container">
    <h1>助成金・補助金<br>定期検索システム</h1>

    <div class="card">
      <h2>検索を実行</h2>
      <button class="btn btn-primary" id="searchBtn" onclick="runSearch()">
        助成金を検索する
      </button>
      <div class="status" id="searchStatus"></div>
      <p class="info" style="margin-top:8px;">
        検索には数分かかります。開始したら画面を閉じても大丈夫です
        （毎週月曜9:00にも自動実行されます）。
      </p>
    </div>

    <div class="card">
      <h2>レポートを見る</h2>
      <a href="api/report" class="btn btn-success" style="text-align:center; text-decoration:none; display:block;">
        最新レポートを表示
      </a>
    </div>

    <div class="card">
      <h2>対象分野</h2>
      <div class="info">
        <p>・子育て支援</p>
        <p>・子ども食堂 / フードパントリー</p>
        <p>・外国にルーツを持つ人の支援</p>
        <p>・児童の健全育成 / 居場所づくり</p>
        <p>・学習支援</p>
      </div>
    </div>

    <div class="card">
      <h2>対象地域</h2>
      <div class="info">
        <p>・全国</p>
        <p>・愛知県</p>
        <p>・長久手市</p>
      </div>
    </div>
  </div>

  <script>
    const btn = document.getElementById('searchBtn');
    const status = document.getElementById('searchStatus');
    let pollTimer = null;

    function showRunning() {
      btn.disabled = true;
      btn.textContent = '検索中...';
      status.className = 'status show running';
      status.innerHTML = '<span class="spinner"></span> 助成金情報を収集しています。数分かかります...';
    }

    function showIdle(last) {
      btn.disabled = false;
      btn.textContent = '助成金を検索する';
      if (!last) { status.className = 'status'; return; }
      const time = new Date(last.finishedAt).toLocaleString('ja-JP');
      if (last.status === '完了') {
        status.className = 'status show completed';
        status.textContent = last.message + '（' + time + '）';
      } else {
        status.className = 'status show error';
        status.textContent = 'エラー: ' + last.message + '（' + time + '）';
      }
    }

    function stopPolling() {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    }

    async function poll() {
      try {
        const res = await fetch('api/status');
        const state = await res.json();
        if (state.running) {
          showRunning();
          if (!pollTimer) pollTimer = setInterval(poll, 5000);
        } else {
          stopPolling();
          showIdle(state.last);
        }
      } catch (e) {
        stopPolling();
        btn.disabled = false;
        btn.textContent = '助成金を検索する';
        status.className = 'status show error';
        status.textContent = 'ネットワークエラーが発生しました';
      }
    }

    async function runSearch() {
      showRunning();
      try {
        await fetch('api/search', { method: 'POST' });
      } catch (e) {
        status.className = 'status show error';
        status.textContent = 'ネットワークエラーが発生しました';
        btn.disabled = false;
        btn.textContent = '助成金を検索する';
        return;
      }
      if (!pollTimer) pollTimer = setInterval(poll, 5000);
    }

    // ページを開いたとき、実行中なら途中から状態表示を引き継ぐ
    poll();
  </script>
</body>
</html>`;
}

import http from "http";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { getSearchState, startSearch } from "./search-runner";
import {
  getDatabase,
  getGrantById,
  upsertGrant,
  updateMemo,
  updateManualUrl,
  updateGrantDetails,
  updateHumanJudgment,
  getWatchSites,
  addWatchSite,
  deleteWatchSite,
} from "./models/database";
import { Grant, HumanJudgment, Region } from "./models/grant";
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
    } else if (url.pathname === "/api/judgment" && req.method === "POST") {
      // 人間の判定（👍関係あり／👎関係ない／空=取り消し）。再検索でも消えない
      try {
        const body = await readJsonBody(req);
        const id = String(body.id ?? "");
        const judgment = String(body.judgment ?? "");
        if (!["", "関係あり", "関係ない"].includes(judgment)) {
          sendJson(res, 400, {
            status: "error",
            message: "判定の値が不正です",
          });
          return;
        }
        const db = getDatabase();
        try {
          if (!id || !getGrantById(db, id)) {
            sendJson(res, 400, {
              status: "error",
              message: "対象の助成金が見つかりません",
            });
            return;
          }
          updateHumanJudgment(db, id, judgment as HumanJudgment);
        } finally {
          db.close();
        }
        generateAllReports(); // 判定を反映したレポートに作り直す
        sendJson(res, 200, { status: "ok", message: "判定を保存しました" });
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
    } else if (url.pathname === "/api/add-grant" && req.method === "POST") {
      // 助成金の手動追加。「関係あり」👍として登録し（再検索でも消えず、
      // 毎週公式ページをチェックして募集開始を検知）、その場でAIが詳細を読み取る
      try {
        const body = await readJsonBody(req);
        const name = String(body.name ?? "")
          .trim()
          .slice(0, 100);
        const organization =
          String(body.organization ?? "")
            .trim()
            .slice(0, 100) || "要確認";
        const grantUrl = String(body.url ?? "").trim();
        const regionInput = String(body.region ?? "全国");
        const region: Region = (
          ["全国", "愛知県", "長久手市"] as const
        ).includes(regionInput as Region)
          ? (regionInput as Region)
          : "全国";
        if (!name) {
          sendJson(res, 400, {
            status: "error",
            message: "助成金名を入力してください",
          });
          return;
        }
        if (!/^https?:\/\//.test(grantUrl)) {
          sendJson(res, 400, {
            status: "error",
            message: "http(s) のURLを入力してください",
          });
          return;
        }

        const id =
          "manual_" +
          crypto
            .createHash("md5")
            .update(`${name}_${organization}`)
            .digest("hex")
            .slice(0, 8);
        const grant: Grant = {
          id,
          name,
          organization,
          region,
          targetProjects: "手動登録（内容はリンク先参照）",
          grantAmount: "要確認",
          grantPeriod: "要確認",
          applicationDeadline: "要確認",
          expectedPeriod: "",
          personnelCosts: "不明",
          honorarium: "不明",
          rent: "不明",
          benefitType: "不明",
          status: "不明",
          url: grantUrl,
          source: "manual",
          lastUpdated: new Date().toISOString(),
          memo: "",
          manualUrl: "",
          humanJudgment: "",
        };
        const db = getDatabase();
        try {
          upsertGrant(db, grant);
          // 手動追加＝人間が「関係あり」と判断したもの。👍と同じ扱いにして
          // 追跡（毎週の募集開始チェック・AI除外からの保護）に載せる
          updateHumanJudgment(db, id, "関係あり");
        } finally {
          db.close();
        }

        // その場でAIがページを読んで詳細を埋める（読めなくても登録自体は成立）
        const enriched = await enrichSingleGrant({
          ...grant,
          humanJudgment: "関係あり",
        });
        if (enriched) {
          const db2 = getDatabase();
          try {
            updateGrantDetails(db2, enriched);
          } finally {
            db2.close();
          }
        }
        generateAllReports();
        sendJson(res, 200, {
          status: "ok",
          message: enriched
            ? "追加しました。AIがページを読み取り、詳細を反映しました"
            : "追加しました（ページの読み取りは次回の検索時に行います）",
        });
      } catch (error) {
        sendJson(res, 400, {
          status: "error",
          message: error instanceof Error ? error.message : "不正なリクエスト",
        });
      }
    } else if (url.pathname === "/api/watch-sites" && req.method === "GET") {
      // 巡回サイトの一覧
      const db = getDatabase();
      try {
        sendJson(res, 200, { status: "ok", sites: getWatchSites(db) });
      } finally {
        db.close();
      }
    } else if (url.pathname === "/api/watch-sites" && req.method === "POST") {
      // 巡回サイトの追加（毎週の検索でページ内の助成金リンクを拾う）
      try {
        const body = await readJsonBody(req);
        const siteUrl = String(body.url ?? "").trim();
        if (!/^https?:\/\//.test(siteUrl)) {
          sendJson(res, 400, {
            status: "error",
            message: "http(s) のURLを入力してください",
          });
          return;
        }
        const label =
          String(body.label ?? "")
            .trim()
            .slice(0, 60) || new URL(siteUrl).hostname;
        const db = getDatabase();
        try {
          addWatchSite(db, label, siteUrl);
        } finally {
          db.close();
        }
        sendJson(res, 200, {
          status: "ok",
          message:
            "巡回サイトを追加しました。次回の検索から助成金リンクを拾います",
        });
      } catch (error) {
        sendJson(res, 400, {
          status: "error",
          message: error instanceof Error ? error.message : "不正なリクエスト",
        });
      }
    } else if (
      url.pathname === "/api/watch-sites/delete" &&
      req.method === "POST"
    ) {
      // 巡回サイトの削除
      try {
        const body = await readJsonBody(req);
        const id = Number(body.id);
        if (!Number.isInteger(id)) {
          sendJson(res, 400, { status: "error", message: "idが不正です" });
          return;
        }
        const db = getDatabase();
        try {
          deleteWatchSite(db, id);
        } finally {
          db.close();
        }
        sendJson(res, 200, { status: "ok", message: "削除しました" });
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
    .field {
      display: block;
      width: 100%;
      padding: 10px;
      margin-bottom: 8px;
      border: 1px solid #ccc;
      border-radius: 8px;
      font-size: 1em;
      background: #fff;
    }
    .ws-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      padding: 8px 0;
      border-bottom: 1px solid #eee;
      font-size: 0.95em;
    }
    .ws-row a { color: #2980b9; word-break: break-all; }
    .ws-del {
      flex-shrink: 0;
      background: #fff;
      color: #c0392b;
      border: 1px solid #c0392b;
      border-radius: 6px;
      padding: 6px 10px;
      cursor: pointer;
      font-size: 0.9em;
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
      <h2>➕ 助成金を手動で追加</h2>
      <input class="field" id="agName" placeholder="助成金名（必須）">
      <input class="field" id="agOrg" placeholder="助成元の団体名（分かれば）">
      <input class="field" id="agUrl" type="url" placeholder="公式ページのURL（必須）">
      <select class="field" id="agRegion">
        <option value="全国">全国</option>
        <option value="愛知県">愛知県</option>
        <option value="長久手市">長久手市</option>
      </select>
      <button class="btn btn-primary" id="agBtn" onclick="addGrant()">追加する</button>
      <div class="status" id="agStatus"></div>
      <p class="info" style="margin-top:8px;">
        追加した助成金は👍「関係あり」として扱われ、AIがその場でページを読んで
        詳細を埋めます（少し時間がかかります）。以後は毎週の検索で
        募集開始を自動チェックします。
      </p>
    </div>

    <div class="card">
      <h2>👀 巡回サイト</h2>
      <div id="wsList" class="info" style="margin-bottom:10px;">読み込み中...</div>
      <input class="field" id="wsLabel" placeholder="サイト名（例: 〇〇財団 お知らせ）">
      <input class="field" id="wsUrl" type="url" placeholder="ページのURL（必須）">
      <button class="btn btn-primary" id="wsBtn" onclick="addSite()">巡回サイトを追加</button>
      <div class="status" id="wsStatus"></div>
      <p class="info" style="margin-top:8px;">
        毎週の検索でこのページを開き、助成金らしいリンクを
        レポートの「🔎新着・発見」に拾い上げます
        （助成金情報のまとめページや財団のお知らせ一覧に向いています）。
      </p>
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

    function showMsg(el, ok, text) {
      el.className = 'status show ' + (ok ? 'completed' : 'error');
      el.textContent = text;
    }

    async function addGrant() {
      const name = document.getElementById('agName').value.trim();
      const org = document.getElementById('agOrg').value.trim();
      const grantUrl = document.getElementById('agUrl').value.trim();
      const region = document.getElementById('agRegion').value;
      const st = document.getElementById('agStatus');
      const b = document.getElementById('agBtn');
      if (!name || !grantUrl) {
        showMsg(st, false, '助成金名とURLを入力してください');
        return;
      }
      b.disabled = true;
      b.textContent = 'AIが読み取り中...';
      try {
        const res = await fetch('api/add-grant', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: name, organization: org, url: grantUrl, region: region })
        });
        const data = await res.json();
        showMsg(st, data.status === 'ok', data.message);
        if (data.status === 'ok') {
          document.getElementById('agName').value = '';
          document.getElementById('agOrg').value = '';
          document.getElementById('agUrl').value = '';
        }
      } catch (e) {
        showMsg(st, false, 'ネットワークエラーが発生しました');
      }
      b.disabled = false;
      b.textContent = '追加する';
    }

    async function loadSites() {
      const list = document.getElementById('wsList');
      try {
        const res = await fetch('api/watch-sites');
        const data = await res.json();
        if (!data.sites || data.sites.length === 0) {
          list.textContent = '（まだ登録されていません）';
          return;
        }
        list.innerHTML = '';
        data.sites.forEach(function (s) {
          const row = document.createElement('div');
          row.className = 'ws-row';
          const a = document.createElement('a');
          a.href = s.url;
          a.target = '_blank';
          a.rel = 'noopener';
          a.textContent = s.label;
          const del = document.createElement('button');
          del.className = 'ws-del';
          del.textContent = '削除';
          del.onclick = function () { deleteSite(s.id, s.label); };
          row.appendChild(a);
          row.appendChild(del);
          list.appendChild(row);
        });
      } catch (e) {
        list.textContent = '一覧を取得できませんでした';
      }
    }

    async function addSite() {
      const label = document.getElementById('wsLabel').value.trim();
      const siteUrl = document.getElementById('wsUrl').value.trim();
      const st = document.getElementById('wsStatus');
      if (!siteUrl) {
        showMsg(st, false, 'URLを入力してください');
        return;
      }
      try {
        const res = await fetch('api/watch-sites', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: label, url: siteUrl })
        });
        const data = await res.json();
        showMsg(st, data.status === 'ok', data.message);
        if (data.status === 'ok') {
          document.getElementById('wsLabel').value = '';
          document.getElementById('wsUrl').value = '';
          loadSites();
        }
      } catch (e) {
        showMsg(st, false, 'ネットワークエラーが発生しました');
      }
    }

    async function deleteSite(id, label) {
      if (!confirm('「' + label + '」を巡回サイトから削除しますか？')) return;
      try {
        await fetch('api/watch-sites/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: id })
        });
      } catch (e) {}
      loadSites();
    }

    // ページを開いたとき、実行中なら途中から状態表示を引き継ぐ
    poll();
    loadSites();
  </script>
</body>
</html>`;
}

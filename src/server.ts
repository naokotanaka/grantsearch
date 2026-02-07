import http from 'http';
import { searchAllSources } from './scrapers';
import { generateAllReports } from './reports/report-generator';
import fs from 'fs';
import path from 'path';

const PORT = parseInt(process.env.PORT ?? '3000', 10);

export function startServer(): void {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

    // CORS対応（スマホからのアクセス用）
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (url.pathname === '/' && req.method === 'GET') {
      // トップページ（操作パネル）
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(getDashboardHtml());
    } else if (url.pathname === '/api/search' && req.method === 'POST') {
      // 検索実行API
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.write(JSON.stringify({ status: 'running', message: '検索を開始しました...' }) + '\n');

      try {
        const grants = await searchAllSources();
        generateAllReports(grants);
        res.end(JSON.stringify({
          status: 'completed',
          message: `${grants.length}件の助成金情報を取得しました`,
          count: grants.length,
        }));
      } catch (error) {
        res.end(JSON.stringify({
          status: 'error',
          message: error instanceof Error ? error.message : '不明なエラー',
        }));
      }
    } else if (url.pathname === '/api/report' && req.method === 'GET') {
      // 最新レポート取得
      const outputDir = path.join(process.cwd(), 'output');
      try {
        const files = fs.readdirSync(outputDir)
          .filter(f => f.endsWith('.html'))
          .sort()
          .reverse();

        if (files.length > 0) {
          const html = fs.readFileSync(path.join(outputDir, files[0]), 'utf-8');
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(html);
        } else {
          res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<h1>レポートがまだありません。先に検索を実行してください。</h1>');
        }
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h1>レポートがまだありません。先に検索を実行してください。</h1>');
      }
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
    }
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🌐 助成金検索サーバーが起動しました`);
    console.log(`   http://localhost:${PORT}`);
    console.log(`   スマホから同じWiFi内でアクセス: http://<このPCのIPアドレス>:${PORT}`);
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
      font-size: 0.85em;
      color: #888;
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
    </div>

    <div class="card">
      <h2>レポートを見る</h2>
      <a href="/api/report" class="btn btn-success" style="text-align:center; text-decoration:none; display:block;">
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
    async function runSearch() {
      const btn = document.getElementById('searchBtn');
      const status = document.getElementById('searchStatus');

      btn.disabled = true;
      btn.textContent = '検索中...';
      status.className = 'status show running';
      status.innerHTML = '<span class="spinner"></span> 助成金情報を収集しています。しばらくお待ちください...';

      try {
        const res = await fetch('/api/search', { method: 'POST' });
        const text = await res.text();
        // レスポンスの最後のJSONを取得
        const lines = text.trim().split('\\n');
        const data = JSON.parse(lines[lines.length - 1]);

        if (data.status === 'completed') {
          status.className = 'status show completed';
          status.textContent = data.message;
        } else {
          status.className = 'status show error';
          status.textContent = 'エラー: ' + data.message;
        }
      } catch (e) {
        status.className = 'status show error';
        status.textContent = 'ネットワークエラーが発生しました';
      }

      btn.disabled = false;
      btn.textContent = '助成金を検索する';
    }
  </script>
</body>
</html>`;
}

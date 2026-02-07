import fs from 'fs';
import path from 'path';

/**
 * GitHub Pages用のファイルを生成する
 * output/ 内の最新レポートをコピーし、index.html を作成
 */
function generatePages(): void {
  const pagesDir = path.join(process.cwd(), 'pages');
  const outputDir = path.join(process.cwd(), 'output');

  // pagesディレクトリを作成
  if (fs.existsSync(pagesDir)) {
    fs.rmSync(pagesDir, { recursive: true });
  }
  fs.mkdirSync(pagesDir, { recursive: true });

  // outputディレクトリのHTMLファイルを探す
  if (!fs.existsSync(outputDir)) {
    console.log('output/ ディレクトリが見つかりません。先にsearchを実行してください。');
    writeEmptyPage(pagesDir);
    return;
  }

  const htmlFiles = fs.readdirSync(outputDir)
    .filter(f => f.endsWith('.html'))
    .sort()
    .reverse();

  if (htmlFiles.length === 0) {
    console.log('HTMLレポートが見つかりません。');
    writeEmptyPage(pagesDir);
    return;
  }

  // 最新のHTMLレポートをindex.htmlとしてコピー
  const latestReport = htmlFiles[0];
  const reportContent = fs.readFileSync(path.join(outputDir, latestReport), 'utf-8');
  fs.writeFileSync(path.join(pagesDir, 'index.html'), reportContent, 'utf-8');

  // 全レポートもコピー
  for (const file of fs.readdirSync(outputDir)) {
    fs.copyFileSync(path.join(outputDir, file), path.join(pagesDir, file));
  }

  console.log(`GitHub Pages用ファイルを生成しました (pages/index.html)`);
  console.log(`最新レポート: ${latestReport}`);
}

function writeEmptyPage(pagesDir: string): void {
  const html = `<!DOCTYPE html>
<html lang="ja">
<head><meta charset="UTF-8"><title>助成金レポート</title></head>
<body><h1>レポートはまだ生成されていません</h1><p>GitHub Actionsで検索を実行してください。</p></body>
</html>`;
  fs.writeFileSync(path.join(pagesDir, 'index.html'), html, 'utf-8');
}

generatePages();

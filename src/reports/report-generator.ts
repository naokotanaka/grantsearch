import fs from 'fs';
import path from 'path';
import dayjs from 'dayjs';
import { Grant, Region } from '../models/grant';
import { getDatabase, getAllGrants, getActiveGrants } from '../models/database';

const OUTPUT_DIR = path.join(process.cwd(), 'output');

function ensureOutputDir(): void {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
}

/** レポートを全形式で生成 */
export function generateAllReports(grants?: Grant[]): void {
  const db = getDatabase();
  const data = grants ?? getAllGrants(db);
  db.close();

  if (data.length === 0) {
    console.log('レポート対象の助成金データがありません。先に search を実行してください。');
    return;
  }

  ensureOutputDir();
  const timestamp = dayjs().format('YYYY-MM-DD');

  generateMarkdownReport(data, timestamp);
  generateHtmlReport(data, timestamp);
  generateConsoleReport(data);
}

/** コンソール出力 */
function generateConsoleReport(grants: Grant[]): void {
  console.log('\n' + '='.repeat(100));
  console.log('  助成金・補助金 一覧レポート');
  console.log('  対象: 子育て支援 / 子ども食堂 / 外国にルーツを持つ人の支援');
  console.log('  地域: 全国 / 愛知県 / 長久手市');
  console.log('  生成日: ' + dayjs().format('YYYY年MM月DD日'));
  console.log('='.repeat(100));

  const regions: Region[] = ['全国', '愛知県', '長久手市'];

  for (const region of regions) {
    const regionGrants = grants.filter(g => g.region === region);
    if (regionGrants.length === 0) continue;

    console.log(`\n${'─'.repeat(80)}`);
    console.log(`  【${region}】 ${regionGrants.length}件`);
    console.log(`${'─'.repeat(80)}`);

    for (const grant of regionGrants) {
      console.log(`\n  ■ ${grant.name}`);
      console.log(`    助成元:     ${grant.organization}`);
      console.log(`    対象事業:   ${grant.targetProjects || '要確認'}`);
      console.log(`    助成額:     ${grant.grantAmount || '要確認'}`);
      console.log(`    助成期間:   ${grant.grantPeriod || '要確認'}`);
      console.log(`    締切:       ${grant.applicationDeadline || '要確認'}`);
      console.log(`    人件費:     ${grant.personnelCosts}`);
      console.log(`    謝金:       ${grant.honorarium}`);
      console.log(`    家賃:       ${grant.rent}`);
      console.log(`    状態:       ${grant.status}`);
      console.log(`    URL:        ${grant.url}`);
    }
  }

  console.log('\n' + '='.repeat(100));
  console.log(`  合計: ${grants.length}件`);
  console.log('='.repeat(100) + '\n');
}

/** Markdownレポート生成 */
function generateMarkdownReport(grants: Grant[], timestamp: string): void {
  const lines: string[] = [];

  lines.push('# 助成金・補助金 一覧レポート');
  lines.push('');
  lines.push(`**対象分野:** 子育て支援 / 子ども食堂 / 外国にルーツを持つ人の支援`);
  lines.push(`**対象地域:** 全国 / 愛知県 / 長久手市`);
  lines.push(`**生成日:** ${dayjs().format('YYYY年MM月DD日')}`);
  lines.push(`**件数:** ${grants.length}件`);
  lines.push('');

  const regions: Region[] = ['全国', '愛知県', '長久手市'];

  for (const region of regions) {
    const regionGrants = grants.filter(g => g.region === region);
    if (regionGrants.length === 0) continue;

    lines.push(`## ${region}（${regionGrants.length}件）`);
    lines.push('');
    lines.push('| 助成金名 | 助成元 | 対象事業 | 助成額 | 助成期間 | 締切 | 人件費 | 謝金 | 家賃 | 状態 |');
    lines.push('|---------|--------|---------|--------|---------|------|--------|------|------|------|');

    for (const grant of regionGrants) {
      const name = grant.url ? `[${grant.name}](${grant.url})` : grant.name;
      lines.push(
        `| ${name} | ${grant.organization} | ${grant.targetProjects || '要確認'} | ${grant.grantAmount || '要確認'} | ${grant.grantPeriod || '要確認'} | ${grant.applicationDeadline || '要確認'} | ${grant.personnelCosts} | ${grant.honorarium} | ${grant.rent} | ${grant.status} |`
      );
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('### 凡例');
  lines.push('- **人件費/謝金/家賃:** 可=利用可能、不可=利用不可、要確認=詳細を要確認、不明=情報なし');
  lines.push('- **状態:** 募集中/募集前/募集終了/不明');
  lines.push('');
  lines.push('> このレポートは自動収集した情報に基づいています。正確な情報は各助成金の公式サイトでご確認ください。');

  const filePath = path.join(OUTPUT_DIR, `grants-report-${timestamp}.md`);
  fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
  console.log(`\n📄 Markdownレポートを生成しました: ${filePath}`);
}

/** HTMLレポート生成 */
function generateHtmlReport(grants: Grant[], timestamp: string): void {
  const regions: Region[] = ['全国', '愛知県', '長久手市'];

  let html = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>助成金・補助金 一覧レポート - ${dayjs().format('YYYY年MM月DD日')}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Hiragino Kaku Gothic ProN', 'Noto Sans JP', sans-serif; background: #f5f5f5; color: #333; padding: 20px; }
    .container { max-width: 1400px; margin: 0 auto; }
    h1 { text-align: center; padding: 20px 0; color: #2c3e50; }
    .meta { text-align: center; color: #666; margin-bottom: 30px; }
    h2 { color: #2c3e50; border-bottom: 3px solid #3498db; padding-bottom: 8px; margin: 30px 0 15px; }
    .region-count { color: #666; font-size: 0.9em; font-weight: normal; }
    table { width: 100%; border-collapse: collapse; background: white; box-shadow: 0 2px 4px rgba(0,0,0,0.1); margin-bottom: 30px; }
    th { background: #3498db; color: white; padding: 12px 8px; font-size: 0.85em; text-align: left; white-space: nowrap; }
    td { padding: 10px 8px; border-bottom: 1px solid #eee; font-size: 0.85em; vertical-align: top; }
    tr:hover td { background: #f0f8ff; }
    a { color: #2980b9; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .eligible { color: #27ae60; font-weight: bold; }
    .ineligible { color: #e74c3c; font-weight: bold; }
    .check { color: #f39c12; }
    .unknown { color: #999; }
    .status-active { background: #d4edda; color: #155724; padding: 2px 8px; border-radius: 4px; font-size: 0.85em; }
    .status-upcoming { background: #fff3cd; color: #856404; padding: 2px 8px; border-radius: 4px; font-size: 0.85em; }
    .status-closed { background: #f8d7da; color: #721c24; padding: 2px 8px; border-radius: 4px; font-size: 0.85em; }
    .status-unknown { background: #e2e3e5; color: #383d41; padding: 2px 8px; border-radius: 4px; font-size: 0.85em; }
    .footer { text-align: center; color: #999; font-size: 0.85em; margin-top: 30px; padding: 20px; }
    @media (max-width: 768px) {
      table { font-size: 0.75em; }
      th, td { padding: 6px 4px; }
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>助成金・補助金 一覧レポート</h1>
    <p class="meta">
      <strong>対象分野:</strong> 子育て支援 / 子ども食堂 / 外国にルーツを持つ人の支援<br>
      <strong>対象地域:</strong> 全国 / 愛知県 / 長久手市<br>
      <strong>生成日:</strong> ${dayjs().format('YYYY年MM月DD日')} ｜ <strong>件数:</strong> ${grants.length}件
    </p>
`;

  for (const region of regions) {
    const regionGrants = grants.filter(g => g.region === region);
    if (regionGrants.length === 0) continue;

    html += `
    <h2>${region} <span class="region-count">(${regionGrants.length}件)</span></h2>
    <table>
      <thead>
        <tr>
          <th>助成金名</th>
          <th>助成元</th>
          <th>対象事業</th>
          <th>助成額</th>
          <th>助成期間</th>
          <th>締切</th>
          <th>人件費</th>
          <th>謝金</th>
          <th>家賃</th>
          <th>状態</th>
        </tr>
      </thead>
      <tbody>
`;

    for (const grant of regionGrants) {
      const nameCell = grant.url
        ? `<a href="${escapeHtml(grant.url)}" target="_blank">${escapeHtml(grant.name)}</a>`
        : escapeHtml(grant.name);

      html += `        <tr>
          <td>${nameCell}</td>
          <td>${escapeHtml(grant.organization)}</td>
          <td>${escapeHtml(grant.targetProjects || '要確認')}</td>
          <td>${escapeHtml(grant.grantAmount || '要確認')}</td>
          <td>${escapeHtml(grant.grantPeriod || '要確認')}</td>
          <td>${escapeHtml(grant.applicationDeadline || '要確認')}</td>
          <td>${formatEligibility(grant.personnelCosts)}</td>
          <td>${formatEligibility(grant.honorarium)}</td>
          <td>${formatEligibility(grant.rent)}</td>
          <td>${formatStatus(grant.status)}</td>
        </tr>
`;
    }

    html += `      </tbody>
    </table>
`;
  }

  html += `
    <div class="footer">
      <p>このレポートは自動収集した情報に基づいています。正確な情報は各助成金の公式サイトでご確認ください。</p>
      <p>生成日時: ${dayjs().format('YYYY-MM-DD HH:mm:ss')}</p>
    </div>
  </div>
</body>
</html>`;

  const filePath = path.join(OUTPUT_DIR, `grants-report-${timestamp}.html`);
  fs.writeFileSync(filePath, html, 'utf-8');
  console.log(`🌐 HTMLレポートを生成しました: ${filePath}`);
}

function formatEligibility(value: string): string {
  switch (value) {
    case '可': return '<span class="eligible">◯ 可</span>';
    case '不可': return '<span class="ineligible">✗ 不可</span>';
    case '要確認': return '<span class="check">△ 要確認</span>';
    default: return '<span class="unknown">- 不明</span>';
  }
}

function formatStatus(value: string): string {
  switch (value) {
    case '募集中': return '<span class="status-active">募集中</span>';
    case '募集前': return '<span class="status-upcoming">募集前</span>';
    case '募集終了': return '<span class="status-closed">募集終了</span>';
    default: return '<span class="status-unknown">不明</span>';
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

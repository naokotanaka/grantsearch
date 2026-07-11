import fs from "fs";
import path from "path";
import dayjs from "dayjs";
import { Grant } from "../models/grant";
import { getDatabase, getAllGrants } from "../models/database";

const OUTPUT_DIR = path.join(process.cwd(), "output");

function ensureOutputDir(): void {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
}

/**
 * レポート用に助成金を4つのセクションへ分類する
 * 1. 今募集中（締切が近い順）
 * 2. 募集予定・例年この時期（次に来る月の順）
 * 3. 新着・発見（ニュース/ブログから自動発見、新しい順）
 * 4. 要確認（状態を読み取れなかったもの）
 * ※ 募集終了は表示しない
 */
interface Sections {
  open: Grant[];
  upcoming: Grant[];
  discovered: Grant[];
  unknown: Grant[];
}

function categorize(grants: Grant[]): Sections {
  const open = grants.filter((g) => g.status === "募集中");
  const upcoming = grants.filter((g) => g.status === "募集前");
  const discovered = grants.filter(
    (g) =>
      g.source === "news" && g.status !== "募集中" && g.status !== "募集前",
  );
  const unknown = grants.filter(
    (g) => g.status === "不明" && g.source !== "news",
  );

  // 募集中: 締切日昇順（読み取れないものは末尾）
  open.sort((a, b) => {
    const da = parseLastDate(a.applicationDeadline);
    const db = parseLastDate(b.applicationDeadline);
    if (da && db) return da.getTime() - db.getTime();
    if (da) return -1;
    if (db) return 1;
    return 0;
  });

  // 募集予定: 「次に来る月」が近い順（今月起点）
  const currentMonth = new Date().getMonth() + 1;
  const monthsAway = (g: Grant): number => {
    const m = g.expectedPeriod.match(/例年\s*(\d{1,2})月/);
    if (!m) return 99;
    return (parseInt(m[1], 10) - currentMonth + 12) % 12;
  };
  upcoming.sort((a, b) => monthsAway(a) - monthsAway(b));

  // 発見: 配信日（grantPeriod に格納）の新しい順
  discovered.sort((a, b) => (a.grantPeriod < b.grantPeriod ? 1 : -1));

  return { open, upcoming, discovered, unknown };
}

/** 文字列中の最後の日付（＝締切側）を Date にする */
function parseLastDate(text: string): Date | null {
  const matches = [
    ...text.matchAll(/(?:令和\d+年|\d{4}年)\d{1,2}月\d{1,2}日/g),
  ];
  if (matches.length === 0) return null;
  const last = matches[matches.length - 1][0];
  const reiwa = last.match(/令和(\d+)年(\d+)月(\d+)日/);
  if (reiwa)
    return new Date(
      2018 + parseInt(reiwa[1]),
      parseInt(reiwa[2]) - 1,
      parseInt(reiwa[3]),
    );
  const full = last.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (full)
    return new Date(
      parseInt(full[1]),
      parseInt(full[2]) - 1,
      parseInt(full[3]),
    );
  return null;
}

/** レポートを全形式で生成 */
export function generateAllReports(grants?: Grant[]): void {
  const db = getDatabase();
  const data = grants ?? getAllGrants(db);
  db.close();

  if (data.length === 0) {
    console.log(
      "レポート対象の助成金データがありません。先に search を実行してください。",
    );
    return;
  }

  ensureOutputDir();
  const timestamp = dayjs().format("YYYY-MM-DD");
  const sections = categorize(data);

  generateMarkdownReport(sections, timestamp);
  generateHtmlReport(sections, timestamp);
  generateConsoleReport(sections);
}

/** コンソール出力（要約） */
function generateConsoleReport(sections: Sections): void {
  console.log("\n" + "=".repeat(100));
  console.log("  助成金・補助金 レポート");
  console.log("  生成日: " + dayjs().format("YYYY年MM月DD日"));
  console.log("=".repeat(100));

  console.log(`\n🟢 今募集中: ${sections.open.length}件`);
  for (const g of sections.open) {
    console.log(
      `   ・[${g.region}] ${g.name}（締切: ${g.applicationDeadline.slice(0, 40)}）`,
    );
  }

  console.log(`\n🟡 募集予定（例年この時期）: ${sections.upcoming.length}件`);
  for (const g of sections.upcoming.slice(0, 15)) {
    console.log(
      `   ・[${g.region}] ${g.name}（${g.expectedPeriod.slice(0, 40)}）`,
    );
  }
  if (sections.upcoming.length > 15)
    console.log(`   … 他${sections.upcoming.length - 15}件`);

  console.log(`\n🔎 新着・発見: ${sections.discovered.length}件`);
  for (const g of sections.discovered.slice(0, 10)) {
    console.log(`   ・(${g.grantPeriod}) ${g.name.slice(0, 60)}`);
  }

  console.log(`\n⚪ 要確認: ${sections.unknown.length}件`);
  console.log("\n" + "=".repeat(100));
  console.log(
    `  合計: ${sections.open.length + sections.upcoming.length + sections.discovered.length + sections.unknown.length}件`,
  );
  console.log("=".repeat(100) + "\n");
}

/** Markdownレポート生成 */
function generateMarkdownReport(sections: Sections, timestamp: string): void {
  const lines: string[] = [];
  const total =
    sections.open.length +
    sections.upcoming.length +
    sections.discovered.length +
    sections.unknown.length;

  lines.push("# 助成金・補助金 レポート");
  lines.push("");
  lines.push(
    `**対象分野:** 子育て支援 / 子ども食堂 / 外国にルーツを持つ人の支援 / 居場所づくり / 学習支援`,
  );
  lines.push(
    `**生成日:** ${dayjs().format("YYYY年MM月DD日")} ｜ **件数:** ${total}件`,
  );
  lines.push("");

  // 1. 今募集中
  lines.push(`## 🟢 今募集中（${sections.open.length}件）`);
  lines.push("");
  lines.push("締切が近い順に並んでいます。");
  lines.push("");
  lines.push(
    "| 助成金名 | 助成元 | 地域 | 対象事業 | 助成額 | 締切 | 人件費 | 謝金 | 家賃 |",
  );
  lines.push(
    "|---------|--------|------|---------|--------|------|--------|------|------|",
  );
  for (const g of sections.open) {
    lines.push(
      `| ${mdName(g)} | ${g.organization} | ${g.region} | ${g.targetProjects || "要確認"} | ${g.grantAmount || "要確認"} | ${g.applicationDeadline} | ${g.personnelCosts} | ${g.honorarium} | ${g.rent} |`,
    );
  }
  lines.push("");

  // 2. 募集予定
  lines.push(`## 🟡 募集予定・例年この時期（${sections.upcoming.length}件）`);
  lines.push("");
  lines.push(
    "昨年度までに募集実績がある助成金です。発表前から準備できるよう、次に募集が来そうな順に並んでいます。",
  );
  lines.push("");
  lines.push(
    "| 助成金名 | 助成元 | 地域 | 例年の募集時期 | 助成額 | 人件費 | 謝金 | 家賃 |",
  );
  lines.push(
    "|---------|--------|------|--------------|--------|--------|------|------|",
  );
  for (const g of sections.upcoming) {
    lines.push(
      `| ${mdName(g)} | ${g.organization} | ${g.region} | ${g.expectedPeriod || "要確認"} | ${g.grantAmount || "要確認"} | ${g.personnelCosts} | ${g.honorarium} | ${g.rent} |`,
    );
  }
  lines.push("");

  // 3. 新着・発見
  lines.push(`## 🔎 新着・発見（${sections.discovered.length}件）`);
  lines.push("");
  lines.push(
    "ニュース・ブログ・プレスリリースから自動発見した助成金情報の候補です。内容はリンク先でご確認ください。",
  );
  lines.push("");
  lines.push("| 発見日 | タイトル | 配信元 | 締切 |");
  lines.push("|--------|---------|--------|------|");
  for (const g of sections.discovered) {
    lines.push(
      `| ${g.grantPeriod} | ${mdName(g)} | ${g.organization} | ${g.applicationDeadline} |`,
    );
  }
  lines.push("");

  // 4. 要確認
  lines.push(`## ⚪ 要確認（${sections.unknown.length}件）`);
  lines.push("");
  lines.push(
    "募集時期・状態を自動で読み取れなかったものです。リンク先でご確認ください。",
  );
  lines.push("");
  lines.push("| 助成金名 | 助成元 | 地域 | 締切・時期 |");
  lines.push("|---------|--------|------|-----------|");
  for (const g of sections.unknown) {
    lines.push(
      `| ${mdName(g)} | ${g.organization} | ${g.region} | ${g.applicationDeadline} |`,
    );
  }
  lines.push("");

  lines.push("---");
  lines.push("");
  lines.push("### 凡例");
  lines.push("- **🟢 今募集中:** 締切を確認済みで、今応募できるもの");
  lines.push(
    "- **🟡 募集予定:** 昨年度までに実績があり、新年度の発表待ち（発表を検知すると自動で🟢へ移動）",
  );
  lines.push("- **🔎 新着・発見:** ウェブから自動発見した候補（内容は要確認）");
  lines.push(
    "- **人件費/謝金/家賃:** 可＝利用可能、不可＝利用不可、要確認＝詳細を要確認、不明＝情報なし",
  );
  lines.push("");
  lines.push(
    "> このレポートは自動収集した情報に基づいています。正確な情報は各助成金の公式サイトでご確認ください。",
  );

  const filePath = path.join(OUTPUT_DIR, `grants-report-${timestamp}.md`);
  fs.writeFileSync(filePath, lines.join("\n"), "utf-8");
  console.log(`\n📄 Markdownレポートを生成しました: ${filePath}`);
}

function mdName(g: Grant): string {
  return g.url ? `[${g.name}](${g.url})` : g.name;
}

/** HTMLレポート生成 */
function generateHtmlReport(sections: Sections, timestamp: string): void {
  const total =
    sections.open.length +
    sections.upcoming.length +
    sections.discovered.length +
    sections.unknown.length;

  let html = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>助成金・補助金 レポート - ${dayjs().format("YYYY年MM月DD日")}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Hiragino Kaku Gothic ProN', 'Noto Sans JP', sans-serif; background: #f5f5f5; color: #333; padding: 20px; }
    .container { max-width: 1400px; margin: 0 auto; }
    h1 { text-align: center; padding: 20px 0; color: #2c3e50; }
    .meta { text-align: center; color: #666; margin-bottom: 30px; }
    h2 { color: #2c3e50; padding: 10px 14px; margin: 30px 0 6px; border-radius: 8px; }
    h2.sec-open { background: #d4edda; border-left: 8px solid #27ae60; }
    h2.sec-upcoming { background: #fff3cd; border-left: 8px solid #f39c12; }
    h2.sec-discovered { background: #d6eaf8; border-left: 8px solid #2980b9; }
    h2.sec-unknown { background: #e2e3e5; border-left: 8px solid #7f8c8d; }
    .sec-note { color: #666; font-size: 0.9em; margin: 0 0 12px 4px; }
    table { width: 100%; border-collapse: collapse; background: white; box-shadow: 0 2px 4px rgba(0,0,0,0.1); margin-bottom: 30px; }
    th { background: #34495e; color: white; padding: 12px 8px; font-size: 0.85em; text-align: left; white-space: nowrap; }
    td { padding: 10px 8px; border-bottom: 1px solid #eee; font-size: 0.85em; vertical-align: top; }
    tr:hover td { background: #f0f8ff; }
    a { color: #2980b9; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .eligible { color: #27ae60; font-weight: bold; }
    .ineligible { color: #e74c3c; font-weight: bold; }
    .check { color: #f39c12; }
    .unknown { color: #999; }
    .deadline { font-weight: bold; color: #c0392b; }
    .region-tag { background: #eef2f7; border-radius: 4px; padding: 2px 6px; font-size: 0.85em; white-space: nowrap; }
    .footer { text-align: center; color: #999; font-size: 0.85em; margin-top: 30px; padding: 20px; }
    @media (max-width: 768px) {
      table { font-size: 0.75em; }
      th, td { padding: 6px 4px; }
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>助成金・補助金 レポート</h1>
    <p class="meta">
      <strong>対象分野:</strong> 子育て支援 / 子ども食堂 / 外国にルーツを持つ人の支援 / 居場所づくり / 学習支援<br>
      <strong>生成日:</strong> ${dayjs().format("YYYY年MM月DD日")} ｜ <strong>件数:</strong> ${total}件
    </p>
`;

  // 1. 今募集中
  html += `
    <h2 class="sec-open">🟢 今募集中 <span style="font-weight:normal">(${sections.open.length}件)</span></h2>
    <p class="sec-note">締切が近い順に並んでいます。</p>
    <table>
      <thead><tr><th>助成金名</th><th>助成元</th><th>地域</th><th>対象事業</th><th>助成額</th><th>締切</th><th>人件費</th><th>謝金</th><th>家賃</th></tr></thead>
      <tbody>
`;
  for (const g of sections.open) {
    html += `        <tr>
          <td>${htmlName(g)}</td>
          <td>${escapeHtml(g.organization)}</td>
          <td><span class="region-tag">${escapeHtml(g.region)}</span></td>
          <td>${escapeHtml(g.targetProjects || "要確認")}</td>
          <td>${escapeHtml(g.grantAmount || "要確認")}</td>
          <td class="deadline">${escapeHtml(g.applicationDeadline)}</td>
          <td>${formatEligibility(g.personnelCosts)}</td>
          <td>${formatEligibility(g.honorarium)}</td>
          <td>${formatEligibility(g.rent)}</td>
        </tr>\n`;
  }
  html += `      </tbody>
    </table>
`;

  // 2. 募集予定
  html += `
    <h2 class="sec-upcoming">🟡 募集予定・例年この時期 <span style="font-weight:normal">(${sections.upcoming.length}件)</span></h2>
    <p class="sec-note">昨年度までに募集実績がある助成金です。発表前から準備できるよう、次に募集が来そうな順に並んでいます。発表を検知すると自動で「今募集中」へ移動します。</p>
    <table>
      <thead><tr><th>助成金名</th><th>助成元</th><th>地域</th><th>例年の募集時期</th><th>助成額</th><th>人件費</th><th>謝金</th><th>家賃</th></tr></thead>
      <tbody>
`;
  for (const g of sections.upcoming) {
    html += `        <tr>
          <td>${htmlName(g)}</td>
          <td>${escapeHtml(g.organization)}</td>
          <td><span class="region-tag">${escapeHtml(g.region)}</span></td>
          <td>${escapeHtml(g.expectedPeriod || "要確認")}</td>
          <td>${escapeHtml(g.grantAmount || "要確認")}</td>
          <td>${formatEligibility(g.personnelCosts)}</td>
          <td>${formatEligibility(g.honorarium)}</td>
          <td>${formatEligibility(g.rent)}</td>
        </tr>\n`;
  }
  html += `      </tbody>
    </table>
`;

  // 3. 新着・発見
  html += `
    <h2 class="sec-discovered">🔎 新着・発見 <span style="font-weight:normal">(${sections.discovered.length}件)</span></h2>
    <p class="sec-note">ニュース・ブログ・プレスリリースから自動発見した助成金情報の候補です。内容はリンク先でご確認ください。</p>
    <table>
      <thead><tr><th>発見日</th><th>タイトル</th><th>配信元</th><th>締切</th></tr></thead>
      <tbody>
`;
  for (const g of sections.discovered) {
    html += `        <tr>
          <td>${escapeHtml(g.grantPeriod)}</td>
          <td>${htmlName(g)}</td>
          <td>${escapeHtml(g.organization)}</td>
          <td>${escapeHtml(g.applicationDeadline)}</td>
        </tr>\n`;
  }
  html += `      </tbody>
    </table>
`;

  // 4. 要確認
  html += `
    <h2 class="sec-unknown">⚪ 要確認 <span style="font-weight:normal">(${sections.unknown.length}件)</span></h2>
    <p class="sec-note">募集時期・状態を自動で読み取れなかったものです。リンク先でご確認ください。</p>
    <table>
      <thead><tr><th>助成金名</th><th>助成元</th><th>地域</th><th>締切・時期</th></tr></thead>
      <tbody>
`;
  for (const g of sections.unknown) {
    html += `        <tr>
          <td>${htmlName(g)}</td>
          <td>${escapeHtml(g.organization)}</td>
          <td><span class="region-tag">${escapeHtml(g.region)}</span></td>
          <td>${escapeHtml(g.applicationDeadline)}</td>
        </tr>\n`;
  }
  html += `      </tbody>
    </table>

    <div class="footer">
      <p>凡例: 🟢今応募できる ／ 🟡発表待ち（例年時期を表示） ／ 🔎ウェブから自動発見（要確認） ／ ⚪状態不明</p>
      <p>このレポートは自動収集した情報に基づいています。正確な情報は各助成金の公式サイトでご確認ください。</p>
      <p>生成日時: ${dayjs().format("YYYY-MM-DD HH:mm:ss")}</p>
    </div>
  </div>
</body>
</html>`;

  const filePath = path.join(OUTPUT_DIR, `grants-report-${timestamp}.html`);
  fs.writeFileSync(filePath, html, "utf-8");
  console.log(`🌐 HTMLレポートを生成しました: ${filePath}`);
}

function htmlName(g: Grant): string {
  return g.url
    ? `<a href="${escapeHtml(g.url)}" target="_blank">${escapeHtml(g.name)}</a>`
    : escapeHtml(g.name);
}

function formatEligibility(value: string): string {
  switch (value) {
    case "可":
      return '<span class="eligible">◯ 可</span>';
    case "不可":
      return '<span class="ineligible">✗ 不可</span>';
    case "要確認":
      return '<span class="check">△ 要確認</span>';
    default:
      return '<span class="unknown">- 不明</span>';
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

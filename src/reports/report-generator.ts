import fs from "fs";
import path from "path";
import dayjs from "dayjs";
import { Grant } from "../models/grant";
import { getDatabase, getVisibleGrants } from "../models/database";

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
    const months = parseRecruitMonths(g.expectedPeriod);
    if (months.size === 0) return 99;
    return Math.min(...Array.from(months, (m) => (m - currentMonth + 12) % 12));
  };
  upcoming.sort((a, b) => monthsAway(a) - monthsAway(b));

  // 発見: 配信日（grantPeriod に格納）の新しい順
  discovered.sort((a, b) => (a.grantPeriod < b.grantPeriod ? 1 : -1));

  return { open, upcoming, discovered, unknown };
}

/** 開始月〜終了月（年またぎ対応）を Set に展開する */
function addMonthRange(months: Set<number>, start: number, end: number): void {
  if (start < 1 || start > 12 || end < 1 || end > 12) return;
  let m = start;
  for (let i = 0; i < 12; i++) {
    months.add(m);
    if (m === end) break;
    m = (m % 12) + 1;
  }
}

/**
 * 「例年の募集時期」テキストから募集月の集合を取り出す。
 * 対応形式: 「例年7月〜8月頃」（12月〜1月の年またぎ可）／「例年6月頃」／
 * 「春募集: 4月頃 / 秋募集: 10月頃」（複数記述）／「夏期・冬期」等の季節語。
 * 「（昨年実績: ...）」より後ろの具体日付は見ない。
 */
function parseRecruitMonths(text: string): Set<number> {
  const months = new Set<number>();
  if (!text) return months;
  const head = text.split(/[（(]昨年実績/)[0];

  // 範囲（X月〜Y月）
  for (const m of head.matchAll(
    /(\d{1,2})\s*月\s*[〜～~‐－-]\s*(\d{1,2})\s*月/g,
  )) {
    addMonthRange(months, parseInt(m[1], 10), parseInt(m[2], 10));
  }
  // 単独の月（範囲の端も含まれるが Set なので問題ない）
  for (const m of head.matchAll(/(\d{1,2})\s*月/g)) {
    const v = parseInt(m[1], 10);
    if (v >= 1 && v <= 12) months.add(v);
  }
  // 季節語（月の記載がないときの補助）
  if (months.size === 0) {
    if (/春/.test(head)) addMonthRange(months, 3, 5);
    if (/夏/.test(head)) addMonthRange(months, 6, 8);
    if (/秋/.test(head)) addMonthRange(months, 9, 11);
    if (/冬/.test(head)) addMonthRange(months, 12, 2);
  }
  return months;
}

/**
 * 「助成期間」テキストから期間の月集合を取り出す。
 * 「4月1日〜翌年3月31日」「2026年4月～2027年3月」のような月が読める形式のみ対応。
 * 「1年間」「当該年度」などは null（帯を出さない）。
 */
function parseGrantPeriodMonths(text: string): Set<number> | null {
  if (!text) return null;
  const m = text.match(
    /(\d{1,2})\s*月(?:\s*\d{1,2}\s*日)?\s*[〜～~‐－-]\s*(?:翌年)?(?:\d{4}\s*年)?\s*(\d{1,2})\s*月/,
  );
  if (!m) return null;
  const months = new Set<number>();
  addMonthRange(months, parseInt(m[1], 10), parseInt(m[2], 10));
  return months.size > 0 ? months : null;
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

/**
 * レポートを全形式で生成する。
 * データは常にDB（hidden=0 の行）から読む。検索直後・メモ保存後・
 * `npm run report` のどの経路でも同じ内容になる（DBが正本）。
 */
export function generateAllReports(): void {
  const db = getDatabase();
  const data = getVisibleGrants(db);
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
    "| 助成金名 | 助成元 | 地域 | 対象事業 | 助成額 | 締切 | 人件費 | 謝金 | 家賃 | メモ |",
  );
  lines.push(
    "|---------|--------|------|---------|--------|------|--------|------|------|------|",
  );
  for (const g of sections.open) {
    lines.push(
      `| ${mdName(g)} | ${g.organization} | ${g.region} | ${cellText(g.targetProjects || "要確認")} | ${mdAmount(g)} | ${g.applicationDeadline} | ${g.personnelCosts} | ${g.honorarium} | ${g.rent} | ${g.memo} |`,
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
    "| 助成金名 | 助成元 | 地域 | 例年の募集時期 | 助成額 | 人件費 | 謝金 | 家賃 | メモ |",
  );
  lines.push(
    "|---------|--------|------|--------------|--------|--------|------|------|------|",
  );
  for (const g of sections.upcoming) {
    lines.push(
      `| ${mdName(g)} | ${g.organization} | ${g.region} | ${g.expectedPeriod || "要確認"} | ${mdAmount(g)} | ${g.personnelCosts} | ${g.honorarium} | ${g.rent} | ${g.memo} |`,
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
  lines.push("| 発見日 | タイトル | 配信元 | 締切 | メモ |");
  lines.push("|--------|---------|--------|------|------|");
  for (const g of sections.discovered) {
    lines.push(
      `| ${g.grantPeriod} | ${mdName(g)} | ${g.organization} | ${g.applicationDeadline} | ${g.memo} |`,
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
  lines.push("| 助成金名 | 助成元 | 地域 | 締切・時期 | メモ |");
  lines.push("|---------|--------|------|-----------|------|");
  for (const g of sections.unknown) {
    lines.push(
      `| ${mdName(g)} | ${g.organization} | ${g.region} | ${g.applicationDeadline} | ${g.memo} |`,
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

/** 助成額（Markdown用）。資金以外は種別を【】で前置する */
function mdAmount(g: Grant): string {
  const amount = g.grantAmount || "要確認";
  return g.benefitType === "資金" || g.benefitType === "不明"
    ? amount
    : `【${g.benefitType}】${amount}`;
}

/**
 * 表のセルに入れる「対象事業」の保険（160字で切る）。
 * AI読み取り済みの行は短く要約されているが、ページが読めなかった行には
 * スクレイパーの生テキストが残るため、表が崩れるほど長い場合に備える。
 */
function cellText(text: string): string {
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
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
    .type-badge { background: #8e44ad; color: white; border-radius: 4px; padding: 1px 6px; font-size: 0.85em; margin-right: 4px; white-space: nowrap; display: inline-block; }
    .month-cell { min-width: 190px; }
    .month-strip { display: flex; gap: 1px; margin-bottom: 4px; }
    .month-strip .m { flex: 1; min-width: 13px; text-align: center; font-size: 0.72em; color: #aaa; background: #f0f0f0; border-radius: 2px; padding: 2px 0; }
    .month-strip .m-recruit { background: #f39c12; color: white; font-weight: bold; }
    .month-strip .m-period { box-shadow: inset 0 -3px 0 #27ae60; }
    .month-strip .m-now { outline: 2px solid #c0392b; outline-offset: -1px; }
    .strip-note { font-size: 0.85em; color: #888; }
    .memo-cell { min-width: 140px; }
    .memo-text { white-space: pre-wrap; }
    .memo-cell button { border: 1px solid #ddd; background: #fafafa; border-radius: 4px; cursor: pointer; padding: 2px 6px; margin-left: 2px; font-size: 1em; }
    .memo-cell button:hover { background: #eef2f7; }
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
      <thead><tr><th>助成金名</th><th>助成元</th><th>地域</th><th>対象事業</th><th>助成額</th><th>締切</th><th>人件費</th><th>謝金</th><th>家賃</th><th>メモ</th></tr></thead>
      <tbody>
`;
  for (const g of sections.open) {
    html += `        <tr>
          <td>${htmlName(g)}</td>
          <td>${escapeHtml(g.organization)}</td>
          <td><span class="region-tag">${escapeHtml(g.region)}</span></td>
          <td>${escapeHtml(cellText(g.targetProjects || "要確認"))}</td>
          <td>${htmlAmount(g)}</td>
          <td class="deadline">${escapeHtml(g.applicationDeadline)}</td>
          <td>${formatEligibility(g.personnelCosts)}</td>
          <td>${formatEligibility(g.honorarium)}</td>
          <td>${formatEligibility(g.rent)}</td>
          ${memoCell(g)}
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
      <thead><tr><th>助成金名</th><th>助成元</th><th>地域</th><th>例年の募集時期（■=募集月 / 緑線=助成期間 / 赤枠=今月）</th><th>助成額</th><th>人件費</th><th>謝金</th><th>家賃</th><th>メモ</th></tr></thead>
      <tbody>
`;
  for (const g of sections.upcoming) {
    html += `        <tr>
          <td>${htmlName(g)}</td>
          <td>${escapeHtml(g.organization)}</td>
          <td><span class="region-tag">${escapeHtml(g.region)}</span></td>
          <td class="month-cell">${monthStrip(g)}<span class="strip-note">${escapeHtml(g.expectedPeriod || "要確認")}</span></td>
          <td>${htmlAmount(g)}</td>
          <td>${formatEligibility(g.personnelCosts)}</td>
          <td>${formatEligibility(g.honorarium)}</td>
          <td>${formatEligibility(g.rent)}</td>
          ${memoCell(g)}
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
      <thead><tr><th>発見日</th><th>タイトル</th><th>配信元</th><th>締切</th><th>メモ</th></tr></thead>
      <tbody>
`;
  for (const g of sections.discovered) {
    html += `        <tr>
          <td>${escapeHtml(g.grantPeriod)}</td>
          <td>${htmlName(g)}</td>
          <td>${escapeHtml(g.organization)}</td>
          <td>${escapeHtml(g.applicationDeadline)}</td>
          ${memoCell(g)}
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
      <thead><tr><th>助成金名</th><th>助成元</th><th>地域</th><th>締切・時期</th><th>メモ</th></tr></thead>
      <tbody>
`;
  for (const g of sections.unknown) {
    html += `        <tr>
          <td>${htmlName(g)}</td>
          <td>${escapeHtml(g.organization)}</td>
          <td><span class="region-tag">${escapeHtml(g.region)}</span></td>
          <td>${escapeHtml(g.applicationDeadline)}</td>
          ${memoCell(g)}
        </tr>\n`;
  }
  html += `      </tbody>
    </table>

    <div class="footer">
      <p>凡例: 🟢今応募できる ／ 🟡発表待ち（例年時期を表示） ／ 🔎ウェブから自動発見（要確認） ／ ⚪状態不明</p>
      <p>メモ欄の ✏ で調べたことを書き残せます（再検索しても消えません）。📎 で募集要項のURL（PDF可）を登録すると、AIが読み取って詳細を埋めます。</p>
      <p>このレポートは自動収集した情報に基づいています。正確な情報は各助成金の公式サイトでご確認ください。</p>
      <p>生成日時: ${dayjs().format("YYYY-MM-DD HH:mm:ss")}</p>
    </div>
  </div>
  <script>
    document.addEventListener("click", async (ev) => {
      const btn = ev.target.closest("button");
      if (!btn) return;
      const cell = btn.closest(".memo-cell");
      if (!cell) return;
      const id = cell.dataset.id;

      if (btn.classList.contains("memo-btn")) {
        const current = cell.querySelector(".memo-text").textContent;
        const memo = prompt("メモ（調べて分かったこと。再検索しても消えません）", current);
        if (memo === null) return;
        try {
          const res = await fetch("memo", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id, memo }),
          });
          if (res.ok) {
            cell.querySelector(".memo-text").textContent = memo;
          } else {
            alert("メモの保存に失敗しました");
          }
        } catch {
          alert("通信に失敗しました（このページはサーバー経由で開いてください）");
        }
      }

      if (btn.classList.contains("url-btn")) {
        const url = prompt("募集要項のURL（PDF可）を入力すると、AIが読み取って締切・経費可否などを埋めます");
        if (!url) return;
        btn.textContent = "⏳";
        btn.disabled = true;
        try {
          const res = await fetch("manual-url", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id, url }),
          });
          const data = await res.json().catch(() => ({}));
          alert(data.message || (res.ok ? "読み取りました" : "失敗しました"));
          if (res.ok) location.reload();
        } catch {
          alert("通信に失敗しました（このページはサーバー経由で開いてください）");
        }
        btn.textContent = "📎";
        btn.disabled = false;
      }
    });
  </script>
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

/** 助成額セル（HTML用）。資金以外は種別バッジを前置する */
function htmlAmount(g: Grant): string {
  const badge =
    g.benefitType === "資金" || g.benefitType === "不明"
      ? ""
      : `<span class="type-badge">${escapeHtml(g.benefitType)}</span>`;
  return `${badge}${escapeHtml(g.grantAmount || "要確認")}`;
}

/** メモセル（✏=メモ編集・📎=募集要項URL登録。scriptが拾って処理する） */
function memoCell(g: Grant): string {
  return `<td class="memo-cell" data-id="${escapeHtml(g.id)}"><span class="memo-text">${escapeHtml(g.memo)}</span> <button type="button" class="memo-btn" title="メモを編集">✏</button><button type="button" class="url-btn" title="募集要項URLを登録してAIに読み取らせる">📎</button></td>`;
}

/**
 * 12ヶ月の帯。募集月をオレンジで塗り、助成期間（読めた場合のみ）を緑の下線、
 * 今月を赤枠で示す。募集月が読み取れない場合は帯を出さない。
 */
function monthStrip(g: Grant): string {
  const recruit = parseRecruitMonths(g.expectedPeriod);
  if (recruit.size === 0) return "";
  const period = parseGrantPeriodMonths(g.grantPeriod);
  const currentMonth = new Date().getMonth() + 1;

  let cells = "";
  for (let m = 1; m <= 12; m++) {
    const classes = ["m"];
    if (recruit.has(m)) classes.push("m-recruit");
    if (period?.has(m)) classes.push("m-period");
    if (m === currentMonth) classes.push("m-now");
    cells += `<span class="${classes.join(" ")}">${m}</span>`;
  }
  return `<div class="month-strip">${cells}</div>`;
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

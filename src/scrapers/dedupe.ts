import { Grant } from "../models/grant";

/**
 * 同じ助成金を指す複数の行を1行にまとめるための補助
 *
 * - 文字列規則による同一判定（`isSameByRules`、`dedupeAcrossSources`）
 * - 代表行の選び方（`representativeScore`）
 * - 捨てる側の新しい回の情報を代表に取り込む（`adoptNewerRound`）
 *
 * AI照合（`enrich/ai-matcher.ts`）が使えるときは、文字列規則は候補の絞り込みに
 * だけ使い、最終判断はAIが行う。APIキー未設定時は `dedupeAcrossSources` が
 * これまでどおり文字列規則だけでまとめる。
 */

/** 法人格の表記（団体名の比較時に無視する） */
export const LEGAL_FORMS =
  /公益財団法人|一般財団法人|公益社団法人|一般社団法人|社会福祉法人|特定非営利活動法人|認定NPO法人|NPO法人|株式会社/g;

/**
 * 団体名の正規化（空白・法人格を除去）。
 * 名前側の normalizeName と表記を揃えるため、「こども→子ども」もここで統一する
 * （揃っていないと isGenericName の団体名除去が失敗する）
 */
export function normalizeOrgName(org: string): string {
  return org
    .replace(/[\s　]/g, "")
    .replace(LEGAL_FORMS, "")
    .replace(/こども/g, "子ども");
}

/** 助成金名の正規化（括弧・空白・年度・回数・「募集」を除く） */
export function normalizeName(name: string): string {
  return name
    .replace(/[【】「」『』（）()《》\s　・＆&×／/]/g, "")
    .replace(/こども/g, "子ども")
    .replace(/20\d{2}\s*年度?|令和\d+\s*年度?/g, "")
    .replace(/第\s*\d+\s*[回期次]/g, "")
    .replace(/募集|公募/g, "")
    .replace(/[-‐－―…]+$/g, "");
}

/** 締切テキスト中の最後の日付（年付きのみ）を返す */
export function lastDeadlineDate(text: string): Date | null {
  const matches = [
    ...text.matchAll(/(?:令和(\d+)年|(\d{4})年)(\d{1,2})月(\d{1,2})日/g),
  ];
  if (matches.length === 0) return null;
  const m = matches[matches.length - 1];
  const year = m[1] ? 2018 + parseInt(m[1]) : parseInt(m[2]);
  return new Date(year, parseInt(m[3]) - 1, parseInt(m[4]));
}

/** 2つの文字列の最長共通部分文字列の長さ */
export function longestCommonSubstring(a: string, b: string): number {
  if (!a || !b) return 0;
  let best = 0;
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best) best = cur[j];
      }
    }
    prev = cur;
  }
  return best;
}

/**
 * 助成金名が「〇〇財団助成金」のような、団体名＋一般語だけの汎用タイトルか。
 * （プログラム固有の名前を持たない側だけを、団体・締切・金額での同一視の対象にする。
 * 同じ財団が同じ締切・同じ金額で複数プログラムを同時募集することがあるため、
 * 固有名同士は名前の類似だけで判定する）
 */
function isGenericName(norm: string, orgNorm: string): boolean {
  const stripped = norm
    .replace(LEGAL_FORMS, "")
    .split(orgNorm)
    .join("")
    .replace(/助成金|助成事業|助成プログラム|助成|補助金|支援金|基金|事業/g, "");
  return stripped.length <= 2;
}

/**
 * 文字列規則による同一判定。
 * - 正規化した名前の片方がもう片方を含む（8文字以上）、または13文字以上の共通部分
 * - 名前が違っても、同じ団体で片方が汎用タイトルなら、同じ締切日＋同じ助成額
 *   （または両方「随時」）で同一とみなす
 */
export function isSameByRules(a: Grant, b: Grant): boolean {
  const na = normalizeName(a.name);
  const nb = normalizeName(b.name);
  const shorter = na.length <= nb.length ? na : nb;
  if (shorter.length >= 8 && (na.includes(nb) || nb.includes(na))) return true;
  if (longestCommonSubstring(na, nb) >= 13) return true;

  const oa = normalizeOrgName(a.organization);
  const ob = normalizeOrgName(b.organization);
  if (
    oa.length >= 4 &&
    ob.length >= 4 &&
    (oa.includes(ob) || ob.includes(oa)) &&
    (isGenericName(na, oa) || isGenericName(nb, ob))
  ) {
    const blankAmount = (v: string) => !v || v === "要確認" || v === "不明";
    const amountA = a.grantAmount.replace(/[\s　]/g, "");
    const amountB = b.grantAmount.replace(/[\s　]/g, "");
    // 同じ締切日＋同じ助成額なら同一
    if (!blankAmount(amountA) && amountA === amountB) {
      const da = lastDeadlineDate(a.applicationDeadline);
      const db = lastDeadlineDate(b.applicationDeadline);
      if (da && db && da.getTime() === db.getTime()) return true;
    }
    // 両方「随時」受付なら締切日が無いので、金額が矛盾しない限り同一とみなす
    if (
      /随時/.test(a.applicationDeadline) &&
      /随時/.test(b.applicationDeadline) &&
      (amountA === amountB || blankAmount(amountA) || blankAmount(amountB))
    )
      return true;
  }
  return false;
}

/**
 * どの行を代表として残すか（大きいほど優先）。人間の入力（👍・📎・メモ）の
 * 付いた行と、定番リスト（id・名前が手書きで安定）の行、前回までにDBにあった行
 * （idを維持したい）を代表として残す。新しい回の情報は adoptNewerRound で
 * 代表に取り込むので、募集中かどうかは代表選びでは二の次でよい
 */
export function representativeScore(
  g: Grant,
  storedIds?: Set<string>,
): number {
  return (
    (g.humanJudgment === "関係あり" ? 200 : 0) +
    (g.source === "known" ? 150 : 0) +
    (g.manualUrl ? 60 : 0) +
    (g.memo ? 30 : 0) +
    (storedIds?.has(g.id) ? 80 : 0) +
    (g.status === "募集中" ? 100 : 0) +
    (g.expectedPeriod.includes("発表済み") ? 50 : 0) +
    (g.expectedPeriod.includes("昨年実績") ||
    g.expectedPeriod.includes("前回")
      ? 20
      : 0) +
    (g.targetProjects ? 10 : 0) +
    (g.grantAmount !== "要確認" ? 5 : 0)
  );
}

/** 回の日付（募集中なら締切、それ以外は前回の募集期間の最後の年付き日付） */
export function roundDate(g: Grant): Date | null {
  if (g.status === "募集中") return lastDeadlineDate(g.applicationDeadline);
  return (
    lastDeadlineDate(g.expectedPeriod) ??
    lastDeadlineDate(g.applicationDeadline)
  );
}

const blank = (v: string) =>
  !v || v === "要確認" || v === "不明" || v.startsWith("要確認");

/**
 * 捨てる側（folded）が残す側（kept）より新しい回なら、回の情報を kept に取り込む。
 * 取り込むのは状態・締切・前回期間・URL・名前と、kept が空の詳細項目。
 * id・情報源は変えない。取り込んだら true。
 * 人間の入力（メモ・手動URL・判定）は、kept に無く folded にあるときだけ写す
 * （2行に分かれていた間に片方へ付けた入力を失わないため）。
 */
export function adoptNewerRound(kept: Grant, folded: Grant): boolean {
  // 人間の入力の引き継ぎ（回の新旧に関係なく行う）
  if (!kept.memo && folded.memo) kept.memo = folded.memo;
  if (!kept.manualUrl && folded.manualUrl) kept.manualUrl = folded.manualUrl;
  if (!kept.humanJudgment && folded.humanJudgment === "関係あり")
    kept.humanJudgment = "関係あり";
  // 別名の引き継ぎ（folded の名前と、folded が持っていた別名）
  addAlias(kept, folded);

  const keptOpen = kept.status === "募集中";
  const foldedOpen = folded.status === "募集中";
  const keptDate = roundDate(kept);
  const foldedDate = roundDate(folded);
  const newer =
    (foldedOpen && !keptOpen) ||
    (foldedOpen === keptOpen &&
      foldedDate !== null &&
      (keptDate === null || foldedDate > keptDate));
  if (!newer) {
    // 古い回でも、kept が空の詳細項目は埋める
    fillBlanks(kept, folded);
    return false;
  }

  kept.status = folded.status;
  kept.applicationDeadline = folded.applicationDeadline;
  if (folded.expectedPeriod) kept.expectedPeriod = folded.expectedPeriod;
  if (folded.url) kept.url = folded.url;
  // 定番・手動登録の名前は人が付けた安定名なので変えない
  if (kept.source !== "known" && kept.source !== "manual") {
    kept.name = folded.name;
  }
  fillBlanks(kept, folded);
  return true;
}

function fillBlanks(kept: Grant, folded: Grant): void {
  if (blank(kept.grantAmount) && !blank(folded.grantAmount))
    kept.grantAmount = folded.grantAmount;
  if (blank(kept.grantPeriod) && !blank(folded.grantPeriod))
    kept.grantPeriod = folded.grantPeriod;
  if (blank(kept.targetProjects) && !blank(folded.targetProjects))
    kept.targetProjects = folded.targetProjects;
}

/** folded の名前・id と、folded が持つ別名を kept の別名一覧に加える（重複なし） */
export function addAlias(kept: Grant, folded: Grant): void {
  const entries = [
    { name: folded.name, organization: folded.organization, id: folded.id },
    ...folded.aliases,
  ];
  for (const e of entries) {
    if (e.id === kept.id) continue;
    if (kept.aliases.some((a) => a.id === e.id || a.name === e.name)) continue;
    kept.aliases.push(e);
  }
}

/**
 * 文字列規則だけで同一助成金をまとめる（AI照合が使えないときの経路）。
 * 代表は representativeScore が高い行。捨てる側の新しい回の情報は代表に取り込む。
 *
 * protectedIds を渡すと、畳まれた側に定番カタログ（known）や「関係あり」判定が
 * 含まれていた場合に、残った代表のIDを追加する（保護の引き継ぎ）。
 * onMerge を渡すと、まとめた組ごとに呼ぶ（記録用）。
 */
export function dedupeAcrossSources(
  grants: Grant[],
  protectedIds?: Set<string>,
  storedIds?: Set<string>,
  onMerge?: (kept: Grant, folded: Grant, adopted: boolean) => void,
): Grant[] {
  const isProtected = (g: Grant): boolean =>
    g.source === "known" || g.humanJudgment === "関係あり";
  const kept: Grant[] = [];

  const sorted = grants
    .slice()
    .sort(
      (a, b) =>
        representativeScore(b, storedIds) - representativeScore(a, storedIds),
    );
  for (const grant of sorted) {
    const dupOf = kept.find((k) => isSameByRules(k, grant));
    if (!dupOf) {
      kept.push(grant);
      if (isProtected(grant)) protectedIds?.add(grant.id);
      continue;
    }
    if (isProtected(grant)) protectedIds?.add(dupOf.id);
    const keptName = dupOf.name.slice(0, 40);
    const adopted = adoptNewerRound(dupOf, grant);
    if (adopted) {
      console.log(
        `  ↻ 新しい回を取り込み: ${keptName} ← ${grant.name.slice(0, 40)}`,
      );
    }
    onMerge?.(dupOf, grant, adopted);
  }
  return kept;
}

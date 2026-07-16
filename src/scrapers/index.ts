import { BaseScraper } from "./base-scraper";
import { CanpanScraper } from "./canpan-scraper";
import { AichiVcScraper } from "./aichi-vc-scraper";
import { NagakuteScraper } from "./nagakute-scraper";
import { MusubieScraper } from "./musubie-scraper";
import { WamScraper } from "./wam-scraper";
import { ShimisenScraper } from "./shimisen-scraper";
import { AkaihaneScraper } from "./akaihane-scraper";
import { AkaihaneAichiScraper } from "./akaihane-aichi-scraper";
import { NewsDiscoveryScraper } from "./news-discovery-scraper";
import { getKnownGrants } from "./known-grants";
import { checkKnownGrants, checkGrantsOpening } from "./known-grants-checker";
import { Grant, EXCLUDE_KEYWORDS } from "../models/grant";
import {
  getDatabase,
  upsertGrants,
  logSearch,
  getAllGrants,
  hideGrantsNotIn,
} from "../models/database";
import { enrichGrants } from "../enrich/ai-enricher";

/** 全スクレイパーの一覧 */
function getAllScrapers(): BaseScraper[] {
  return [
    new CanpanScraper(),
    new MusubieScraper(),
    new WamScraper(),
    new AichiVcScraper(),
    new NagakuteScraper(),
    new ShimisenScraper(),
    new AkaihaneScraper(),
    new AkaihaneAichiScraper(),
    new NewsDiscoveryScraper(),
  ];
}

/** 全ソースから助成金情報を収集 */
export async function searchAllSources(): Promise<Grant[]> {
  const db = getDatabase();
  const allGrants: Grant[] = [];

  // 1. 定番リストの読み込み＋公式ページとの突き合わせ（募集検知で自動昇格）
  console.log("📋 定番助成金リストを確認中（各公式ページをチェック）...");
  const knownGrants = await checkKnownGrants();
  allGrants.push(...knownGrants);
  upsertGrants(db, knownGrants);
  logSearch(db, "known", knownGrants.length);
  const openCount = knownGrants.filter((g) => g.status === "募集中").length;
  console.log(
    `  → ${knownGrants.length}件の定番助成金を登録（うち募集検知 ${openCount}件）`,
  );

  // 2. 各Webスクレイパーの実行
  const scrapers = getAllScrapers();

  for (const scraper of scrapers) {
    const scraperName = scraper.constructor.name;
    console.log(`\n🔍 ${scraperName} を実行中...`);

    try {
      const grants = await scraper.search();
      allGrants.push(...grants);
      upsertGrants(db, grants);
      logSearch(db, scraperName, grants.length);
      if (grants.length === 0) {
        // 0件は「該当なし」ではなく解析不全の可能性が高いため、警告として記録する
        console.warn(
          `  ⚠ ${scraperName}: 0件（ページ構成の変化による解析不全の可能性あり）`,
        );
        logSearch(db, scraperName, 0, "抽出0件（要確認）");
      } else {
        console.log(`  → ${grants.length}件の助成金情報を取得`);
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`  ✗ ${scraperName} でエラー: ${errorMsg}`);
      logSearch(db, scraperName, 0, errorMsg);
    }
  }

  // IDで重複を除去
  const uniqueGrants = new Map<string, Grant>();
  for (const grant of allGrants) {
    uniqueGrants.set(grant.id, grant);
  }

  // 複数の情報源が同じ助成金を載せていることがあるため、名前ベースでも重複を畳む。
  // 定番・「関係あり」が畳まれた場合は、残った代表がAI除外からの保護を引き継ぐ
  const protectedIds = new Set<string>();
  const deduped = dedupeAcrossSources(
    Array.from(uniqueGrants.values()),
    protectedIds,
  );

  // 活動分野外（被災地・災害支援など）は掲載しない
  const inScope = deduped.filter((g) => {
    const text = g.name + g.targetProjects;
    const hit = EXCLUDE_KEYWORDS.find((kw) => text.includes(kw));
    if (hit)
      console.log(`  ✗ 分野外のため除外: ${g.name.slice(0, 40)}（${hit}）`);
    return !hit;
  });

  // DBに保存済みの人間の入力（メモ・手動登録URL・判定）を取り込む
  // （スクレイパーが作った Grant は毎回空で始まるため。manualUrl はAI読み取りで使う）
  const stored = new Map(getAllGrants(db).map((g) => [g.id, g]));
  for (const g of inScope) {
    const s = stored.get(g.id);
    if (s) {
      g.memo = s.memo;
      g.manualUrl = s.manualUrl;
      g.humanJudgment = s.humanJudgment;
    }
  }

  // 「関係あり」判定済みの助成金は、今回のスクレイプに現れなくても消さない
  // （記事が古くなって発掘元から消えても、定番と同じように追い続ける）
  for (const s of stored.values()) {
    if (s.humanJudgment === "関係あり" && !inScope.some((g) => g.id === s.id)) {
      inScope.push(s);
    }
  }

  // 「関係ない」判定済みはここで除外（AI読み取りの枠も使わない）。
  // 行自体はDBに残り、レポート下部の折りたたみに表示される。
  const withoutDismissed = inScope.filter((g) => {
    if (g.humanJudgment === "関係ない") {
      console.log(`  ✗ 人間の判定（関係ない）: ${g.name.slice(0, 40)}`);
      return false;
    }
    return true;
  });

  // 「関係あり」の発掘品は定番リストと同じロジックで公式ページをチェックし、
  // 募集開始を検知したら「募集中」へ昇格させる
  const relevantOnes = withoutDismissed.filter(
    (g) => g.humanJudgment === "関係あり" && g.status !== "募集中",
  );
  if (relevantOnes.length > 0) {
    console.log(
      `\n👍 「関係あり」判定の ${relevantOnes.length}件の公式ページをチェック中...`,
    );
    const checked = await checkGrantsOpening(relevantOnes);
    for (const c of checked) {
      const idx = withoutDismissed.findIndex((g) => g.id === c.id);
      if (idx >= 0) withoutDismissed[idx] = c;
    }
  }

  // 人間の判定履歴（関係あり/関係ないの助成金名）をAIの判断材料として渡す
  const judgmentExamples = {
    relevant: Array.from(stored.values())
      .filter((g) => g.humanJudgment === "関係あり")
      .map((g) => g.name),
    irrelevant: Array.from(stored.values())
      .filter((g) => g.humanJudgment === "関係ない")
      .map((g) => g.name),
  };

  // 各助成金の公式ページを読み、詳細情報（対象団体・助成額・経費可否）を充填。
  // 応募対象外と判断されたものはここで除外される（保護IDは除外されない）。
  const result = await enrichGrants(
    withoutDismissed,
    judgmentExamples,
    protectedIds,
  );
  const statusCounts = {
    募集中: result.filter((g) => g.status === "募集中").length,
    募集前: result.filter((g) => g.status === "募集前").length,
  };
  console.log(
    `\n✅ 合計: ${result.length}件（募集中 ${statusCounts.募集中}件 / 募集予定 ${statusCounts.募集前}件）`,
  );

  // 最終リストをDBに反映する（DBが正本。レポートは常にDBから生成する）。
  // リストに入らなかった行（重複・対象外・古い行）は非表示にする。
  upsertGrants(db, result);
  hideGrantsNotIn(
    db,
    result.map((g) => g.id),
  );
  db.close();

  return result;
}

/**
 * 情報源をまたいだ重複の畳み込み。
 * 正規化した名前の包含関係（例:「子どもぬくもり基金」⊂「日本フィランソロピック財団
 * 第4回 子どもぬくもり基金」）で同一助成金とみなし、情報の充実したほうを残す。
 *
 * protectedIds を渡すと、畳まれた側に定番カタログ（known）や「関係あり」判定が
 * 含まれていた場合に、残った代表のIDを追加する（保護の引き継ぎ）。
 * 代表が保護を引き継がないと、定番助成金でも「別ソースの記事が代表になる→
 * その記事をAIが誤読して対象外→一族まるごと非表示」が起こる。
 */
export function dedupeAcrossSources(
  grants: Grant[],
  protectedIds?: Set<string>,
): Grant[] {
  const isProtected = (g: Grant): boolean =>
    g.source === "known" || g.humanJudgment === "関係あり";
  const normalize = (name: string): string =>
    name
      .replace(/[【】「」『』（）()《》\s　・＆&×／/]/g, "")
      .replace(/こども/g, "子ども")
      .replace(/20\d{2}\s*年度?|令和\d+\s*年度?/g, "")
      .replace(/第\s*\d+\s*[回期次]/g, "")
      .replace(/募集|公募/g, "")
      .replace(/[-‐－―…]+$/g, "");

  // 情報の充実度（大きいほど優先して残す）
  const score = (g: Grant): number =>
    (g.status === "募集中" ? 100 : 0) +
    (g.expectedPeriod.includes("発表済み") ? 50 : 0) +
    (g.expectedPeriod.includes("昨年実績") ? 20 : 0) +
    (g.source === "known" ? 15 : 0) +
    (g.targetProjects ? 10 : 0) +
    (g.grantAmount !== "要確認" ? 5 : 0);

  const kept: { grant: Grant; norm: string }[] = [];

  for (const grant of grants.slice().sort((a, b) => score(b) - score(a))) {
    const norm = normalize(grant.name);
    const dupOf = kept.find((k) => {
      const [a, b] = [k.norm, norm];
      const shorter = a.length <= b.length ? a : b;
      // 片方がもう片方を含む、または13文字以上の共通部分がある場合は同一助成金とみなす
      if (shorter.length >= 8 && (a.includes(b) || b.includes(a))) return true;
      return longestCommonSubstring(a, b) >= 13;
    });
    if (!dupOf) {
      kept.push({ grant, norm });
      if (isProtected(grant)) protectedIds?.add(grant.id);
    } else if (isProtected(grant)) {
      // 畳まれる側が定番・関係ありなら、残る代表に保護を引き継ぐ
      protectedIds?.add(dupOf.grant.id);
    }
  }

  return kept.map((k) => k.grant);
}

/** 2つの文字列の最長共通部分文字列の長さ */
function longestCommonSubstring(a: string, b: string): number {
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

export { getKnownGrants };

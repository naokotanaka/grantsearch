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
import { WatchSiteScraper } from "./watch-site-scraper";
import { getKnownGrants } from "./known-grants";
import { checkGrantsOpening } from "./known-grants-checker";
import {
  checkOpenings,
  createOpeningJudge,
} from "../enrich/ai-opening-checker";
import { Grant, EXCLUDE_KEYWORDS } from "../models/grant";
import {
  getDatabase,
  upsertGrants,
  logSearch,
  logMerges,
  getAllGrants,
  getWatchSites,
  hideGrantsNotIn,
  updateMemo,
  updateManualUrl,
  updateHumanJudgment,
} from "../models/database";
import { enrichGrants } from "../enrich/ai-enricher";
import { createAiJudge, matchPrograms } from "../enrich/ai-matcher";
import { lastDeadlineDate, normalizeOrgName } from "./dedupe";
import { isOtherMunicipality } from "./scope-rules";

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
  const runAt = new Date().toISOString();

  // 検索開始前のDBの状態を先に控えておく（人間の入力と、前回までにAI読み取りで
  // 埋めた詳細の引き継ぎ元）。DBへの書き込みは検索の最後に一括で行う。
  // 途中で素の値を upsert すると、この引き継ぎ元が消えてしまうため厳禁。
  const stored = new Map(getAllGrants(db).map((g) => [g.id, g]));

  // 1. 定番リストの読み込み（募集開始の検知は、まとめた後に全プログラム一括で行う）
  console.log("📋 定番助成金リストを読み込み中...");
  const knownGrants = getKnownGrants();
  allGrants.push(...knownGrants);
  logSearch(db, "known", knownGrants.length);
  console.log(`  → ${knownGrants.length}件の定番助成金を登録`);

  // 2. 各Webスクレイパーの実行（人間が登録した巡回サイトがあれば加える）
  const scrapers = getAllScrapers();
  const watchSites = getWatchSites(db);
  if (watchSites.length > 0) {
    console.log(`\n👀 巡回サイト ${watchSites.length}件を確認します`);
    scrapers.push(new WatchSiteScraper(watchSites));
  }

  for (const scraper of scrapers) {
    const scraperName = scraper.constructor.name;
    console.log(`\n🔍 ${scraperName} を実行中...`);

    try {
      const grants = await scraper.search();
      allGrants.push(...grants);
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

  // 「関係あり」判定済みの助成金は、今回のスクレイプに現れなくても消さない
  // （記事が古くなって発掘元から消えても、定番と同じように追い続ける）。
  // 名前ベースの畳み込みの前に候補へ加えることで、同じ助成金が別の名前で
  // 再発見されたときも2行にならず1行に畳まれる
  for (const s of stored.values()) {
    if (s.humanJudgment === "関係あり" && !uniqueGrants.has(s.id)) {
      // stored と同じオブジェクトを使うと、まとめる処理で引き継いだ人間の入力が
      // 「変更なし」と判定されてDBに書かれないため、複製して渡す
      uniqueGrants.set(s.id, { ...s, aliases: s.aliases.slice() });
    }
  }

  // DBに保存済みの人間の入力（メモ・手動登録URL・判定）を取り込む
  // （スクレイパーが作った Grant は毎回空で始まるため。manualUrl はAI読み取りで使う）。
  // 畳み込みの前に取り込むことで、👍・📎・メモの付いた行が代表として残る
  const isBlank = (v: string) =>
    !v || v === "要確認" || v === "不明" || v.startsWith("要確認");
  for (const g of uniqueGrants.values()) {
    const s = stored.get(g.id);
    if (s) {
      g.memo = s.memo;
      g.manualUrl = s.manualUrl;
      g.humanJudgment = s.humanJudgment;
      // 過去の検索でAI読み取り（ページ・募集要項PDF）が埋めた詳細は、今回の
      // スクレイプ値が空（要確認/不明）なら引き継ぐ。ページが一時的に読めない回が
      // あっても、一度読み取れた情報が検索のたびにリセットされないようにする。
      // （今回のAI読み取りが成功すれば applyExtraction が最新の内容で更新する）
      if (isBlank(g.grantAmount) && !isBlank(s.grantAmount))
        g.grantAmount = s.grantAmount;
      if (isBlank(g.grantPeriod) && !isBlank(s.grantPeriod))
        g.grantPeriod = s.grantPeriod;
      if (isBlank(g.applicationDeadline) && !isBlank(s.applicationDeadline))
        g.applicationDeadline = s.applicationDeadline;
      if (!g.expectedPeriod && s.expectedPeriod)
        g.expectedPeriod = s.expectedPeriod;
      // 対象事業は、過去のAI読み取り結果（【対象】等の要約付き）を
      // スクレイパーの定型文（「〇〇から自動発見」等）より優先する
      if (
        !isBlank(s.targetProjects) &&
        (isBlank(g.targetProjects) ||
          /【対象】|【要確認】/.test(s.targetProjects))
      )
        g.targetProjects = s.targetProjects;
      if (g.personnelCosts === "不明" && s.personnelCosts !== "不明")
        g.personnelCosts = s.personnelCosts;
      if (g.honorarium === "不明" && s.honorarium !== "不明")
        g.honorarium = s.honorarium;
      if (g.rent === "不明" && s.rent !== "不明") g.rent = s.rent;
      if (g.benefitType === "不明" && s.benefitType !== "不明")
        g.benefitType = s.benefitType;
    }
  }

  // 複数の情報源が同じ助成金を載せていることがあるため、プログラム単位で1行に
  // まとめる（別名一致 → 候補の絞り込み → AI判定。APIキーが無ければ文字列規則）。
  // 定番・「関係あり」がまとめられた場合は、残った代表がAI除外からの保護を引き継ぐ
  const protectedIds = new Set<string>();
  const matched = await matchPrograms(
    Array.from(uniqueGrants.values()),
    stored,
    protectedIds,
    createAiJudge(),
  );
  const deduped = matched.grants;
  if (matched.merges.length > 0) {
    console.log(`  → ${matched.merges.length}行を同じプログラムにまとめました`);
  }

  // 活動分野外（被災地・災害支援など）は掲載しない
  // （人間が「関係あり」と判定したものは除外しない）
  const inScope = deduped.filter((g) => {
    if (g.humanJudgment === "関係あり") return true;
    const text = g.name + g.targetProjects;
    const hit = EXCLUDE_KEYWORDS.find((kw) => text.includes(kw));
    if (hit) {
      console.log(`  ✗ 分野外のため除外: ${g.name.slice(0, 40)}（${hit}）`);
      return false;
    }
    // 長久手市以外の市区町村（役所・社協）の助成は、その市区町村の団体限定なので
    // 掲載しない（ページに書いていなくても。AIが「要確認」を返して残るのを防ぐ）
    if (isOtherMunicipality(g.organization)) {
      console.log(
        `  ✗ 他の市区町村の助成のため除外: ${g.name.slice(0, 40)}（${g.organization}）`,
      );
      return false;
    }
    return true;
  });

  // 「関係ない」判定済みはここで除外（AI読み取りの枠も使わない）。
  // 行自体はDBに残り、レポート下部の折りたたみに表示される。
  const withoutDismissed = inScope.filter((g) => {
    if (g.humanJudgment === "関係ない") {
      console.log(`  ✗ 人間の判定（関係ない）: ${g.name.slice(0, 40)}`);
      return false;
    }
    return true;
  });

  // 「関係あり」で募集中の行も、締切が過ぎていたら要確認へ戻す。
  // そうしないと（元ソースに再登場しない発掘品は）締切後も永久に
  // 「募集中」のままレポートに残り続ける
  const nowDate = new Date();
  for (const g of withoutDismissed) {
    if (g.humanJudgment !== "関係あり" || g.status !== "募集中") continue;
    const deadline = lastDeadlineDate(g.applicationDeadline);
    if (deadline && deadline < nowDate) {
      console.log(
        `  ⏳ 締切超過のため要確認へ: ${g.name.slice(0, 40)}（${g.applicationDeadline.slice(0, 30)}）`,
      );
      g.status = "不明";
      g.applicationDeadline = "要確認";
    }
  }

  // 募集前（募集予定）の全プログラムと、👍で募集中でない行の公式ページを読み、
  // 新しい回の募集を検知したら「募集中」へ昇格させる。
  // AIが使えれば ai-opening-checker（公式ページ＋1段上のページ＋Web検索を
  // Claude が判定）、使えなければ従来の正規表現検知（定番・👍のみ）
  const openingJudge = createOpeningJudge();
  const toCheck = withoutDismissed.filter(
    (g) =>
      g.status === "募集前" ||
      (g.humanJudgment === "関係あり" && g.status !== "募集中"),
  );
  if (toCheck.length > 0) {
    let checked: Grant[];
    if (openingJudge) {
      console.log(
        `\n🔔 募集前 ${toCheck.length}件の公式ページをAIで確認中（新しい回の募集が出ていないか）...`,
      );
      const outcome = await checkOpenings(toCheck, { judge: openingJudge });
      checked = outcome.grants;
      console.log(
        `  → 募集検知 ${outcome.stats.promoted}件（ページ取得 ${outcome.stats.fetches}回・Web検索 ${outcome.stats.searches}回）`,
      );
      logSearch(db, "opening-check", outcome.stats.promoted);
    } else {
      const targets = toCheck.filter(
        (g) => g.source === "known" || g.humanJudgment === "関係あり",
      );
      console.log(
        `\n👍 定番・「関係あり」の ${targets.length}件の公式ページをチェック中（正規表現）...`,
      );
      checked = await checkGrantsOpening(targets);
    }
    for (const c of checked) {
      const idx = withoutDismissed.findIndex((g) => g.id === c.id);
      if (idx >= 0) withoutDismissed[idx] = c;
    }
  }

  // 人間の判定履歴（関係あり/関係ないの助成金名）をAIの判断材料として渡す。
  // 同じ団体に「関係あり」と「関係ない」が混在する場合（別名の重複行や旧事業名の
  // 行を👎で消した場合など）は、内容として関係ある系統を「関係ない」と誤学習
  // させないため、「関係ない」側の例からは外す
  const relevantOrgs = new Set(
    Array.from(stored.values())
      .filter((g) => g.humanJudgment === "関係あり")
      .map((g) => normalizeOrgName(g.organization)),
  );
  const judgmentExamples = {
    relevant: Array.from(stored.values())
      .filter((g) => g.humanJudgment === "関係あり")
      .map((g) => g.name),
    irrelevant: Array.from(stored.values())
      .filter(
        (g) =>
          g.humanJudgment === "関係ない" &&
          !relevantOrgs.has(normalizeOrgName(g.organization)),
      )
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
  // まとめる処理で別の行から引き継いだ人間の入力（メモ・手動URL・👍）は、
  // upsert では更新されない（人間の入力を守るため）ので、専用の関数で書き込む
  for (const g of result) {
    const s = stored.get(g.id);
    if (!s) continue;
    if (g.memo !== s.memo) updateMemo(db, g.id, g.memo);
    if (g.manualUrl !== s.manualUrl) updateManualUrl(db, g.id, g.manualUrl);
    if (g.humanJudgment !== s.humanJudgment)
      updateHumanJudgment(db, g.id, g.humanJudgment);
  }
  hideGrantsNotIn(
    db,
    result.map((g) => g.id),
  );
  logMerges(db, runAt, matched.merges);
  db.close();

  return result;
}

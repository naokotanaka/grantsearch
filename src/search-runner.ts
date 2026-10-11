import { searchAllSources } from "./scrapers";
import { generateAllReports } from "./reports/report-generator";
import { runSupporterTrace, TRACE_LABEL } from "./enrich/supporter-trace";

/**
 * 検索実行の一元管理。
 * Webサーバー（手動実行）と週次スケジューラ（自動実行）の両方がここを通ることで、
 * 同時に2つの検索が走ることを防ぐ。状態はプロセス内メモリで持つ。
 * 支援元サーチ（木曜）も同じ実行中フラグを使い、検索と同時には動かさない。
 */

export interface LastResult {
  finishedAt: string;
  status: "完了" | "エラー";
  message: string;
  count?: number;
}

export interface SearchState {
  running: boolean;
  /** 実行中の仕事（「検索」または支援元サーチ）。止まっていれば null */
  job: string | null;
  startedAt: string | null;
  last: LastResult | null;
}

const SEARCH_JOB = "検索";

const state: SearchState = {
  running: false,
  job: null,
  startedAt: null,
  last: null,
};

export function getSearchState(): SearchState {
  return state;
}

/** 実行中でなければ仕事をバックグラウンドで始める。始められたら true */
function startJob(
  job: string,
  trigger: string,
  run: () => Promise<void>,
): boolean {
  if (state.running) {
    console.log(
      `⏭ ${state.job}を実行中のため、${job}をスキップします（要求元: ${trigger}）`,
    );
    return false;
  }

  state.running = true;
  state.job = job;
  state.startedAt = new Date().toISOString();
  console.log(`\n🔎 ${job}を開始します（要求元: ${trigger}）`);

  void (async () => {
    try {
      await run();
    } finally {
      state.running = false;
      state.job = null;
      state.startedAt = null;
    }
  })();

  return true;
}

/**
 * 検索をバックグラウンドで開始する。
 * @returns 開始できたら true、すでに実行中なら false
 */
export function startSearch(trigger: string): boolean {
  return startJob(SEARCH_JOB, trigger, async () => {
    try {
      const grants = await searchAllSources();
      generateAllReports();
      state.last = {
        finishedAt: new Date().toISOString(),
        status: "完了",
        message: `${grants.length}件の助成金情報を取得しました`,
        count: grants.length,
      };
      console.log(`✅ 検索が完了しました（${grants.length}件）`);
    } catch (error) {
      state.last = {
        finishedAt: new Date().toISOString(),
        status: "エラー",
        message: error instanceof Error ? error.message : "不明なエラー",
      };
      console.error("❌ 検索でエラーが発生しました:", error);
    }
  });
}

/**
 * 支援元サーチをバックグラウンドで開始する（結果はDBの trace_runs に残る）。
 * @returns 開始できたら true、すでに実行中なら false
 */
export function startTrace(trigger: string): boolean {
  return startJob(TRACE_LABEL, trigger, async () => {
    try {
      await runSupporterTrace();
      console.log(`✅ ${TRACE_LABEL}が完了しました`);
    } catch (error) {
      console.error(`❌ ${TRACE_LABEL}でエラーが発生しました:`, error);
    }
  });
}

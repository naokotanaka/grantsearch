import { searchAllSources } from "./scrapers";
import { generateAllReports } from "./reports/report-generator";

/**
 * 検索実行の一元管理。
 * Webサーバー（手動実行）と週次スケジューラ（自動実行）の両方がここを通ることで、
 * 同時に2つの検索が走ることを防ぐ。状態はプロセス内メモリで持つ。
 */

export interface LastResult {
  finishedAt: string;
  status: "完了" | "エラー";
  message: string;
  count?: number;
}

export interface SearchState {
  running: boolean;
  startedAt: string | null;
  last: LastResult | null;
}

const state: SearchState = {
  running: false,
  startedAt: null,
  last: null,
};

export function getSearchState(): SearchState {
  return state;
}

/**
 * 検索をバックグラウンドで開始する。
 * @returns 開始できたら true、すでに実行中なら false
 */
export function startSearch(trigger: string): boolean {
  if (state.running) {
    console.log(`⏭ 検索は実行中のためスキップします（要求元: ${trigger}）`);
    return false;
  }

  state.running = true;
  state.startedAt = new Date().toISOString();
  console.log(`\n🔎 検索を開始します（要求元: ${trigger}）`);

  void (async () => {
    try {
      const grants = await searchAllSources();
      generateAllReports(grants);
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
    } finally {
      state.running = false;
      state.startedAt = null;
    }
  })();

  return true;
}

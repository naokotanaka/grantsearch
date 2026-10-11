import cron from "node-cron";
import { startSearch, startTrace } from "./search-runner";
import { TRACE_LABEL } from "./enrich/supporter-trace";

/** 支援元サーチの実行日時（毎週木曜 9:00。月曜の検索とは別の日に動かす） */
const TRACE_SCHEDULE = "0 9 * * 4";

/**
 * 定期実行スケジューラー
 * デフォルト: 毎週月曜日 9:00（日本時間）に検索、毎週木曜日 9:00 に支援元サーチ
 * 検索の実行は search-runner に一元化されているため、
 * 手動実行（ダッシュボード）と重なった場合は自動的にスキップされる。
 */
export function startScheduler(cronExpression?: string): cron.ScheduledTask {
  const schedule = cronExpression ?? "0 9 * * 1"; // 毎週月曜 9:00

  console.log("⏰ 定期検索スケジューラーを開始します");
  console.log(`   スケジュール: ${schedule}（日本時間）`);
  console.log(`   (デフォルト: 毎週月曜日 9:00)`);
  console.log(`   ${TRACE_LABEL}: ${TRACE_SCHEDULE}（毎週木曜日 9:00）`);

  const task = cron.schedule(
    schedule,
    () => {
      console.log(
        `\n🕐 定期検索のタイミングになりました [${new Date().toLocaleString("ja-JP")}]`,
      );
      startSearch("週次スケジューラ");
    },
    { timezone: "Asia/Tokyo" },
  );

  const traceTask = cron.schedule(
    TRACE_SCHEDULE,
    () => {
      console.log(
        `\n🕐 ${TRACE_LABEL}のタイミングになりました [${new Date().toLocaleString("ja-JP")}]`,
      );
      startTrace("週次スケジューラ");
    },
    { timezone: "Asia/Tokyo" },
  );

  task.start();
  traceTask.start();

  // プロセス終了時のクリーンアップ
  process.on("SIGINT", () => {
    console.log("\n⏹ スケジューラーを停止します");
    task.stop();
    traceTask.stop();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    task.stop();
    traceTask.stop();
    process.exit(0);
  });

  return task;
}

import cron from "node-cron";
import { startSearch } from "./search-runner";

/**
 * 定期実行スケジューラー
 * デフォルト: 毎週月曜日 9:00（日本時間）に実行
 * 検索の実行は search-runner に一元化されているため、
 * 手動実行（ダッシュボード）と重なった場合は自動的にスキップされる。
 */
export function startScheduler(cronExpression?: string): cron.ScheduledTask {
  const schedule = cronExpression ?? "0 9 * * 1"; // 毎週月曜 9:00

  console.log("⏰ 定期検索スケジューラーを開始します");
  console.log(`   スケジュール: ${schedule}（日本時間）`);
  console.log(`   (デフォルト: 毎週月曜日 9:00)`);

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

  task.start();

  // プロセス終了時のクリーンアップ
  process.on("SIGINT", () => {
    console.log("\n⏹ スケジューラーを停止します");
    task.stop();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    task.stop();
    process.exit(0);
  });

  return task;
}

import cron from 'node-cron';
import { searchAllSources } from './scrapers';
import { generateAllReports } from './reports/report-generator';

/**
 * 定期実行スケジューラー
 * デフォルト: 毎週月曜日 9:00 に実行
 */
export function startScheduler(cronExpression?: string): void {
  const schedule = cronExpression ?? '0 9 * * 1'; // 毎週月曜 9:00

  console.log('⏰ 定期検索スケジューラーを開始します');
  console.log(`   スケジュール: ${schedule}`);
  console.log(`   (デフォルト: 毎週月曜日 9:00)`);
  console.log('   Ctrl+C で停止\n');

  const task = cron.schedule(schedule, async () => {
    console.log(`\n🕐 定期検索を開始 [${new Date().toLocaleString('ja-JP')}]`);

    try {
      const grants = await searchAllSources();
      generateAllReports(grants);
      console.log(`✅ 定期検索が完了しました [${new Date().toLocaleString('ja-JP')}]\n`);
    } catch (error) {
      console.error('❌ 定期検索でエラーが発生しました:', error);
    }
  });

  task.start();

  // プロセス終了時のクリーンアップ
  process.on('SIGINT', () => {
    console.log('\n⏹ スケジューラーを停止します');
    task.stop();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    task.stop();
    process.exit(0);
  });
}

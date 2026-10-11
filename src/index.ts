import { searchAllSources } from "./scrapers";
import { generateAllReports } from "./reports/report-generator";
import { startScheduler } from "./scheduler";
import { startServer } from "./server";
import { runSupporterTrace, TRACE_LABEL } from "./enrich/supporter-trace";

async function main(): Promise<void> {
  const command = process.argv[2] ?? "search";

  switch (command) {
    case "search":
      // 全ソースから助成金情報を収集してレポート生成
      console.log("🔎 助成金・補助金の検索を開始します...\n");
      console.log(
        "対象分野: 子育て支援 / 子ども食堂 / 外国にルーツを持つ人の支援",
      );
      console.log("対象地域: 全国 / 愛知県 / 長久手市\n");

      try {
        await searchAllSources();
        generateAllReports();
      } catch (error) {
        console.error("検索中にエラーが発生しました:", error);
        process.exit(1);
      }
      break;

    case "discover":
      // 支援元サーチを1回だけ実行する（見つかった助成金は次の検索で取り込まれる）
      try {
        await runSupporterTrace();
      } catch (error) {
        console.error(`${TRACE_LABEL}でエラーが発生しました:`, error);
        process.exit(1);
      }
      break;

    case "report":
      // 既存のDBデータからレポートのみ生成
      console.log("📊 既存データからレポートを生成します...\n");
      generateAllReports();
      break;

    case "server":
      // Webサーバーモード（週次スケジューラも同時に起動する）
      startServer();
      startScheduler();
      break;

    case "schedule":
      // 定期実行モード
      const cronExpr = process.argv[3]; // オプション: カスタムcron式
      startScheduler(cronExpr);
      break;

    case "help":
      printHelp();
      break;

    default:
      console.log(`不明なコマンド: ${command}`);
      printHelp();
      process.exit(1);
  }
}

function printHelp(): void {
  console.log(`
助成金・補助金 定期検索システム
================================

使い方:
  npm run search              全ソースから助成金情報を収集してレポート生成
  npm run report              既存データからレポートのみ再生成
  npm run server              Webサーバー起動（スマホからアクセス可能）
  npm run schedule            定期実行モード（毎週月曜9:00）
  npm start -- schedule "0 9 * * 1"   カスタムcron式で定期実行
  npm start -- discover       ${TRACE_LABEL}を1回実行（結果は次の検索で取り込まれる）

コマンド:
  search    - Web上の助成金情報を収集し、レポートを生成します
  discover  - 似た活動の団体の支援元から、公式の募集ページを探します（毎週木曜9:00にも自動実行）
  report    - 前回収集済みのデータからレポートを再生成します
  server    - Webサーバーを起動します（週次スケジューラも同時に動きます）
  schedule  - 定期実行モードで起動します（デフォルト: 毎週月曜9:00）
  help      - このヘルプを表示します

対象分野:
  - 子育て支援
  - 子ども食堂・フードパントリー
  - 外国にルーツを持つ人の支援
  - 児童の健全育成・居場所づくり
  - 学習支援

対象地域:
  - 全国
  - 愛知県
  - 長久手市

出力先:
  - output/grants-report-YYYY-MM-DD.md   (Markdown形式)
  - output/grants-report-YYYY-MM-DD.html (HTML形式)
  - data/grants.db                        (SQLiteデータベース)
`);
}

main().catch((error) => {
  console.error("致命的なエラー:", error);
  process.exit(1);
});

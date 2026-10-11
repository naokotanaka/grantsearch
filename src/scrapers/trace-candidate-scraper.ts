import { BaseScraper } from "./base-scraper";
import { Grant } from "../models/grant";
import { TRACE_LABEL, TraceFunderRecord } from "../enrich/supporter-trace";

/**
 * 支援元サーチ（木曜）で見つかった助成金を、月曜の検索の候補にする。
 * ページは読まない（候補を Grant にするだけ）。以降は他の情報源と同じく、
 * まとめ・AI読み取り・応募可否の判定・募集開始チェックを通る。
 */
export class TraceCandidateScraper extends BaseScraper {
  constructor(private records: TraceFunderRecord[]) {
    super("trace", "全国");
  }

  async search(): Promise<Grant[]> {
    return this.records.map((r) =>
      this.createGrant({
        // 助成金名＋助成元から決める（毎週同じ候補が同じ id になる）
        id: this.generateId(r.grantName, r.name),
        name: r.grantName,
        organization: r.name,
        targetProjects: r.clue
          ? `${TRACE_LABEL}で発見（手がかり：${r.clue}）。内容はリンク先で要確認`
          : `${TRACE_LABEL}で発見。内容はリンク先で要確認`,
        url: r.grantUrl,
        benefitType: r.benefitType,
        status: "不明",
      }),
    );
  }
}

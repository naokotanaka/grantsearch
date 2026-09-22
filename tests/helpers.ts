import { Grant } from "../src/models/grant";

/** テスト用の Grant（未指定の項目は既定値） */
export function grant(
  partial: Partial<Grant> & { id: string; name: string },
): Grant {
  return {
    aliases: [],
    organization: "テスト財団",
    region: "全国",
    targetProjects: "",
    grantAmount: "要確認",
    grantPeriod: "要確認",
    applicationDeadline: "要確認",
    expectedPeriod: "",
    personnelCosts: "不明",
    honorarium: "不明",
    rent: "不明",
    benefitType: "不明",
    status: "不明",
    url: "",
    source: "aichi_vc",
    lastUpdated: "2026-09-21T00:00:00.000Z",
    memo: "",
    manualUrl: "",
    humanJudgment: "",
    ...partial,
  };
}

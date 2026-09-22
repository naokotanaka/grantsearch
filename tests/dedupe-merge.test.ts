import { describe, it, expect } from "vitest";
import { dedupeAcrossSources } from "../src/scrapers/index";
import { Grant } from "../src/models/grant";

/** テスト用の Grant（未指定の項目は既定値） */
function grant(partial: Partial<Grant> & { id: string; name: string }): Grant {
  return {
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

describe("dedupeAcrossSources: 捨てる側の新しい回を残す側に取り込む", () => {
  it("👍の旧年度行に、募集中の新年度行の状態・締切・URL・名前を取り込む", () => {
    const old = grant({
      id: "aichi_vc_old",
      name: "令和8年度 こどもの未来応援基金 未来応援ネットワーク事業",
      organization: "こどもの未来応援国民運動推進事務局 /福祉医療機構",
      status: "募集前",
      applicationDeadline: "未発表",
      expectedPeriod:
        "例年8月〜9月頃（昨年実績: 2025年8月5日(火)～2025年9月17日(水) 15:00）",
      url: "https://www.wam.go.jp/hp/miraiouen_r8/",
      humanJudgment: "関係あり",
      memo: "去年は落ちた",
    });
    const fresh = grant({
      id: "aichi_vc_new",
      name: "令和9年度 こどもの未来応援基金 未来応援ネットワーク事業",
      organization: "福祉医療機構 NPO リソースセンター",
      status: "募集中",
      applicationDeadline: "2026年8月7日(金)～2026年9月18日(金) 15:00",
      grantAmount: "400万",
      url: "https://www.wam.go.jp/hp/miraiouen_r9/",
    });

    const result = dedupeAcrossSources([old, fresh]);

    expect(result).toHaveLength(1);
    const kept = result[0];
    expect(kept.id).toBe("aichi_vc_old"); // 👍の行の id を維持
    expect(kept.humanJudgment).toBe("関係あり");
    expect(kept.memo).toBe("去年は落ちた");
    expect(kept.status).toBe("募集中");
    expect(kept.applicationDeadline).toBe(
      "2026年8月7日(金)～2026年9月18日(金) 15:00",
    );
    expect(kept.url).toBe("https://www.wam.go.jp/hp/miraiouen_r9/");
    expect(kept.name).toBe(
      "令和9年度 こどもの未来応援基金 未来応援ネットワーク事業",
    );
    expect(kept.grantAmount).toBe("400万"); // 残す側が要確認なので取り込む
  });

  // 注: 「むすびえ・こども食堂基金（年2回募集）」と「『むすびえ・こども食堂基金』
  // 2026年度 秋募集」のように名前の共通部分が短い組は、今の文字列規則では同一と
  // 判定できない。段階2（AI照合）で扱う。
  it("定番（known）の行は名前を変えず、状態と締切だけ取り込む", () => {
    const known = grant({
      id: "known_shinnyoen",
      name: "真如苑 こども食堂支援助成",
      organization: "真如苑",
      source: "known",
      status: "募集前",
      applicationDeadline: "未発表",
      expectedPeriod: "例年11月〜12月頃",
      grantAmount: "上限20万円",
      url: "https://kobo.shinnyo-en.or.jp/kodomo/",
    });
    const fresh = grant({
      id: "aichi_vc_shinnyoen_2026",
      name: "2026年度 真如苑 こども食堂支援助成",
      organization: "真如苑",
      status: "募集中",
      applicationDeadline: "2026年11月4日（水）～2026年12月10日（木）",
      url: "https://kobo.shinnyo-en.or.jp/kodomo/2026/",
    });

    const result = dedupeAcrossSources([known, fresh]);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("known_shinnyoen");
    expect(result[0].name).toBe("真如苑 こども食堂支援助成");
    expect(result[0].status).toBe("募集中");
    expect(result[0].applicationDeadline).toBe(
      "2026年11月4日（水）～2026年12月10日（木）",
    );
    expect(result[0].url).toBe("https://kobo.shinnyo-en.or.jp/kodomo/2026/");
    // 残す側に既に値がある項目は上書きしない
    expect(result[0].grantAmount).toBe("上限20万円");
  });

  it("捨てる側が古い回なら何も取り込まない", () => {
    const kept = grant({
      id: "a",
      name: "2027年度 八嶋佳子基金助成",
      organization: "共生会SHOWA",
      status: "募集中",
      applicationDeadline: "2026年9月15日 (火) ～ 2026年10月30日 (金)",
      url: "https://kshowa.or.jp/2027",
    });
    const older = grant({
      id: "b",
      name: "2026年度 八嶋佳子基金助成",
      organization: "共生会SHOWA",
      status: "募集前",
      applicationDeadline: "未発表",
      expectedPeriod:
        "例年10月〜12月頃（昨年実績: 2025年10月20日（月）～2025年12月15日（月））",
      url: "https://kshowa.or.jp/2026",
      humanJudgment: "関係あり",
    });

    const result = dedupeAcrossSources([kept, older]);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("b"); // 👍が代表
    expect(result[0].status).toBe("募集中");
    expect(result[0].url).toBe("https://kshowa.or.jp/2027");
    expect(result[0].name).toBe("2027年度 八嶋佳子基金助成");
  });

  it("両方とも募集前なら、前回の期間が新しい方の情報を取り込む", () => {
    const stale = grant({
      id: "stale",
      name: "2025年度 子ども育成支援事業",
      status: "募集前",
      applicationDeadline: "未発表",
      expectedPeriod:
        "例年5月〜7月頃（昨年実績: 2025年5月1日（木）～2025年7月4日（金）必着）",
      url: "https://example.org/2025",
      humanJudgment: "関係あり",
    });
    const newer = grant({
      id: "newer",
      name: "2026年度 子ども育成支援事業",
      status: "募集前",
      applicationDeadline: "未発表",
      expectedPeriod:
        "例年5月〜7月頃（昨年実績: 2026年5月1日（金）～2026年7月3日（金）必着）",
      url: "https://example.org/2026",
    });

    const result = dedupeAcrossSources([stale, newer]);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("stale");
    expect(result[0].expectedPeriod).toContain("2026年5月1日");
    expect(result[0].url).toBe("https://example.org/2026");
  });
});

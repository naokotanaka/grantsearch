import { describe, it, expect } from "vitest";
import {
  matchPrograms,
  clusterCandidates,
  isSimilarOrganization,
  Judge,
  ProgramGroup,
} from "../src/enrich/ai-matcher";
import { Grant } from "../src/models/grant";
import { grant } from "./helpers";

/** AIの代わり：名前に含まれる印（[[A]] など）が同じ行を同じ組にする固定応答 */
function judgeByMarker(): Judge {
  return async (rows: Grant[]): Promise<ProgramGroup[]> => {
    const groups = new Map<string, string[]>();
    for (const r of rows) {
      const marker = r.name.match(/\[\[(\w+)\]\]/)?.[1] ?? r.id;
      const list = groups.get(marker) ?? [];
      list.push(r.id);
      groups.set(marker, list);
    }
    return Array.from(groups.entries()).map(([k, ids]) => ({
      programName: k,
      memberIds: ids,
      reason: "テスト固定応答",
    }));
  };
}

describe("isSimilarOrganization: 助成元の表記違いを同じ団体とみなす", () => {
  it("事務局・部署の表記違い", () => {
    expect(
      isSimilarOrganization(
        "こどもの未来応援国民運動推進事務局 /福祉医療機構",
        "福祉医療機構 NPO リソースセンター",
      ),
    ).toBe(true);
  });
  it("法人格の有無", () => {
    expect(
      isSimilarOrganization("公益財団法人 日本財団", "日本財団"),
    ).toBe(true);
  });
  it("まったく別の団体", () => {
    expect(isSimilarOrganization("真如苑", "カゴメみらいやさい財団")).toBe(
      false,
    );
  });
});

describe("clusterCandidates: 同一の可能性がある行をひとかたまりにする", () => {
  it("助成元が似ている行は同じかたまり、違う行は別", () => {
    const rows = [
      grant({ id: "a", name: "令和8年度 未来応援ネットワーク事業", organization: "こどもの未来応援国民運動推進事務局 /福祉医療機構" }),
      grant({ id: "b", name: "福祉医療機構「未来応援ネットワーク事業」-2027 年度", organization: "独立行政法人 福祉医療機構 NPO リソースセンター" }),
      grant({ id: "c", name: "真如苑 こども食堂支援助成", organization: "真如苑" }),
    ];
    const clusters = clusterCandidates(rows).map((c) => c.map((g) => g.id).sort());
    expect(clusters).toContainEqual(["a", "b"]);
    expect(clusters).toContainEqual(["c"]);
  });
});

describe("matchPrograms", () => {
  it("AIが同じプログラムと判定した年度違いを1行にまとめ、DBにあった行の id を残す", async () => {
    const stored = new Map<string, Grant>();
    const old = grant({
      id: "aichi_vc_2026",
      name: "[[yashima]] 2026年度 八嶋佳子基金「女性や子どもを支援する事業への助成」",
      organization: "共生会SHOWA",
      status: "募集前",
      applicationDeadline: "未発表",
      expectedPeriod: "例年10月〜12月頃（昨年実績: 2025年10月20日（月）～2025年12月15日（月））",
      url: "https://kshowa.or.jp/2026",
      memo: "去年は落ちた",
    });
    stored.set(old.id, old);
    const fresh = grant({
      id: "aichi_vc_2027",
      name: "[[yashima]] 2027年度 八嶋佳子基金助成",
      organization: "共生会SHOWA",
      status: "募集中",
      applicationDeadline: "2026年9月15日 (火) ～ 2026年10月30日 (金)",
      url: "https://kshowa.or.jp/2027",
    });

    const protectedIds = new Set<string>();
    const { grants, merges } = await matchPrograms(
      [old, fresh],
      stored,
      protectedIds,
      judgeByMarker(),
    );

    expect(grants).toHaveLength(1);
    expect(grants[0].id).toBe("aichi_vc_2026");
    expect(grants[0].status).toBe("募集中");
    expect(grants[0].url).toBe("https://kshowa.or.jp/2027");
    expect(grants[0].memo).toBe("去年は落ちた");
    expect(grants[0].aliases.map((a) => a.id)).toContain("aichi_vc_2027");
    expect(merges).toHaveLength(1);
    expect(merges[0].keptId).toBe("aichi_vc_2026");
    expect(merges[0].reason).toContain("AI");
  });

  it("AIが別プログラムと判定した同じ助成元の行はまとめない", async () => {
    const rows = [
      grant({ id: "k1", name: "2026年度 第Ⅰ期助成プログラムA「食育活動助成」", organization: "キユーピーみらいたまご財団", status: "募集前" }),
      grant({ id: "k2", name: "2026年度 第Ⅰ期助成プログラムB-1「食を通した居場所づくり助成」", organization: "キユーピーみらいたまご財団", status: "募集前" }),
      grant({ id: "k3", name: "2026年度 第Ⅰ期助成プログラムB-4「食材費助成」", organization: "キユーピーみらいたまご財団", status: "募集前" }),
    ];
    // 印が無いので固定応答は1行ずつ別の組にする
    const { grants, merges } = await matchPrograms(
      rows,
      new Map(),
      new Set(),
      judgeByMarker(),
    );
    expect(grants).toHaveLength(3);
    expect(merges).toHaveLength(0);
  });

  it("別名一覧に一致する候補は、AIを呼ばずにその行の回として取り込む", async () => {
    const program = grant({
      id: "known_musubie_fund",
      name: "むすびえ・こども食堂基金（年2回募集）",
      organization: "全国こども食堂支援センター・むすびえ",
      source: "known",
      status: "募集前",
      expectedPeriod: "例年 春募集: 4月頃 / 秋募集: 10月頃",
      aliases: [
        {
          name: "『むすびえ・こども食堂基金』2026年度 春募集",
          organization: "全国こども食堂支援センター・むすびえ",
          id: "aichi_vc_spring",
        },
      ],
    });
    const stored = new Map([[program.id, program]]);
    const autumn = grant({
      id: "aichi_vc_autumn",
      name: "『むすびえ・こども食堂基金』2026年度 秋募集",
      organization: "全国こども食堂支援センター・むすびえ",
      status: "募集中",
      applicationDeadline: "2026年9月2日（水）10:00～2026年9月30日（水）17:00",
      url: "https://musubie.org/grant-list/plan/33000",
    });
    let aiCalled = false;
    const judge: Judge = async (rows) => {
      aiCalled = true;
      return rows.map((r) => ({ programName: r.name, memberIds: [r.id], reason: "" }));
    };

    // 名前は春募集と一致しないが、同じ基金の秋募集は正規化した別名（年度・回を除く）に一致する
    const { grants, merges } = await matchPrograms(
      [program, autumn],
      stored,
      new Set(),
      judge,
    );

    expect(aiCalled).toBe(false);
    expect(grants).toHaveLength(1);
    expect(grants[0].id).toBe("known_musubie_fund");
    expect(grants[0].name).toBe("むすびえ・こども食堂基金（年2回募集）"); // 定番の名前は変えない
    expect(grants[0].status).toBe("募集中");
    expect(merges[0].reason).toBe("別名一致");
  });

  it("AIが失敗したかたまりは、まとめずにそのまま残す", async () => {
    const rows = [
      grant({ id: "a", name: "[[x]] 2026年度 テスト助成", status: "募集前" }),
      grant({ id: "b", name: "[[x]] 2027年度 テスト助成", status: "募集中" }),
    ];
    const judge: Judge = async () => {
      throw new Error("API error");
    };
    const { grants, merges } = await matchPrograms(rows, new Map(), new Set(), judge);
    expect(grants).toHaveLength(2);
    expect(merges).toHaveLength(0);
  });

  it("AIが不正な id を返しても、入力の行は失われない", async () => {
    const rows = [
      grant({ id: "a", name: "2026年度 テスト助成", status: "募集前" }),
      grant({ id: "b", name: "2027年度 テスト助成", status: "募集中" }),
    ];
    const judge: Judge = async () => [
      { programName: "テスト助成", memberIds: ["zzz", "a"], reason: "" },
    ];
    const { grants } = await matchPrograms(rows, new Map(), new Set(), judge);
    expect(grants.map((g) => g.id).sort()).toEqual(["a", "b"]);
  });

  it("AI無し（judge=null）では文字列規則だけでまとめる", async () => {
    const rows = [
      grant({ id: "a", name: "2026年度 真如苑 こども食堂支援助成", organization: "真如苑", status: "募集前" }),
      grant({ id: "b", name: "2027年度 真如苑 こども食堂支援助成", organization: "真如苑", status: "募集中" }),
    ];
    const { grants, merges } = await matchPrograms(rows, new Map(), new Set(), null);
    expect(grants).toHaveLength(1);
    expect(merges[0].reason).toBe("名前の規則");
  });
});

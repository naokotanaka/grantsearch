import { describe, it, expect } from "vitest";
import {
  checkOpenings,
  parentUrl,
  searchTerm,
  OpeningJudge,
  OpeningVerdict,
} from "../src/enrich/ai-opening-checker";
import { grant } from "./helpers";

const NOW = new Date(2026, 8, 22); // 2026-09-22

const yes = (deadline: string, period = ""): OpeningVerdict => ({
  announced: "yes",
  roundName: "テスト 2027年度",
  period,
  deadline,
  reason: "告知あり",
});
const no: OpeningVerdict = {
  announced: "no",
  roundName: "",
  period: "",
  deadline: "",
  reason: "過去の回のみ",
};

describe("parentUrl / searchTerm", () => {
  it("1段上のページを返す", () => {
    expect(parentUrl("https://www.wam.go.jp/hp/miraiouen_r8/")).toBe(
      "https://www.wam.go.jp/hp/",
    );
    expect(parentUrl("https://www.public.or.jp/project/f0168")).toBe(
      "https://www.public.or.jp/project/",
    );
    expect(
      parentUrl("https://kshowa.or.jp/"),
    ).toBeNull();
    expect(parentUrl("https://example.org/a/b/page.html")).toBe(
      "https://example.org/a/",
    );
  });
  it("年度・回数・括弧書きを除いた検索語", () => {
    expect(
      searchTerm("2026年度 八嶋佳子基金「女性や子どもを支援する事業への助成」"),
    ).toBe("八嶋佳子基金 女性や子どもを支援する事業への助成");
    expect(searchTerm("第3回「子どもすこやか基金」助成")).toBe(
      "子どもすこやか基金 助成",
    );
  });
});

describe("checkOpenings", () => {
  const base = () =>
    grant({
      id: "p1",
      name: "2026年度 テスト助成",
      status: "募集前",
      applicationDeadline: "未発表",
      expectedPeriod: "例年9月〜10月頃（前回: 2025年9月1日～2025年10月31日）",
      url: "https://example.org/grant/2026/",
    });

  it("公式ページで新しい回を検知し、締切が未来なら募集中に昇格する", async () => {
    const judge: OpeningJudge = async (_g, pageUrl) =>
      pageUrl === "https://example.org/grant/2026/"
        ? no
        : yes("2026年10月30日", "2026年9月15日～2026年10月30日");
    const { grants, stats } = await checkOpenings([base()], {
      judge,
      fetchText: async () => "本文",
      search: async () => [],
      now: NOW,
    });
    expect(grants[0].status).toBe("募集中");
    expect(grants[0].applicationDeadline).toBe("2026年9月15日～2026年10月30日");
    expect(grants[0].url).toBe("https://example.org/grant/"); // 1段上のページで見つかった
    expect(stats.promoted).toBe(1);
    expect(stats.searches).toBe(0);
  });

  it("告知ありでも締切が過去なら据え置く", async () => {
    const { grants } = await checkOpenings([base()], {
      judge: async () => yes("2025年10月31日"),
      fetchText: async () => "本文",
      search: async () => [],
      now: NOW,
    });
    expect(grants[0].status).toBe("募集前");
  });

  it("締切が1年より先なら据え置く", async () => {
    const { grants } = await checkOpenings([base()], {
      judge: async () => yes("2028年1月31日"),
      fetchText: async () => "本文",
      search: async () => [],
      now: NOW,
    });
    expect(grants[0].status).toBe("募集前");
  });

  it("公式ページに無ければ Web 検索の結果ページを読んで検知する", async () => {
    const searched: string[] = [];
    const { grants, stats } = await checkOpenings([base()], {
      judge: async (_g, pageUrl) =>
        pageUrl === "https://news.example.org/2027" ? yes("2026年11月20日") : no,
      fetchText: async () => "本文",
      search: async (q) => {
        searched.push(q);
        return [{ url: "https://news.example.org/2027" }];
      },
      now: NOW,
    });
    expect(searched).toEqual(["テスト助成 募集"]);
    expect(grants[0].status).toBe("募集中");
    expect(grants[0].url).toBe("https://news.example.org/2027");
    expect(stats.searches).toBe(1);
  });

  it("ページが読めず検索も空なら募集前のまま", async () => {
    const { grants, stats } = await checkOpenings([base()], {
      judge: async () => yes("2026年10月30日"),
      fetchText: async () => null,
      search: async () => [],
      now: NOW,
    });
    expect(grants[0].status).toBe("募集前");
    expect(stats.promoted).toBe(0);
  });

  it("AI判定が失敗しても落ちず、募集前のまま", async () => {
    const { grants } = await checkOpenings([base()], {
      judge: async () => {
        throw new Error("API error");
      },
      fetchText: async () => "本文",
      search: async () => [],
      now: NOW,
    });
    expect(grants[0].status).toBe("募集前");
  });

  it("全角数字の締切でも判定でき、半角に直して保存する", async () => {
    const { grants } = await checkOpenings([base()], {
      judge: async () =>
        yes("２０２６年１０月１９日", "令和８年９月１４日～１０月１９日［必着］"),
      fetchText: async () => "本文",
      search: async () => [],
      now: NOW,
    });
    expect(grants[0].status).toBe("募集中");
    expect(grants[0].applicationDeadline).toBe("令和8年9月14日～10月19日［必着］");
  });

  it("複数件を同時に処理しても結果の並び順は入力どおり", async () => {
    const items = ["a", "b", "c", "d", "e"].map((id) =>
      grant({ ...base(), id, name: `${id} 助成`, url: `https://example.org/${id}/x/` }),
    );
    const { grants } = await checkOpenings(items, {
      judge: async (g) =>
        g.id === "c" || g.id === "e" ? yes("2026年12月1日") : no,
      fetchText: async (url) =>
        new Promise((resolve) =>
          setTimeout(() => resolve("本文"), url.includes("/a/") ? 30 : 1),
        ),
      search: async () => [],
      now: NOW,
    });
    expect(grants.map((g) => g.id)).toEqual(["a", "b", "c", "d", "e"]);
    expect(grants.map((g) => g.status)).toEqual([
      "募集前",
      "募集前",
      "募集中",
      "募集前",
      "募集中",
    ]);
  });

  it("手動URLで見つかったときは行のURLを変えない", async () => {
    const g = grant({
      ...base(),
      manualUrl: "https://example.org/yoko.pdf",
    });
    const { grants } = await checkOpenings([g], {
      judge: async (_g, pageUrl) =>
        pageUrl === "https://example.org/yoko.pdf" ? yes("2026年10月30日") : no,
      fetchText: async () => "本文",
      search: async () => [],
      now: NOW,
    });
    expect(grants[0].status).toBe("募集中");
    expect(grants[0].url).toBe("https://example.org/grant/2026/");
  });
});

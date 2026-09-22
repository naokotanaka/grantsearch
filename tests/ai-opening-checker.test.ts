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

  it("今年の回がもう終わっていたら、前回の期間を今年のものに更新し、Web検索はしない", async () => {
    let searched = 0;
    const { grants, stats } = await checkOpenings([base()], {
      judge: async () => yes("2026年6月30日", "2026年5月1日～2026年6月30日"),
      fetchText: async () => "本文",
      search: async () => {
        searched++;
        return [];
      },
      now: NOW,
    });
    expect(grants[0].status).toBe("募集前");
    expect(grants[0].expectedPeriod).toBe(
      "例年9月〜10月頃（前回: 2026年5月1日～2026年6月30日）",
    );
    expect(searched).toBe(0);
    expect(stats.promoted).toBe(0);
  });

  it("今年の回が終了で、期間の文字列に日付が無ければ締切だけを前回として保存する", async () => {
    const { grants } = await checkOpenings([base()], {
      judge: async () => yes("2026年6月30日", "（募集は終了。募集締切をもとに判断）"),
      fetchText: async () => "本文",
      search: async () => [],
      now: NOW,
    });
    expect(grants[0].expectedPeriod).toBe("例年9月〜10月頃（前回: 2026年6月30日）");
  });

  it("例年の募集月がまだ先の行は、公式ページは読むが Web 検索はしない", async () => {
    let searched = 0;
    const far = grant({ ...base(), expectedPeriod: "例年2月〜3月頃" }); // 今は9月
    const { grants } = await checkOpenings([far], {
      judge: async () => no,
      fetchText: async () => "本文",
      search: async () => {
        searched++;
        return [];
      },
      now: NOW,
    });
    expect(grants[0].status).toBe("募集前");
    expect(searched).toBe(0);
  });

  it("例年の募集月が近い行から順に確認する", async () => {
    const visited: string[] = [];
    const items = [
      grant({ ...base(), id: "feb", expectedPeriod: "例年2月頃" }),
      grant({ ...base(), id: "oct", expectedPeriod: "例年10月頃" }),
      grant({ ...base(), id: "none", expectedPeriod: "" }),
      grant({ ...base(), id: "sep", expectedPeriod: "例年9月〜10月頃" }),
    ];
    await checkOpenings(items, {
      judge: async (g) => {
        visited.push(g.id);
        return no;
      },
      fetchText: async () => "本文",
      search: async () => [],
      now: NOW,
    });
    // 今は9月なので近い順は sep(0) → oct(1) → feb(5) → 月が無い行(6扱い)。
    // 1行につき複数ページを読むので、最初に着手した順（初出）で見る。
    // 3件並列なので先頭3件の順は前後するが、月が無い行は最後になる
    const firstSeen = Array.from(new Set(visited));
    expect(firstSeen.slice(0, 3).sort()).toEqual(["feb", "oct", "sep"]);
    expect(firstSeen[3]).toBe("none");
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

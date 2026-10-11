import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import {
  adoptionStartPages,
  extractLinks,
  findAdoptionPdf,
  funderPriority,
  findAdoptionLink,
  isTokai,
  traceSupporters,
  TraceAi,
  TraceDeps,
  TraceInput,
} from "../src/enrich/supporter-trace";
import {
  initializeSchema,
  saveTraceResult,
  getRecentTracePages,
  getRecentTraceFunders,
  getTraceCandidates,
  getLatestTraceRun,
} from "../src/models/database";
import { TraceCandidateScraper } from "../src/scrapers/trace-candidate-scraper";
import { WebSearchResult } from "../src/scrapers/web-search";
import { grant } from "./helpers";

const fixture = (name: string) =>
  fs.readFileSync(path.join(__dirname, "fixtures", name), "utf-8");

describe("採択団体一覧へのリンク選び（実ページ）", () => {
  it("ベネッセこども基金：最新年度の「助成団体」PDFを選ぶ（紹介・実績ページは選ばない）", () => {
    const url = "https://benesse-kodomokikin.or.jp/subsidy/";
    const links = extractLinks(fixture("trace-benesse-subsidy.html"), url);
    // 「2026年度 助成団体」（2025年度以前・助成団体紹介・活動実績より優先）
    expect(findAdoptionLink(links, url)).toBe(
      "https://benesse-kodomokikin.or.jp/doc/2026b_kekka1.pdf",
    );
  });
  it("NAGASEこどもみらい財団：「採択結果」を選ぶ（お問い合わせは選ばない）", () => {
    const url = "https://www.nagase-kodomomirai.or.jp/";
    const links = extractLinks(fixture("trace-nagase-top.html"), url);
    expect(findAdoptionLink(links, url)).toBe(
      "https://www.nagase-kodomomirai.or.jp/selection-results/",
    );
  });
  it("トナミ運輸松寿会：「助成先一覧」を選ぶ", () => {
    const url = "https://tonami-shoujukai.or.jp/";
    const links = extractLinks(fixture("trace-tonami-top.html"), url);
    expect(findAdoptionLink(links, url)).toBe(
      "https://tonami-shoujukai.or.jp/list",
    );
  });
  it("大和証券財団：同じページ内の「助成先一覧」なら、そのページ自身を返す", () => {
    const url = "https://www.daiwa-grp.jp/dsz/grant/children.html";
    const links = extractLinks(fixture("trace-daiwa-children.html"), url);
    expect(findAdoptionLink(links, url)).toBe(url);
  });
  it("該当するリンクが無ければ null", () => {
    expect(
      findAdoptionLink(
        [{ text: "募集要項", url: "https://x.example/a.pdf" }],
        "https://x.example/",
      ),
    ).toBeNull();
  });
});

describe("adoptionStartPages / isTokai", () => {
  it("HTMLならそのページとトップ、PDFならトップだけ", () => {
    expect(adoptionStartPages("https://kagome-miraiyasai.or.jp/support")).toEqual(
      ["https://kagome-miraiyasai.or.jp/support", "https://kagome-miraiyasai.or.jp/"],
    );
    expect(
      adoptionStartPages(
        "https://www.wam.go.jp/hp/wp-content/uploads/r8bosyuyouryoua.pdf?page=1",
      ),
    ).toEqual(["https://www.wam.go.jp/"]);
    expect(adoptionStartPages("https://www.akaihane.or.jp/")).toEqual([
      "https://www.akaihane.or.jp/",
    ]);
    expect(adoptionStartPages("")).toEqual([]);
  });
  it("愛知・岐阜・三重・名古屋・東海を東海とみなす", () => {
    expect(isTokai("愛知県")).toBe(true);
    expect(isTokai("名古屋市")).toBe(true);
    expect(isTokai("岐阜県")).toBe(true);
    expect(isTokai("三重")).toBe(true);
    expect(isTokai("東京都")).toBe(false);
    expect(isTokai("")).toBe(false);
  });
});

/** 検索の固定応答（クエリ → 結果URL）。未登録のクエリは1件のダミーを返す（0件扱いにしない） */
function fakeSearch(
  table: Record<string, string[]>,
  log: string[] = [],
): (q: string) => Promise<WebSearchResult[]> {
  return async (q) => {
    log.push(q);
    const urls = table[q] ?? [`https://blog.example/${log.length}`];
    return urls.map((url) => ({ title: `title ${url}`, url, snippet: "" }));
  };
}

function baseAi(overrides: Partial<TraceAi> = {}): TraceAi {
  return {
    extractAdopted: async () => [],
    extractSupporters: async () => [],
    judgeOfficial: async () => ({
      openCall: false,
      grantName: "",
      benefitType: "不明",
      reason: "公募ではない",
    }),
    ...overrides,
  };
}

const emptyInput = (partial: Partial<TraceInput> = {}): TraceInput => ({
  relevantGrants: [],
  trackedOrgs: [],
  recentPages: new Set(),
  recentFunders: new Set(),
  ...partial,
});

describe("traceSupporters", () => {
  const fund = grant({
    id: "g1",
    name: "テスト財団 子ども助成",
    humanJudgment: "関係あり",
    url: "https://fund.example/grant",
  });

  function scenario() {
    const searchLog: string[] = [];
    const fetched: string[] = [];
    const deps: TraceDeps = {
      fetchLinks: async (url) =>
        url === "https://fund.example/grant"
          ? [{ text: "2025年度 助成先一覧", url: "https://fund.example/list.pdf" }]
          : [],
      fetchText: async (url) => {
        fetched.push(url);
        return `本文 ${url}`;
      },
      search: fakeSearch(
        {
          "みどり子ども食堂 助成": ["https://midori.example/thanks"],
          "東京こども会 助成": ["https://tokyo.example/"],
          "みどり信用金庫 みどり地域応援助成 募集": [
            "https://prtimes.jp/main/x.html",
            "https://midori-shinkin.example/josei",
          ],
          "東京商事 助成 募集": ["https://tokyo-shoji.example/csr"],
        },
        searchLog,
      ),
      sleep: async () => {},
      ai: baseAi({
        extractAdopted: async () => [
          { name: "東京こども会", prefecture: "東京都" },
          { name: "みどり子ども食堂", prefecture: "愛知県" },
        ],
        extractSupporters: async (_text, url) => {
          if (url === "https://midori.example/thanks")
            return [
              { funder: "株式会社みどり信用金庫", program: "みどり地域応援助成", kind: "助成" },
              { funder: "公益財団法人ベネッセこども基金", program: "", kind: "助成" },
              { funder: "日進市社会福祉協議会", program: "", kind: "助成" },
              { funder: "みどり子ども食堂", program: "", kind: "その他" },
            ];
          if (url === "https://tokyo.example/")
            return [
              { funder: "東京商事", program: "", kind: "寄付" },
              { funder: "東京物産", program: "", kind: "寄付" },
              { funder: "東京銀行", program: "", kind: "助成" },
            ];
          return [];
        },
        judgeOfficial: async (funder) =>
          funder === "株式会社みどり信用金庫"
            ? {
                openCall: true,
                grantName: "みどり地域応援助成 2026",
                benefitType: "資金",
                reason: "公募あり",
              }
            : {
                openCall: false,
                grantName: "",
                benefitType: "不明",
                reason: "寄付実績の紹介のみ",
              },
      }),
    };
    return { deps, searchLog, fetched };
  }

  it("採択団体 → 団体のページ → 支援元 → 公式の募集ページ の順にたどる", async () => {
    const { deps, fetched } = scenario();
    const result = await traceSupporters(
      emptyInput({ relevantGrants: [fund], trackedOrgs: ["ベネッセこども基金"] }),
      deps,
    );

    const found = result.funders.filter((f) => f.result === "found");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      key: "みどり信用金庫",
      name: "株式会社みどり信用金庫",
      clue: "みどり子ども食堂",
      grantName: "みどり地域応援助成 2026",
      grantUrl: "https://midori-shinkin.example/josei", // プレスリリース配信は読まない
      benefitType: "資金",
    });
    // 追跡済み・他の市区町村・手がかりの団体自身は調べない
    const checkedNames = result.funders.map((f) => f.name);
    expect(checkedNames).not.toContain("公益財団法人ベネッセこども基金");
    expect(checkedNames).not.toContain("日進市社会福祉協議会");
    expect(checkedNames).not.toContain("みどり子ども食堂");
    // 公募が見つからなかった助成元も記録する（180日間調べ直さないため）
    expect(result.funders.find((f) => f.name === "東京商事")?.result).toBe(
      "not_found",
    );
    // 愛知の団体のページを、東京の団体より先に読む
    expect(fetched.indexOf("https://midori.example/thanks")).toBeLessThan(
      fetched.indexOf("https://tokyo.example/"),
    );
    expect(fetched).not.toContain("https://prtimes.jp/main/x.html");
    expect(result.pages.map((p) => [p.url, p.kind])).toEqual(
      expect.arrayContaining([
        ["https://fund.example/grant", "grant-top"],
        ["https://fund.example/list.pdf", "adoption-list"],
        ["https://midori.example/thanks", "org"],
      ]),
    );
    expect(result.stats.found).toBe(1);
    expect(result.stats.blocked).toBe(false);
  });

  it("最近読んだページ・最近調べた助成元は飛ばす", async () => {
    const { deps } = scenario();
    let linksFetched = 0;
    deps.fetchLinks = async () => {
      linksFetched++;
      return [];
    };
    const result = await traceSupporters(
      emptyInput({
        relevantGrants: [fund],
        recentPages: new Set(["https://fund.example/grant", "https://fund.example/"]),
        recentFunders: new Set(["みどり信用金庫"]),
      }),
      deps,
    );
    expect(linksFetched).toBe(0);
    expect(result.funders.some((f) => f.key === "みどり信用金庫")).toBe(false);
  });

  it("検索の0件が3回続いたらブロックとみなして検索を止める", async () => {
    const searched: string[] = [];
    const deps: TraceDeps = {
      fetchLinks: async () => [],
      fetchText: async () => "本文",
      search: async (q) => {
        searched.push(q);
        return [];
      },
      sleep: async () => {},
      ai: baseAi(),
    };
    const result = await traceSupporters(emptyInput(), deps);
    expect(searched).toHaveLength(3);
    expect(result.stats.blocked).toBe(true);
  });

  it("ブロック中に調べられなかった助成元は記録しない", async () => {
    const { deps } = scenario();
    let calls = 0;
    const original = deps.search;
    deps.search = async (q) => {
      calls++;
      // 支援元の公式ページ探しの段階から0件にする
      if (/募集$/.test(q)) return [];
      return original(q);
    };
    const result = await traceSupporters(
      emptyInput({ relevantGrants: [fund], trackedOrgs: ["ベネッセこども基金"] }),
      { ...deps, limits: { maxFunders: 20 } },
    );
    expect(calls).toBeGreaterThan(0);
    expect(result.stats.blocked).toBe(true);
    // 3回目の0件でブロック。0件だった最初の2件は「見つからない」、残り（3件目以降）は記録しない
    // （調べる順は優先度順：助成と書かれたもの → 寄付）
    expect(result.funders.map((f) => [f.name, f.result])).toEqual([
      ["株式会社みどり信用金庫", "not_found"],
      ["東京銀行", "not_found"],
    ]);
  });

  it("読むページの上限を守る", async () => {
    const { deps, fetched } = scenario();
    const result = await traceSupporters(emptyInput({ relevantGrants: [fund] }), {
      ...deps,
      limits: { maxPages: 2 },
    });
    expect(result.pages.filter((p) => p.kind === "org" || p.kind === "blog")).toHaveLength(2);
    expect(fetched.filter((u) => u !== "https://fund.example/list.pdf").length).toBeLessThanOrEqual(
      2 + result.stats.checked * 2,
    );
  });
});

describe("DBへの記録と、月曜の取り込み", () => {
  function memoryDb() {
    const db = new Database(":memory:");
    initializeSchema(db);
    return db;
  }

  it("記録した結果から、最近読んだページ・調べた助成元・候補を取り出せる", () => {
    const db = memoryDb();
    saveTraceResult(db, "2026-10-15T00:00:00.000Z", {
      pages: [{ url: "https://midori.example/thanks", kind: "org", funders: 2 }],
      funders: [
        {
          key: "みどり信用金庫",
          name: "株式会社みどり信用金庫",
          programName: "みどり地域応援助成",
          clue: "みどり子ども食堂",
          pageUrl: "https://midori.example/thanks",
          result: "found",
          grantName: "みどり地域応援助成 2026",
          grantUrl: "https://midori-shinkin.example/josei",
          benefitType: "資金",
        },
        {
          key: "東京商事",
          name: "東京商事",
          programName: "",
          clue: "東京こども会",
          pageUrl: "https://tokyo.example/",
          result: "not_found",
          grantName: "",
          grantUrl: "",
          benefitType: "不明",
        },
      ],
      stats: { pages: 1, lists: 0, mentions: 2, checked: 2, found: 1, searches: 3, blocked: false },
    });

    expect(getRecentTracePages(db, "2026-10-01T00:00:00.000Z")).toEqual(
      new Set(["https://midori.example/thanks"]),
    );
    expect(getRecentTracePages(db, "2026-10-20T00:00:00.000Z").size).toBe(0);
    expect(getRecentTraceFunders(db, "2026-10-01T00:00:00.000Z")).toEqual(
      new Set(["みどり信用金庫", "東京商事"]),
    );
    const candidates = getTraceCandidates(db, "2026-10-01T00:00:00.000Z");
    expect(candidates.map((c) => c.grantName)).toEqual(["みどり地域応援助成 2026"]);
    expect(candidates[0].pageUrl).toBe("https://midori.example/thanks");
    expect(getTraceCandidates(db, "2026-12-31T00:00:00.000Z")).toHaveLength(0);
    expect(getLatestTraceRun(db)).toMatchObject({
      runAt: "2026-10-15T00:00:00.000Z",
      pages: 1,
      found: 1,
      error: null,
    });
  });

  it("候補を Grant にする（source=trace、id は助成金名＋助成元から決まる）", async () => {
    const row = {
      key: "みどり信用金庫",
      name: "株式会社みどり信用金庫",
      programName: "みどり地域応援助成",
      clue: "みどり子ども食堂",
      pageUrl: "https://midori.example/thanks",
      result: "found" as const,
      grantName: "みどり地域応援助成 2026",
      grantUrl: "https://midori-shinkin.example/josei",
      benefitType: "資金" as const,
    };
    const [g1] = await new TraceCandidateScraper([row]).search();
    const [g2] = await new TraceCandidateScraper([row]).search();
    expect(g1).toMatchObject({
      name: "みどり地域応援助成 2026",
      organization: "株式会社みどり信用金庫",
      url: "https://midori-shinkin.example/josei",
      source: "trace",
      status: "不明",
      benefitType: "資金",
    });
    expect(g1.id).toMatch(/^trace_[0-9a-f]{8}$/);
    expect(g1.id).toBe(g2.id);
    expect(g1.targetProjects).toContain("みどり子ども食堂");
    // 検索で見つけたページからのとき（手がかりなし）は、ページの題名などを表示しない
    const [g3] = await new TraceCandidateScraper([{ ...row, clue: "" }]).search();
    expect(g3.targetProjects).not.toContain("手がかり");
  });
});

describe("改善（2026-10-11 の本番試行を受けて）", () => {
  it("公募の見込みが高い助成元を先に調べる（私募債・他団体経由の寄付・招待は後回し）", () => {
    const order = [
      { funder: "株式会社サラコーポレーション", program: "あいち銀行 寄付型私募債「あすなろ」", kind: "寄付" as const },
      { funder: "名鉄ホテルホールディングス", program: "毎月のランチビュッフェご招待", kind: "その他" as const },
      { funder: "キリンビバレッジ", program: "むすびえを通した寄付", kind: "寄付" as const },
      { funder: "公益財団法人かえで財団", program: "", kind: "寄付" as const },
      { funder: "株式会社ジェイテクト", program: "子ども食堂等応援助成金", kind: "助成" as const },
    ]
      .sort((a, b) => funderPriority(b) - funderPriority(a))
      .map((m) => m.funder);
    expect(order.slice(0, 2)).toEqual(["株式会社ジェイテクト", "公益財団法人かえで財団"]);
    expect(order.slice(-3)).toEqual(
      expect.arrayContaining([
        "株式会社サラコーポレーション",
        "名鉄ホテルホールディングス",
        "キリンビバレッジ",
      ]),
    );
  });

  it("採択結果のページにあるPDFから、最新年度の一覧を選ぶ", () => {
    expect(
      findAdoptionPdf([
        { text: "募集要項", url: "https://f.example/youkou.pdf" },
        { text: "2025年度 採択団体一覧", url: "https://f.example/2025.pdf" },
        { text: "2026年度 採択団体一覧", url: "https://f.example/2026.pdf" },
        { text: "2026年度 採択結果について", url: "https://f.example/news.html" },
      ]),
    ).toBe("https://f.example/2026.pdf");
    expect(findAdoptionPdf([{ text: "トップ", url: "https://f.example/" }])).toBeNull();
  });

  it("一覧のページから団体が取れなければ、そのページのPDFを読む", async () => {
    const read: string[] = [];
    const deps: TraceDeps = {
      fetchLinks: async (url) =>
        url === "https://fund.example/"
          ? [{ text: "採択結果", url: "https://fund.example/results/" }]
          : url === "https://fund.example/results/"
            ? [{ text: "2026年度 採択団体一覧", url: "https://fund.example/r2026.pdf" }]
            : [],
      fetchText: async (url) => {
        read.push(url);
        return url === "https://fund.example/results/" ? null : "本文";
      },
      search: fakeSearch({}),
      sleep: async () => {},
      ai: baseAi({
        extractAdopted: async (_t, url) =>
          url === "https://fund.example/r2026.pdf"
            ? [{ name: "さくら子ども食堂", prefecture: "愛知県" }]
            : [],
      }),
    };
    const result = await traceSupporters(
      emptyInput({
        relevantGrants: [
          grant({ id: "g", name: "x", humanJudgment: "関係あり", url: "https://fund.example/" }),
        ],
      }),
      deps,
    );
    expect(read).toContain("https://fund.example/r2026.pdf");
    expect(result.pages.map((p) => p.url)).toContain("https://fund.example/r2026.pdf");
    expect(result.stats.lists).toBe(1);
  });

  it("採択団体のページと、検索で見つけたページを交互に読む（検索結果だけで上限が埋まらない）", async () => {
    const { deps, fetched } = (() => {
      const fetched: string[] = [];
      const deps: TraceDeps = {
        fetchLinks: async () => [
          { text: "助成先一覧", url: "https://fund.example/list.pdf" },
        ],
        fetchText: async (url) => {
          fetched.push(url);
          return "本文";
        },
        // 検索語ごとに5件ずつ返す（団体名の検索は団体のページを1件返す）
        search: async (q) =>
          / 助成$/.test(q)
            ? [{ title: q, url: `https://org.example/${encodeURIComponent(q)}`, snippet: "" }]
            : [1, 2, 3, 4, 5].map((i) => ({
                title: `${q} ${i}`,
                url: `https://net.example/${encodeURIComponent(q)}/${i}`,
                snippet: "",
              })),
        sleep: async () => {},
        ai: baseAi({
          extractAdopted: async () =>
            ["A会", "B会", "C会", "D会"].map((name) => ({ name, prefecture: "東京都" })),
        }),
      };
      return { deps, fetched };
    })();
    const fund2 = grant({ id: "g2", name: "y", humanJudgment: "関係あり", url: "https://fund.example/" });
    const result = await traceSupporters(emptyInput({ relevantGrants: [fund2] }), {
      ...deps,
      limits: { maxPages: 6 },
    });
    const kinds = result.pages
      .filter((p) => p.kind === "org" || p.kind === "blog")
      .map((p) => p.kind);
    expect(kinds).toEqual(["org", "blog", "org", "blog", "org", "blog"]);
    expect(fetched.some((u) => u.startsWith("https://org.example/"))).toBe(true);
  });

  it("検索で見つけたページから取り出した助成元は、手がかりを空にして、ページのURLを残す", async () => {
    const deps: TraceDeps = {
      fetchLinks: async () => [],
      fetchText: async () => "本文",
      search: async (q) =>
        /募集$/.test(q)
          ? [{ title: "公式", url: "https://kaede.example/josei", snippet: "" }]
          : [{ title: "議員のブログ", url: "https://ameblo.jp/x/entry-1.html", snippet: "" }],
      sleep: async () => {},
      ai: baseAi({
        extractSupporters: async () => [{ funder: "かえで財団", program: "", kind: "助成" }],
        judgeOfficial: async () => ({
          openCall: true,
          grantName: "かえで子ども助成",
          benefitType: "資金",
          reason: "公募あり",
        }),
      }),
    };
    const result = await traceSupporters(emptyInput(), deps);
    expect(result.funders[0]).toMatchObject({
      name: "かえで財団",
      clue: "",
      pageUrl: "https://ameblo.jp/x/entry-1.html",
      result: "found",
    });
  });
});

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import {
  GOV_SITES,
  GovSite,
  GovScreen,
  extractGovLinks,
  collectGovKoubo,
  GovKouboScraper,
} from "../src/scrapers/gov-koubo-scraper";
import {
  initializeSchema,
  saveGovItems,
  getSeenGovUrls,
  getRelevantGovItems,
} from "../src/models/database";

const fixture = (name: string) =>
  fs.readFileSync(path.join(__dirname, "fixtures", name), "utf-8");
const site = (key: string): GovSite => {
  const s = GOV_SITES.find((s) => s.key === key);
  if (!s) throw new Error(key);
  return s;
};
const NOW = new Date(2026, 9, 11); // 2026-10-11

describe("国の公募ページからリンクを取り出す（実ページ）", () => {
  it("こども家庭庁：本文の公募・企画競争のリンクを取り出す（メニューは読まない）", () => {
    const links = extractGovLinks(fixture("gov-cfa.html"), site("cfa"), NOW);
    const urls = links.map((l) => l.url);
    expect(urls).toContain("https://www.cfa.go.jp/procurement/a1b46c84");
    expect(urls).toContain(
      "https://www.cfa.go.jp/policies/hitori-oya/kodomo-syokuji-koubo/r8saikoubo",
    );
    expect(links.find((l) => l.url.endsWith("/a1b46c84"))?.title).toBe(
      "令和8年度民間企業等による自治体と連携したヤングケアラーへの食支援事業の公募について",
    );
    expect(links.length).toBeGreaterThan(30);
    expect(links.length).toBeLessThanOrEqual(100);
    expect(links.every((l) => l.title.length >= 10)).toBe(true);
  });

  it("農林水産省：表の行の公告日・締切を添え、締切が過ぎた行は除く", () => {
    const links = extractGovLinks(fixture("gov-maff.html"), site("maff"), NOW);
    const titles = links.map((l) => l.title);
    // 締切 令和8年10月23日（未来）
    expect(titles).toContain("令和8年度大豆供給円滑化推進事業の第3次公募の実施について");
    // 締切 令和8年9月18日（過去）
    expect(
      titles.some((t) => t.includes("麦・大豆ストックセンターの再編集約")),
    ).toBe(false);
    const soy = links.find((l) => l.title.startsWith("令和8年度大豆供給"));
    expect(soy?.context).toContain("令和8年10月23日");
    expect(links.length).toBeLessThan(100);
  });

  it("出入国在留管理庁：本文の公募4件だけを取り出す", () => {
    const links = extractGovLinks(fixture("gov-isa.html"), site("isa"), NOW);
    expect(links).toHaveLength(4);
    expect(links.some((l) => l.title.includes("アウトリーチ支援事業"))).toBe(true);
  });

  it("休眠預金：公募の結果ページ（/result/番号）へのリンクだけを取り出す", () => {
    const links = extractGovLinks(fixture("gov-kyumin.html"), site("kyumin"), NOW);
    expect(links.length).toBeGreaterThan(0);
    expect(links.every((l) => /\/result\/\d+/.test(l.url))).toBe(true);
  });

  it("内閣府 孤独・孤立：新着欄のリンクを取り出す", () => {
    const links = extractGovLinks(fixture("gov-cao_kodoku.html"), site("cao_kodoku"), NOW);
    expect(
      links.some((l) => l.title.includes("NPO等の取組モデル調査")),
    ).toBe(true);
  });
});

describe("collectGovKoubo", () => {
  const sites: GovSite[] = [
    { key: "a", label: "A省 公募", ministry: "A省", url: "https://a.example/", scope: "body" },
    { key: "b", label: "B庁 公募", ministry: "B庁", url: "https://b.example/", scope: "body" },
  ];
  const html = (items: [string, string][]) =>
    `<html><body>${items.map(([href, t]) => `<a href="${href}">${t}</a>`).join("")}</body></html>`;
  const pages: Record<string, string> = {
    "https://a.example/": html([
      ["/1", "令和8年度 子どもの居場所づくり支援事業の公募について"],
      ["/2", "令和8年度 情報システム運用保守業務の企画競争について"],
      ["/3", "令和8年度 ひとり親家庭支援事業の公募について（既に見た）"],
    ]),
    "https://b.example/": html([["/9", "令和8年度 外国人生活支援アウトリーチ事業の公募"]]),
  };

  it("新しいリンクだけをAIに渡し、全部を記録する（対象かどうかの印つき）", async () => {
    const screened: string[] = [];
    const screen: GovScreen = async (links) => {
      screened.push(...links.map((l) => l.title));
      return links.map((l, index) => ({
        index,
        relevant: /居場所|外国人/.test(l.title),
        name: l.title.replace(/の公募.*$/, ""),
        organization: "",
        reason: "テスト",
      }));
    };
    const result = await collectGovKoubo(
      { seenUrls: new Set(["https://a.example/3"]) },
      { fetchHtml: async (url) => pages[url], screen, now: NOW, sites },
    );
    expect(screened).toHaveLength(3); // 既に見た /3 は渡さない
    const relevant = result.items.filter((i) => i.relevant).map((i) => i.url);
    expect(relevant).toEqual(["https://a.example/1", "https://b.example/9"]);
    expect(result.items).toHaveLength(3); // 対象外も記録する（次回から渡さないため）
    expect(result.items.find((i) => i.url.endsWith("/1"))).toMatchObject({
      siteKey: "a",
      name: "令和8年度 子どもの居場所づくり支援事業",
    });
    expect(result.siteResults.map((s) => [s.key, s.links])).toEqual([
      ["a", 3],
      ["b", 1],
    ]);
  });

  it("ページが読めなければエラーを記録し、他のページは続ける", async () => {
    const result = await collectGovKoubo(
      { seenUrls: new Set() },
      {
        fetchHtml: async (url) => {
          if (url === "https://a.example/") throw new Error("503");
          return pages[url];
        },
        screen: async (links) =>
          links.map((_, index) => ({ index, relevant: true, name: "", organization: "", reason: "" })),
        now: NOW,
        sites,
      },
    );
    expect(result.siteResults[0]).toMatchObject({ key: "a", links: 0, error: "503" });
    expect(result.items.map((i) => i.url)).toEqual(["https://b.example/9"]);
  });

  it("AIの振り分けに失敗したら、その回は記録しない（次の週に判定し直す）", async () => {
    const result = await collectGovKoubo(
      { seenUrls: new Set() },
      {
        fetchHtml: async (url) => pages[url],
        screen: async () => {
          throw new Error("AI失敗");
        },
        now: NOW,
        sites,
      },
    );
    expect(result.items).toHaveLength(0);
    expect(result.screenError).toBe("AI失敗");
  });
});

describe("DBへの記録と、月曜の取り込み", () => {
  it("見たリンク・対象のリンクを取り出し、Grant にする", async () => {
    const db = new Database(":memory:");
    initializeSchema(db);
    saveGovItems(db, "2026-10-12T00:00:00.000Z", [
      {
        url: "https://www.cfa.go.jp/procurement/a1b46c84",
        siteKey: "cfa",
        title: "令和8年度民間企業等による自治体と連携したヤングケアラーへの食支援事業の公募について",
        name: "令和8年度 ヤングケアラーへの食支援事業",
        organization: "",
        relevant: true,
        reason: "食支援",
      },
      {
        url: "https://www.cfa.go.jp/procurement/987c2685",
        siteKey: "cfa",
        title: "令和8年度こどもの自殺の多角的な要因分析に関する調査研究事業に係る公募について",
        name: "",
        organization: "",
        relevant: false,
        reason: "調査研究",
      },
    ]);
    expect(getSeenGovUrls(db).size).toBe(2);
    const records = getRelevantGovItems(db, "2026-10-01T00:00:00.000Z");
    expect(records.map((r) => r.url)).toEqual(["https://www.cfa.go.jp/procurement/a1b46c84"]);
    expect(getRelevantGovItems(db, "2026-10-20T00:00:00.000Z")).toHaveLength(0);

    const [g] = await new GovKouboScraper(records).search();
    expect(g).toMatchObject({
      name: "令和8年度 ヤングケアラーへの食支援事業",
      organization: "こども家庭庁",
      url: "https://www.cfa.go.jp/procurement/a1b46c84",
      source: "gov",
      region: "全国",
      status: "不明",
      targetProjects: "こども家庭庁 調達情報に掲載",
    });
    expect(g.id).toMatch(/^gov_[0-9a-f]{8}$/);
  });
});

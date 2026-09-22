import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import * as cheerio from "cheerio";
import fs from "fs";
import path from "path";
import { AkaihaneAichiScraper } from "../src/scrapers/akaihane-aichi-scraper";

/** 実HTML（2026-09-22 取得）を返すスクレイパー */
class FixtureScraper extends AkaihaneAichiScraper {
  protected async fetchPage(): Promise<cheerio.CheerioAPI> {
    const html = fs.readFileSync(
      path.join(__dirname, "fixtures", "akaihane-aichi-pages-38.html"),
      "utf-8",
    );
    return cheerio.load(html);
  }
}

describe("AkaihaneAichiScraper: ハブページの解析", () => {
  beforeAll(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 22)); // 2026-09-22（CBCの受付期間中）
  });
  afterAll(() => {
    vi.useRealTimers();
  });

  it("募集中ブロックの表から、事業費ごとに受付期間付きの行を作る", async () => {
    const grants = await new FixtureScraper().search();
    const byName = new Map(grants.map((g) => [g.name, g]));

    const cbc = byName.get("CBCチャリティ募金 広げよう子どもの食支援事業費");
    expect(cbc).toBeDefined();
    expect(cbc!.status).toBe("募集中");
    expect(cbc!.applicationDeadline).toBe("令和8年9月14日～10月19日（必着）");
    expect(cbc!.url).toBe("https://akaihane-aichi.jp/pages/45/");

    expect(byName.get("つながりをたやさない社会づくり事業費")?.status).toBe(
      "募集中",
    );
    expect(byName.get("こども食サポート安心推進事業費")?.status).toBe(
      "募集中",
    );
  });

  it("表のブロック全体を1件の助成金として登録しない", async () => {
    const grants = await new FixtureScraper().search();
    const junk = grants.filter((g) => /区\s*分|受付期間/.test(g.name));
    expect(junk).toHaveLength(0);
  });

  it("従来の表の行（設備整備費など）も引き続き取れる", async () => {
    const grants = await new FixtureScraper().search();
    const names = grants.map((g) => g.name);
    expect(names).toContain("NPO法人福祉施設等施設・設備整備費");
    expect(names).toContain("広域活動団体支援事業費");
    // 受付終了（令和8年4月20日～5月22日）→ 募集前
    const wide = grants.find((g) => g.name === "広域活動団体支援事業費");
    expect(wide?.status).toBe("募集前");
  });
});

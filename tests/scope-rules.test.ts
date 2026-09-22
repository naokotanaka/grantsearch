import { describe, it, expect } from "vitest";
import { isOtherMunicipality } from "../src/scrapers/scope-rules";

describe("isOtherMunicipality: 長久手市以外の市区町村の助成を除外する", () => {
  it("他の市区町村・その社協・役所は除外", () => {
    for (const org of [
      "名古屋市",
      "名古屋市社協",
      "名古屋市社会福祉協議会",
      "日進市 社会福祉協議会",
      "東郷町役場",
      "瀬戸市子ども政策課",
      "豊田市（こども家庭課）",
    ]) {
      expect(isOtherMunicipality(org), org).toBe(true);
    }
  });

  it("長久手市・都道府県・国・民間は除外しない", () => {
    for (const org of [
      "長久手市",
      "長久手市社会福祉協議会",
      "愛知県",
      "愛知県共同募金会",
      "こども家庭庁",
      "中央共同募金会",
      "全国こども食堂支援センター・むすびえ",
      "名古屋銀行",
      "公益財団法人 名古屋市文化振興事業団",
      "こどもの未来応援国民運動推進事務局 /福祉医療機構",
    ]) {
      expect(isOtherMunicipality(org), org).toBe(false);
    }
  });
});

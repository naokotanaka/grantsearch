import axios from "axios";
import * as cheerio from "cheerio";
import { BaseScraper } from "./base-scraper";

/**
 * DuckDuckGo（HTML版・キー不要）によるWeb検索。
 * 発掘（news-discovery-scraper）と募集開始チェック（ai-opening-checker）で共用する。
 * 除外はSNS・検索エンジン・フォームサービスのみ（`BaseScraper.NON_OFFICIAL`）。
 */

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

const client = axios.create({
  timeout: 30000,
  headers: {
    "User-Agent": "GrantSearch/1.0 (NPO Grant Research Tool)",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "ja,en;q=0.5",
  },
});

const clean = (text: string) => text.replace(/[\s\n\r\t]+/g, " ").trim();

/** 検索結果一覧を返す。0件のときは警告を出す（形式変更・一時ブロックの検知） */
export async function searchWeb(
  query: string,
  label = "Web検索",
): Promise<WebSearchResult[]> {
  const response = await client.get("https://html.duckduckgo.com/html/", {
    params: { q: query, kl: "jp-jp" },
    responseType: "text",
  });
  const $ = cheerio.load(response.data);
  const results: WebSearchResult[] = [];
  $(".result").each((_, el) => {
    const $el = $(el);
    const $a = $el.find("a.result__a").first();
    const title = clean($a.text());
    let href = $a.attr("href") ?? "";
    // DDGは /l/?uddg=<エンコード済みURL> 形式のリダイレクトを挟むことがある
    const redirect = href.match(/uddg=([^&]+)/);
    if (redirect) href = decodeURIComponent(redirect[1]);
    if (!title || !/^https?:\/\//.test(href)) return;
    if (BaseScraper.NON_OFFICIAL.test(href)) return;
    const snippet = clean($el.find(".result__snippet").first().text());
    results.push({ title, url: href, snippet: snippet.slice(0, 150) });
  });
  if (results.length === 0) {
    console.warn(
      `[${label}] Web検索「${query}」が0件でした（DuckDuckGoの形式変更・一時ブロックの可能性）`,
    );
  }
  return results;
}

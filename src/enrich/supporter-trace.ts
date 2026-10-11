import Anthropic from "@anthropic-ai/sdk";
import axios from "axios";
import * as cheerio from "cheerio";
import { BenefitType, Grant } from "../models/grant";
import {
  getDatabase,
  getAllGrants,
  getRecentTracePages,
  getRecentTraceFunders,
  saveTraceResult,
} from "../models/database";
import { BaseScraper } from "../scrapers/base-scraper";
import { LEGAL_FORMS, normalizeOrgName } from "../scrapers/dedupe";
import { isOtherMunicipality } from "../scrapers/scope-rules";
import { searchWeb, WebSearchResult } from "../scrapers/web-search";
import { fetchSourceText, READ_MODEL } from "./ai-enricher";

/**
 * 支援元サーチ
 *
 * 似た活動をしている団体のページ（👍の助成金の採択団体のサイト、ブログサービス等の
 * 活動報告・お礼のページ）に書かれた助成元・寄付元の名前を手がかりに、その助成元の
 * 公式の募集ページを探す。見つかった助成金は候補としてDBに保存し、月曜の検索で
 * 取り込む（`scrapers/trace-candidate-scraper.ts`）。
 *
 * 毎週木曜に動く（scheduler）。月曜の検索とは別に動かすのは、検索の所要時間を
 * 延ばさないためと、DuckDuckGo への検索を2日に分けるため。
 * 設計: docs/2026-10-11-supporter-trace-design.md
 */

/** この機能の名前（レポートの対象事業の欄と、ダッシュボードに表示する） */
export const TRACE_LABEL = "支援元サーチ";

/** 候補として月曜の検索に取り込む期間（見つけてからの日数） */
export const CANDIDATE_DAYS = 60;
/** 一度読んだページを読み直さない日数 */
export const PAGE_REVISIT_DAYS = 90;
/** 一度調べた助成元を調べ直さない日数 */
export const FUNDER_RECHECK_DAYS = 180;

export interface TraceLimits {
  /** 支援元を取り出すために読むページ数（団体のページ・ブログ） */
  maxPages: number;
  /** 読む採択団体一覧の数 */
  maxLists: number;
  /** 公式の募集ページを探す助成元の数 */
  maxFunders: number;
  /** 検索の回数（全体） */
  maxSearches: number;
  /** 検索と検索の間隔（ミリ秒） */
  searchIntervalMs: number;
  /** 0件がこの回数続いたらブロックとみなす */
  maxEmptySearches: number;
}

const DEFAULT_LIMITS: TraceLimits = {
  maxPages: 30,
  maxLists: 6,
  maxFunders: 20,
  maxSearches: 40,
  searchIntervalMs: 2000,
  maxEmptySearches: 3,
};

/**
 * 支援者一覧・お礼のページを探す検索語（東海を先に読む）。
 * 引用符で囲むと DuckDuckGo が0件を返すため、引用符は使わない。
 * 2026-10-11 の試行で、こども食堂ネットワーク・中間支援団体の「支援企業」「ご支援者一覧」の
 * ページから支援元が最も多く取れた（ブログ単体の記事は議員のブログなどが多く、0件が大半）。
 */
const PAGE_QUERIES: { query: string; tokai: boolean }[] = [
  { query: "子ども食堂 ネットワーク 愛知 支援企業", tokai: true },
  { query: "子ども食堂 岐阜 三重 ご支援いただいている企業", tokai: true },
  { query: "フードパントリー 名古屋 ご支援 企業 団体", tokai: true },
  { query: "site:ameblo.jp 子ども食堂 愛知 ご寄付", tokai: true },
  { query: "子ども食堂 ネットワーク 支援企業 一覧", tokai: false },
  { query: "こども食堂 協賛 助成 いただいている団体", tokai: false },
  { query: "site:note.com 子ども食堂 助成 いただきました", tokai: false },
  { query: "学習支援 NPO 支援者一覧 助成", tokai: false },
];

const TOKAI = /愛知|名古屋|岐阜|三重|東海|長久手/;

/** 採択団体一覧らしいリンクの文言 */
const ADOPTION_WORD =
  /採択|助成先|助成団体|選考結果|助成決定|交付先|支援実績|助成実績|贈呈先/;
/** 一覧ではないリンク（募集の案内・団体の紹介記事・問い合わせ等） */
const ADOPTION_SKIP = /募集|申請|応募|要項|問い?合わ?せ|紹介|インタビュー|報告|FAQ|よくある/;

/** 行政・助成金まとめサイトのドメイン（団体のページとしても公式の募集ページとしても読まない） */
const NOT_ORG_PAGE =
  /\.go\.jp|\.lg\.jp|pref\.|city\.|town\.|vill\.|hojyokin|hojokin|joseikin|subsidy-|navi\.|matome|companydata|baseconnect|houjin|gbiz|alarmbox|npo-hiroba|wikipedia/;
/** ブログ・ニュースのドメイン（公式の募集ページとしては読まない） */
const BLOG_OR_NEWS =
  /ameblo\.jp|note\.com|hatena|livedoor|fc2\.com|jugem|goo\.ne\.jp|seesaa|yahoo\.co\.jp|nikkei\.com|asahi\.com|yomiuri|mainichi\.jp|chunichi|nhk\.or\.jp|blog/;

export interface PageLink {
  text: string;
  url: string;
}

export interface AdoptedOrg {
  name: string;
  prefecture: string;
}

export interface SupporterMention {
  funder: string;
  program: string;
  kind: "助成" | "物品" | "寄付" | "その他";
}

export interface OfficialVerdict {
  openCall: boolean;
  grantName: string;
  benefitType: BenefitType;
  reason: string;
}

/** AIによる読み取り（テストでは固定応答に差し替える） */
export interface TraceAi {
  extractAdopted(text: string, sourceUrl: string): Promise<AdoptedOrg[]>;
  extractSupporters(
    text: string,
    pageUrl: string,
    clue: string,
  ): Promise<SupporterMention[]>;
  judgeOfficial(
    funder: string,
    program: string,
    pageUrl: string,
    text: string,
  ): Promise<OfficialVerdict>;
}

export interface TraceDeps {
  ai: TraceAi;
  fetchText: (url: string) => Promise<string | null>;
  fetchLinks: (url: string) => Promise<PageLink[] | null>;
  search: (query: string) => Promise<WebSearchResult[]>;
  sleep?: (ms: number) => Promise<void>;
  limits?: Partial<TraceLimits>;
}

export interface TraceInput {
  /** 👍（関係あり）の助成金。採択団体一覧を探す起点 */
  relevantGrants: Grant[];
  /** すでに追っている助成元の名前（DBの助成元名・別名一覧） */
  trackedOrgs: string[];
  /** 最近読んだページ（読み直さない） */
  recentPages: Set<string>;
  /** 最近調べた助成元のキー（調べ直さない） */
  recentFunders: Set<string>;
}

export type TracePageKind = "grant-top" | "adoption-list" | "org" | "blog";

export interface TracePageRecord {
  url: string;
  kind: TracePageKind;
  funders: number;
}

export interface TraceFunderRecord {
  key: string;
  name: string;
  programName: string;
  /** 手がかりの団体名（採択団体から見つけたとき）。検索で見つけたページなら空 */
  clue: string;
  /** 助成元の名前が書かれていたページ（確認用。DBにだけ保存し、レポートには表示しない） */
  pageUrl: string;
  result: "found" | "not_found";
  grantName: string;
  grantUrl: string;
  benefitType: BenefitType;
}

export interface TraceStats {
  pages: number;
  lists: number;
  mentions: number;
  checked: number;
  found: number;
  searches: number;
  blocked: boolean;
}

export interface TraceResult {
  pages: TracePageRecord[];
  funders: TraceFunderRecord[];
  stats: TraceStats;
}

export function isTokai(text: string): boolean {
  return TOKAI.test(text);
}

/** 助成元の照合キー（法人格・空白を除く） */
export function funderKey(name: string): string {
  return normalizeOrgName(name);
}

/** 検索に使う助成元の名前（法人格を除く） */
function searchName(name: string): string {
  return name.replace(LEGAL_FORMS, "").replace(/[\s　]+/g, " ").trim();
}

/** HTMLからリンクの一覧を取り出す（絶対URLにする） */
export function extractLinks(html: string, baseUrl: string): PageLink[] {
  const $ = cheerio.load(html);
  const links: PageLink[] = [];
  $("a[href]").each((_, el) => {
    const text = $(el).text().replace(/[\s\n\r\t]+/g, " ").trim();
    const href = $(el).attr("href") ?? "";
    try {
      const url = new URL(href, baseUrl).toString();
      if (/^https?:\/\//.test(url)) links.push({ text, url });
    } catch {
      // 壊れたリンクは無視
    }
  });
  return links;
}

/** リンク文言に含まれる年（西暦。令和は西暦に直す。無ければ 0） */
function yearOf(text: string): number {
  const western = text.match(/(20\d{2})/);
  if (western) return parseInt(western[1]);
  const reiwa = text.match(/令和\s*(\d+)/);
  return reiwa ? 2018 + parseInt(reiwa[1]) : 0;
}

/**
 * 採択団体一覧へのリンクを1つ選ぶ。年が書かれていれば最新の年を選ぶ。
 * 同じページ内へのリンク（#付き）なら、そのページ自身を返す。無ければ null。
 */
export function findAdoptionLink(
  links: PageLink[],
  pageUrl: string,
): string | null {
  const candidates = links.filter(
    (l) =>
      l.text.length > 0 &&
      l.text.length <= 40 &&
      ADOPTION_WORD.test(l.text) &&
      !ADOPTION_SKIP.test(l.text),
  );
  if (candidates.length === 0) return null;
  let best = candidates[0];
  for (const c of candidates) {
    if (yearOf(c.text) > yearOf(best.text)) best = c;
  }
  const url = new URL(best.url);
  url.hash = "";
  const page = new URL(pageUrl);
  page.hash = "";
  return url.toString() === page.toString() ? pageUrl : url.toString();
}

/** 採択結果のページに置かれた、採択団体一覧のPDFを1つ選ぶ（最新の年。無ければ null） */
export function findAdoptionPdf(links: PageLink[]): string | null {
  const pdfs = links.filter(
    (l) =>
      /\.pdf($|\?)/i.test(l.url) &&
      (ADOPTION_WORD.test(l.text) || /一覧|結果|団体/.test(l.text)) &&
      !ADOPTION_SKIP.test(l.text),
  );
  if (pdfs.length === 0) return null;
  let best = pdfs[0];
  for (const p of pdfs) {
    if (yearOf(p.text) > yearOf(best.text)) best = p;
  }
  return best.url;
}

/** 2つの列を交互に並べる（片方が尽きたら残りを続ける） */
function interleave<T>(a: T[], b: T[]): T[] {
  const out: T[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (i < a.length) out.push(a[i]);
    if (i < b.length) out.push(b[i]);
  }
  return out;
}

/** 採択団体一覧へのリンクを探す起点（HTMLならそのページとトップ、PDFならトップだけ） */
export function adoptionStartPages(rawUrl: string): string[] {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return [];
  }
  const top = `${url.origin}/`;
  const isPdf = /\.pdf$/i.test(url.pathname);
  const pages = isPdf ? [top] : [url.toString(), top];
  return Array.from(new Set(pages));
}

/**
 * 公式の募集ページを調べる順番の優先度（大きいほど先）。
 * 2026-10-11 の試行で、銀行の寄付型私募債に参加した会社や「〇〇を通した寄付」など、
 * 公募のない支援で調べる枠が埋まり、財団の名前に順番が来なかったため。
 */
export function funderPriority(m: SupporterMention): number {
  let score = { 助成: 3, 物品: 2, 寄付: 1, その他: 0 }[m.kind] ?? 0;
  if (/財団|基金|共済|生協|生活協同組合|協同組合|ライオンズ|ロータリー|労働組合|連合/.test(m.funder))
    score += 2;
  if (/助成|基金|プログラム|ファンド|応援/.test(m.program)) score += 1;
  if (/私募債|を通じ|を通した|経由|招待|ご招待|自販機|自動販売機|ふるさと納税|大会/.test(m.program))
    score -= 4;
  return score;
}

function isTracked(key: string, trackedKeys: string[]): boolean {
  return trackedKeys.some(
    (t) =>
      t === key ||
      (t.length >= 4 && key.includes(t)) ||
      (key.length >= 4 && t.includes(key)),
  );
}

/** 団体のページ・活動報告として読むか */
function isOrgPage(url: string): boolean {
  return (
    !BaseScraper.NON_OFFICIAL.test(url) &&
    !BaseScraper.PRESS_RELEASE_SITES.test(url) &&
    !NOT_ORG_PAGE.test(url) &&
    !/\.pdf($|\?)/i.test(url)
  );
}

/** 公式の募集ページとして読むか */
function isOfficialCandidate(url: string): boolean {
  return (
    !BaseScraper.NON_OFFICIAL.test(url) &&
    !BaseScraper.PRESS_RELEASE_SITES.test(url) &&
    !BaseScraper.AGGREGATOR_SITES.test(url) &&
    !NOT_ORG_PAGE.test(url) &&
    !BLOG_OR_NEWS.test(url)
  );
}

type QueueItem =
  | { type: "org"; name: string }
  | { type: "page"; url: string; title: string };

/**
 * 支援元サーチの本体（DBに触らない。入力と依存を差し替えてテストできる）
 */
export async function traceSupporters(
  input: TraceInput,
  deps: TraceDeps,
): Promise<TraceResult> {
  const limits = { ...DEFAULT_LIMITS, ...deps.limits };
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const stats: TraceStats = {
    pages: 0,
    lists: 0,
    mentions: 0,
    checked: 0,
    found: 0,
    searches: 0,
    blocked: false,
  };
  const pages: TracePageRecord[] = [];
  const funders: TraceFunderRecord[] = [];
  const seenPages = new Set(input.recentPages);
  let emptyStreak = 0;

  /** 検索（上限・間隔・ブロック検知つき）。budget はこの段階で使える検索回数の上限 */
  const search = async (
    query: string,
    budget = limits.maxSearches,
  ): Promise<WebSearchResult[]> => {
    if (stats.blocked || stats.searches >= Math.min(budget, limits.maxSearches))
      return [];
    if (stats.searches > 0) await sleep(limits.searchIntervalMs);
    stats.searches++;
    let results: WebSearchResult[] = [];
    try {
      results = await deps.search(query);
    } catch {
      results = [];
    }
    if (results.length === 0) {
      emptyStreak++;
      if (emptyStreak >= limits.maxEmptySearches) {
        stats.blocked = true;
        console.warn(
          `  [${TRACE_LABEL}] 検索の0件が${emptyStreak}回続いたため、検索を止めます（ブロックの可能性）`,
        );
      }
    } else {
      emptyStreak = 0;
    }
    return results;
  };
  // 支援元の公式ページ探しに残しておく検索回数
  const collectBudget = limits.maxSearches - limits.maxFunders;

  /** 採択団体一覧を読み、AIで団体名を取り出す（読めない・失敗なら空） */
  const readAdopted = async (url: string): Promise<AdoptedOrg[]> => {
    const text = await deps.fetchText(url).catch(() => null);
    if (!text) return [];
    try {
      return await deps.ai.extractAdopted(text, url);
    } catch (error) {
      console.warn(
        `  [${TRACE_LABEL}] 採択団体の読み取りに失敗: ${url}`,
        error instanceof Error ? error.message : error,
      );
      return [];
    }
  };

  // 1. 👍の助成金の採択団体一覧から、団体名を集める
  const tokaiOrgs: string[] = [];
  const otherOrgs: string[] = [];
  const orgKeys = new Set<string>();
  for (const g of input.relevantGrants) {
    if (stats.lists >= limits.maxLists) break;
    for (const start of adoptionStartPages(g.manualUrl || g.url)) {
      if (seenPages.has(start)) continue;
      seenPages.add(start);
      pages.push({ url: start, kind: "grant-top", funders: 0 });
      const links = await deps.fetchLinks(start).catch(() => null);
      if (!links) continue;
      const listUrl = findAdoptionLink(links, start);
      if (!listUrl || (listUrl !== start && seenPages.has(listUrl))) continue;
      seenPages.add(listUrl);
      stats.lists++;
      if (listUrl !== start)
        pages.push({ url: listUrl, kind: "adoption-list", funders: 0 });
      let adopted = await readAdopted(listUrl);
      if (adopted.length === 0) {
        // 一覧のページ自体は短く、採択結果がPDFで置かれていることが多い（例: NAGASEこどもみらい財団）
        const pdf = findAdoptionPdf(
          (await deps.fetchLinks(listUrl).catch(() => null)) ?? [],
        );
        if (pdf && !seenPages.has(pdf)) {
          seenPages.add(pdf);
          pages.push({ url: pdf, kind: "adoption-list", funders: 0 });
          adopted = await readAdopted(pdf);
        }
      }
      for (const a of adopted) {
        const key = funderKey(a.name);
        if (!key || orgKeys.has(key)) continue;
        orgKeys.add(key);
        (isTokai(a.prefecture) ? tokaiOrgs : otherOrgs).push(a.name);
      }
      break; // 1つの助成金につき一覧1つ
    }
  }

  // 2. 検索で活動報告・お礼のページを集める
  const tokaiPages: QueueItem[] = [];
  const otherPages: QueueItem[] = [];
  const queued = new Set<string>();
  for (const q of PAGE_QUERIES) {
    const results = await search(q.query, collectBudget);
    for (const r of results) {
      if (!isOrgPage(r.url) || seenPages.has(r.url) || queued.has(r.url))
        continue;
      queued.add(r.url);
      (q.tokai ? tokaiPages : otherPages).push({
        type: "page",
        url: r.url,
        title: r.title,
      });
    }
  }

  // 3. 採択団体のページと、検索で見つけたページを交互に読み、支援元を取り出す
  //    （どちらも東海を先に。片方だけで上限が埋まらないようにする）
  const queue = interleave(
    [...tokaiOrgs, ...otherOrgs].map((name): QueueItem => ({ type: "org", name })),
    [...tokaiPages, ...otherPages],
  );
  const mentions: (SupporterMention & { clue: string; pageUrl: string })[] = [];
  for (const item of queue) {
    if (stats.pages >= limits.maxPages) break;
    let url: string;
    let clue: string;
    let kind: TracePageKind;
    if (item.type === "org") {
      const results = await search(`${item.name} 助成`, collectBudget);
      const hit = results.find((r) => isOrgPage(r.url) && !seenPages.has(r.url));
      if (!hit) continue;
      url = hit.url;
      clue = item.name;
      kind = "org";
    } else {
      url = item.url;
      clue = ""; // ブログ・支援者一覧のページの題名は、レポートに表示しない
      kind = "blog";
    }
    seenPages.add(url);
    stats.pages++;
    const record: TracePageRecord = { url, kind, funders: 0 };
    pages.push(record);
    const text = await deps.fetchText(url).catch(() => null);
    if (!text) continue;
    try {
      const found = await deps.ai.extractSupporters(
        text,
        url,
        item.type === "org" ? item.name : item.title,
      );
      record.funders = found.length;
      mentions.push(...found.map((m) => ({ ...m, clue, pageUrl: url })));
    } catch (error) {
      console.warn(
        `  [${TRACE_LABEL}] 支援元の読み取りに失敗: ${url}`,
        error instanceof Error ? error.message : error,
      );
    }
  }
  stats.mentions = mentions.length;

  // 4. まだ追っていない助成元に絞る
  const trackedKeys = input.trackedOrgs
    .map(funderKey)
    .filter((k) => k.length >= 2);
  const candidates = new Map<
    string,
    SupporterMention & { clue: string; pageUrl: string }
  >();
  for (const m of mentions) {
    const key = funderKey(m.funder);
    if (key.length < 2 || candidates.has(key)) continue;
    if (input.recentFunders.has(key)) continue;
    if (isTracked(key, trackedKeys)) continue;
    if (isOtherMunicipality(m.funder)) continue;
    if (m.clue && key === funderKey(m.clue)) continue;
    candidates.set(key, m);
  }

  // 5. 助成元ごとに公式の募集ページを探す（公募の見込みが高い順。同点は読んだ順＝東海が先）
  const ordered = Array.from(candidates.entries()).sort(
    (a, b) => funderPriority(b[1]) - funderPriority(a[1]),
  );
  for (const [key, m] of ordered) {
    if (stats.checked >= limits.maxFunders || stats.blocked) break;
    const name = searchName(m.funder);
    const query = m.program ? `${name} ${m.program} 募集` : `${name} 助成 募集`;
    const results = await search(query);
    if (stats.blocked) break; // ブロック中に調べられなかった助成元は記録しない
    stats.checked++;
    let found: (OfficialVerdict & { url: string }) | null = null;
    for (const r of results.filter((r) => isOfficialCandidate(r.url)).slice(0, 2)) {
      const text = await deps.fetchText(r.url).catch(() => null);
      if (!text) continue;
      try {
        const verdict = await deps.ai.judgeOfficial(m.funder, m.program, r.url, text);
        if (verdict.openCall && verdict.grantName) {
          found = { ...verdict, url: r.url };
          break;
        }
      } catch (error) {
        console.warn(
          `  [${TRACE_LABEL}] 公式ページの判定に失敗: ${r.url}`,
          error instanceof Error ? error.message : error,
        );
      }
    }
    if (found) stats.found++;
    funders.push({
      key,
      name: m.funder,
      programName: m.program,
      clue: m.clue,
      pageUrl: m.pageUrl,
      result: found ? "found" : "not_found",
      grantName: found?.grantName ?? "",
      grantUrl: found?.url ?? "",
      benefitType: found?.benefitType ?? "不明",
    });
  }

  return { pages, funders, stats };
}

// ---------------------------------------------------------------------------
// AI（Claude）による読み取り
// ---------------------------------------------------------------------------

const BENEFIT_TYPES = ["資金", "物品", "資金＋物品", "その他", "不明"];

const ADOPTED_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["orgs"],
  properties: {
    orgs: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "prefecture"],
        properties: {
          name: { type: "string", description: "採択（助成）された団体名" },
          prefecture: {
            type: "string",
            description: "団体の所在地の都道府県名。わからなければ空文字",
          },
        },
      },
    },
  },
};

const SUPPORTERS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["supporters"],
  properties: {
    supporters: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["funder", "program", "kind"],
        properties: {
          funder: { type: "string", description: "支援した組織の名前" },
          program: {
            type: "string",
            description: "助成金・基金・プログラムの名前。書かれていなければ空文字",
          },
          kind: { type: "string", enum: ["助成", "物品", "寄付", "その他"] },
        },
      },
    },
  },
};

const OFFICIAL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["openCall", "grantName", "benefitType", "reason"],
  properties: {
    openCall: {
      type: "boolean",
      description: "団体向けの助成・物品提供を公募しているページなら true",
    },
    grantName: {
      type: "string",
      description: "助成金・プログラムの名前（年度・回数は付けたままでよい）。無ければ空文字",
    },
    benefitType: { type: "string", enum: BENEFIT_TYPES },
    reason: { type: "string", description: "判断理由（40字以内）" },
  },
};

const ADOPTED_PROMPT = `
あなたはNPOの助成金担当者です。渡された文書は、ある助成金の採択団体（助成先）の一覧です。
採択された団体の名前と所在地（都道府県）を取り出してください。
- 取り出すのは、子ども・子育て・食支援・居場所・学習支援・地域福祉などの市民活動をする団体
  （NPO法人、一般社団法人、社会福祉法人、任意団体など）だけ。
- 大学・研究機関・病院・研究者・個人・行政機関は入れない。助成した側（財団・企業）の名前も入れない。
- 文書が子ども・地域福祉とは別分野（医学研究など）の採択一覧なら、空の配列を返す。
- 愛知県・岐阜県・三重県の団体があれば先に並べる。最大60団体。
- 一覧でなければ空の配列を返す。
`.trim();

const SUPPORTERS_PROMPT = `
あなたはNPOの助成金担当者です。渡されたページは、子ども食堂・子育て支援・学習支援などを行う
団体のサイトやブログです。この団体（または記事に出てくる団体）に、助成金・寄付・物品の提供などで
支援した組織の名前を取り出してください。
- 対象: 財団、企業、生協、信用金庫・銀行、ライオンズクラブ・ロータリークラブ、労働組合、宗教法人など。
- 入れないもの: 個人名、国・都道府県・市区町村などの行政機関、ページを書いた団体自身、
  イベントの共催・後援・会場提供だけの組織、取材したメディア。
- 助成金・基金・プログラムの名前が書かれていれば program に入れる。
- 支援の種類（助成・物品・寄付・その他）を kind に入れる。
- 支援元が書かれていなければ空の配列を返す。最大15件。
`.trim();

const OFFICIAL_PROMPT = `
あなたはNPOの助成金担当者です。指定した組織が、NPOなどの民間団体を対象に、助成金や物品の提供を
公募しているかを、渡されたページで判定してください。
- openCall を true にするのは、指定した組織（またはその事務局）自身のページで、団体が応募できる
  助成・物品提供の制度が案内されている場合。今が募集期間外でも、毎年募集している制度なら true。
- 次の場合は false: ニュース記事、寄付実績・CSR活動の報告だけのページ、個人向けの奨学金・給付、
  別の組織の紹介ページ、応募を受け付けていない（招待制・指定寄付だけの）支援。
- 応募できるのは愛知県長久手市のNPO。対象の地域が限られていて、愛知県の団体が応募できない場合は
  false（例: 北海道内の団体に限る、宮城県内の活動に限る、〇〇市の団体に限る）。全国対象、
  愛知県を含む地域、地域の記載がない場合は true のままでよい。
- 2年以上前の募集案内しかなく、制度が今も続いているか分からない場合は false。
- true のときは、制度の名前を grantName に、支援の種類を benefitType に入れる。
`.trim();

/** APIキーがあれば Claude による読み取りを返す。無ければ null */
export function createTraceAi(): TraceAi | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const client = new Anthropic();

  const ask = async <T>(
    system: string,
    schema: { [key: string]: unknown },
    content: string,
  ): Promise<T> => {
    const response = await client.messages.create({
      model: READ_MODEL,
      // モデルが思考にトークンを使う場合があるため、途中で切れない十分な上限にする
      max_tokens: 8192,
      system,
      output_config: { format: { type: "json_schema", schema } },
      messages: [{ role: "user", content }],
    });
    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      throw new Error(
        `AI応答にテキストがありません（stop_reason: ${response.stop_reason}）`,
      );
    }
    return JSON.parse(textBlock.text) as T;
  };

  return {
    extractAdopted: async (text, sourceUrl) =>
      (
        await ask<{ orgs: AdoptedOrg[] }>(
          ADOPTED_PROMPT,
          ADOPTED_SCHEMA,
          `出典: ${sourceUrl}\n\n--- 本文 ---\n${text}`,
        )
      ).orgs,
    extractSupporters: async (text, pageUrl, clue) =>
      (
        await ask<{ supporters: SupporterMention[] }>(
          SUPPORTERS_PROMPT,
          SUPPORTERS_SCHEMA,
          `ページ: ${pageUrl}\n手がかり（団体名またはページの題名）: ${clue}\n\n--- 本文 ---\n${text}`,
        )
      ).supporters,
    judgeOfficial: async (funder, program, pageUrl, text) =>
      ask<OfficialVerdict>(
        OFFICIAL_PROMPT,
        OFFICIAL_SCHEMA,
        [
          `組織: ${funder}`,
          program ? `手がかりの制度名: ${program}` : "",
          `ページURL: ${pageUrl}`,
          "",
          "--- ページ本文 ---",
          text,
        ]
          .filter((line) => line !== "")
          .join("\n"),
      ),
  };
}

// ---------------------------------------------------------------------------
// 実行（DBを読み、本体を動かし、結果を記録する）
// ---------------------------------------------------------------------------

const linkClient = axios.create({
  timeout: 30000,
  headers: {
    "User-Agent": "GrantSearch/1.0 (NPO Grant Research Tool)",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "ja,en;q=0.5",
  },
});

async function fetchLinks(url: string): Promise<PageLink[] | null> {
  try {
    const response = await linkClient.get(url, { responseType: "text" });
    return extractLinks(String(response.data), url);
  } catch {
    return null;
  }
}

const daysAgo = (now: Date, days: number) =>
  new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();

/** 支援元サーチを1回実行し、結果をDBに記録する。見つかった助成金の数を返す */
export async function runSupporterTrace(): Promise<TraceStats | null> {
  const ai = createTraceAi();
  if (!ai) {
    console.log(`  [${TRACE_LABEL}] APIキーが未設定のため実行しません`);
    return null;
  }
  const now = new Date();
  const runAt = now.toISOString();
  const db = getDatabase();
  try {
    const all = getAllGrants(db);
    const input: TraceInput = {
      relevantGrants: all.filter((g) => g.humanJudgment === "関係あり"),
      trackedOrgs: all.flatMap((g) => [
        g.organization,
        ...g.aliases.map((a) => a.organization),
      ]),
      recentPages: getRecentTracePages(db, daysAgo(now, PAGE_REVISIT_DAYS)),
      recentFunders: getRecentTraceFunders(db, daysAgo(now, FUNDER_RECHECK_DAYS)),
    };
    console.log(
      `\n🧭 ${TRACE_LABEL}を開始します（👍の助成金 ${input.relevantGrants.length}件を起点）`,
    );
    let result: TraceResult;
    try {
      result = await traceSupporters(input, {
        ai,
        fetchText: fetchSourceText,
        fetchLinks,
        search: (q) => searchWeb(q, TRACE_LABEL),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      saveTraceResult(
        db,
        runAt,
        {
          pages: [],
          funders: [],
          stats: { pages: 0, lists: 0, mentions: 0, checked: 0, found: 0, searches: 0, blocked: false },
        },
        message,
      );
      throw error;
    }
    saveTraceResult(db, runAt, result, result.stats.blocked ? "検索がブロックされた可能性" : undefined);
    const s = result.stats;
    console.log(
      `  → 読んだページ ${s.pages}件（採択団体一覧 ${s.lists}件）・取り出した支援元 ${s.mentions}件・` +
        `調べた助成元 ${s.checked}件・見つかった助成金 ${s.found}件（検索 ${s.searches}回）`,
    );
    for (const f of result.funders.filter((f) => f.result === "found")) {
      console.log(`   ・${f.grantName}（${f.name}／手がかり: ${f.clue}）`);
    }
    return s;
  } finally {
    db.close();
  }
}

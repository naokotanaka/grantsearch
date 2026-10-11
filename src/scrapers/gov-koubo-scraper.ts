import Anthropic from "@anthropic-ai/sdk";
import * as cheerio from "cheerio";
import { BaseScraper } from "./base-scraper";
import { lastDeadlineDate } from "./dedupe";
import { Grant } from "../models/grant";
import { READ_MODEL } from "../enrich/ai-enricher";

/**
 * 国の公募（委託の企画競争・補助事業者の公募など）
 *
 * 省庁などの公募一覧ページ（GOV_SITES）を毎週読み、新しく載ったリンクの題名を
 * AIでまとめて振り分ける。ながいくが応募できそうなものだけを、月曜の検索の候補にする
 * （公式ページの読み取り・応募可否の判定は、他の情報源と同じ ai-enricher が行う）。
 * 見たリンクは gov_items に記録し、次の週からは新しいリンクだけをAIに渡す。
 * 設計: 2026-10-11 の相談（全省庁統一資格は取る予定なので、委託も対象にする）
 */

export interface GovSite {
  key: string;
  /** 一覧ページの名前（対象事業の欄の初期表示に使う） */
  label: string;
  /** 助成元の欄に表示する名前 */
  ministry: string;
  url: string;
  /** リンクを読む範囲（CSSセレクタ）。サイト全体のメニューを読まないため */
  scope: string;
  /** リンク先のURLの条件（一覧の中に公募以外のリンクが多いページ用） */
  hrefFilter?: RegExp;
}

/**
 * 読む公募一覧ページ（2026-10-11 の調査で、ながいく向けの公募が出ると確かめたもの）。
 * 消費者庁・文部科学省・厚生労働省の一覧は、ながいく向けがほとんど出ないため入れていない。
 */
export const GOV_SITES: GovSite[] = [
  {
    key: "cfa",
    label: "こども家庭庁 調達情報",
    ministry: "こども家庭庁",
    url: "https://www.cfa.go.jp/procurement",
    scope: "main",
  },
  {
    key: "maff",
    label: "農林水産省 補助事業参加者の公募",
    ministry: "農林水産省",
    url: "https://www.maff.go.jp/j/supply/hozyo/index.html",
    scope: "table.datatable",
  },
  {
    key: "cao_kodoku",
    label: "内閣府 孤独・孤立対策",
    ministry: "内閣府",
    url: "https://www.cao.go.jp/kodoku_koritsu/index.html",
    scope: "body",
  },
  {
    key: "kyumin",
    label: "休眠預金 実行団体の公募一覧",
    ministry: "休眠預金の資金分配団体",
    url: "https://players-koubolist.kyuplat.com/",
    scope: "body",
    hrefFilter: /\/result\/\d+/,
  },
  {
    key: "isa",
    label: "出入国在留管理庁 公募",
    ministry: "出入国在留管理庁",
    url: "https://www.moj.go.jp/isa/publications/procurement/isa_shiryoteikyo_00008.html",
    scope: "#contentsArea",
  },
];

/** 1ページから読むリンクの上限（どのページも新しいものが上に並ぶ） */
const MAX_LINKS_PER_SITE = 100;
/** AIにまとめて渡す題名の数 */
const SCREEN_BATCH = 50;
/** 対象と判定した公募を、月曜の検索に取り込む期間（見つけてからの日数） */
export const GOV_CANDIDATE_DAYS = 120;

export interface GovLink {
  url: string;
  title: string;
  /** 表の行の文字（公告日・締切など）。表でなければ空 */
  context: string;
  siteKey: string;
}

export interface GovScreenResult {
  index: number;
  relevant: boolean;
  /** 公募の名前（題名を短く整えたもの） */
  name: string;
  /** 公募している団体名（題名からわかれば） */
  organization: string;
  reason: string;
}

/** 題名をまとめて振り分ける関数（テストでは固定応答に差し替える） */
export type GovScreen = (links: GovLink[]) => Promise<GovScreenResult[]>;

/** gov_items に記録する1件 */
export interface GovItem {
  url: string;
  siteKey: string;
  title: string;
  name: string;
  organization: string;
  relevant: boolean;
  reason: string;
}

const clean = (text: string) => text.replace(/[\s\n\r\t]+/g, " ").trim();

/**
 * 一覧ページのHTMLから、公募らしいリンクを取り出す。
 * 表の行に締切の日付があり、すでに過ぎていれば除く。
 */
export function extractGovLinks(
  html: string,
  site: GovSite,
  now: Date,
): GovLink[] {
  const $ = cheerio.load(html);
  $("script, style, nav, header, footer").remove();
  const links: GovLink[] = [];
  const seen = new Set<string>();
  $(site.scope)
    .find("a[href]")
    .each((_, el) => {
      if (links.length >= MAX_LINKS_PER_SITE) return false;
      const title = clean($(el).text());
      if (title.length < 10) return;
      let url: string;
      try {
        url = new URL($(el).attr("href") ?? "", site.url).toString();
      } catch {
        return;
      }
      if (!/^https?:\/\//.test(url) || seen.has(url)) return;
      if (site.hrefFilter && !site.hrefFilter.test(url)) return;
      const row = $(el).closest("tr");
      const context = row.length ? clean(row.text()) : "";
      if (context) {
        const deadline = lastDeadlineDate(context.replace(title, ""));
        if (deadline && deadline < now) return;
      }
      seen.add(url);
      links.push({ url, title, context, siteKey: site.key });
    });
  return links;
}

export interface GovCollectResult {
  /** 今回新しく見たリンク（対象かどうかの判定つき）。AIが失敗した分は含めない */
  items: GovItem[];
  siteResults: { key: string; label: string; links: number; error?: string }[];
  /** AIの振り分けに失敗したときのメッセージ */
  screenError?: string;
}

/** 公募一覧ページを読み、新しいリンクをAIで振り分ける（DBに触らない） */
export async function collectGovKoubo(
  input: { seenUrls: Set<string> },
  deps: {
    fetchHtml: (url: string) => Promise<string>;
    screen: GovScreen;
    now?: Date;
    sites?: GovSite[];
  },
): Promise<GovCollectResult> {
  const now = deps.now ?? new Date();
  const sites = deps.sites ?? GOV_SITES;
  const siteResults: GovCollectResult["siteResults"] = [];
  const fresh: GovLink[] = [];
  for (const site of sites) {
    try {
      const links = extractGovLinks(await deps.fetchHtml(site.url), site, now);
      siteResults.push({ key: site.key, label: site.label, links: links.length });
      fresh.push(...links.filter((l) => !input.seenUrls.has(l.url)));
    } catch (error) {
      siteResults.push({
        key: site.key,
        label: site.label,
        links: 0,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const items: GovItem[] = [];
  for (let i = 0; i < fresh.length; i += SCREEN_BATCH) {
    const batch = fresh.slice(i, i + SCREEN_BATCH);
    let results: GovScreenResult[];
    try {
      results = await deps.screen(batch);
    } catch (error) {
      // 失敗した分は記録しない（見たリンクにならないので、次の週にもう一度判定する）
      return {
        items,
        siteResults,
        screenError: error instanceof Error ? error.message : String(error),
      };
    }
    const byIndex = new Map(results.map((r) => [r.index, r]));
    batch.forEach((link, index) => {
      const r = byIndex.get(index);
      items.push({
        url: link.url,
        siteKey: link.siteKey,
        title: link.title,
        name: r?.name ?? "",
        organization: r?.organization ?? "",
        relevant: r?.relevant ?? false,
        reason: r?.reason ?? "判定なし",
      });
    });
  }
  return { items, siteResults };
}

const SCREEN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["index", "relevant", "name", "organization", "reason"],
        properties: {
          index: { type: "integer", description: "渡した一覧の番号" },
          relevant: { type: "boolean", description: "依頼元が応募できそうなら true" },
          name: {
            type: "string",
            description: "公募の名前（題名から「の公募について」などを除いて短く整えたもの、60字以内）",
          },
          organization: {
            type: "string",
            description: "公募している団体名が題名からわかれば。わからなければ空文字",
          },
          reason: { type: "string", description: "判断理由（30字以内）" },
        },
      },
    },
  },
};

const SCREEN_PROMPT = `
あなたはNPOの助成金担当者です。省庁などの公募一覧ページに載っている題名の一覧を渡すので、
依頼元が応募できそうなものを選んでください。

【依頼元】愛知県長久手市のNPO法人。子ども食堂・フードパントリー・子育てひろば・地域子育て相談
（市の委託）・不登校の子の居場所・学習支援・外国にルーツを持つ人の支援・ひとり親家庭の支援を行う。
こども家庭庁の委託事業の実績がある。全省庁統一資格は取る予定。調査研究の専門機関ではない。

【relevant を true にするもの】
- 子ども・子育て、ひとり親、ヤングケアラー、食支援（こども食堂・食品の提供・食育・食品アクセス）、
  居場所づくり、孤独・孤立対策、外国人の生活支援、地域福祉などの事業で、NPOなどの民間団体が
  実施団体・補助事業者・受託者として応募できそうなもの（委託・補助・モデル事業）。
- 判断に迷うものは true（あとで公式ページを読んで確かめる）。

【relevant を false にするもの】
- 調査研究・分析・効果検証だけが目的の委託、広報・イベント運営だけの委託。
- 情報システム、物品、工事、施設管理、会計・事務の委託。
- 農業・畜産・水産の生産・流通・輸出、エネルギー、研究開発。
- 自治体・企業・大学だけが応募できるもの、地域が限られていて愛知県が入らないもの
  （例: 北海道・東北地域だけの事業）。
- 会議・お知らせ・結果の公表など、公募ではないもの。

渡した全部の番号について、1件ずつ答えてください。
`.trim();

/** APIキーがあれば Claude による振り分けを返す。無ければ null */
export function createGovScreen(): GovScreen | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const client = new Anthropic();
  return async (links) => {
    const list = links
      .map(
        (l, i) =>
          `${i}: ${l.title}${l.context && l.context !== l.title ? `（${l.context.slice(0, 80)}）` : ""}`,
      )
      .join("\n");
    const response = await client.messages.create({
      model: READ_MODEL,
      // モデルが思考にトークンを使う場合があるため、途中で切れない十分な上限にする
      max_tokens: 16000,
      system: SCREEN_PROMPT,
      output_config: { format: { type: "json_schema", schema: SCREEN_SCHEMA } },
      messages: [{ role: "user", content: `題名の一覧:\n${list}` }],
    });
    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      throw new Error(
        `AI応答にテキストがありません（stop_reason: ${response.stop_reason}）`,
      );
    }
    return (JSON.parse(textBlock.text) as { items: GovScreenResult[] }).items;
  };
}

/** gov_items から取り出した、月曜の検索に取り込む公募 */
export interface GovRecord {
  url: string;
  siteKey: string;
  title: string;
  name: string;
  organization: string;
}

/**
 * 対象と判定した国の公募を、月曜の検索の候補にする（ページは読まない）。
 * 以降は他の情報源と同じく、まとめ・AI読み取り・応募可否の判定を通る。
 */
export class GovKouboScraper extends BaseScraper {
  constructor(private records: GovRecord[]) {
    super("gov", "全国");
  }

  async search(): Promise<Grant[]> {
    return this.records.map((r) => {
      const site = GOV_SITES.find((s) => s.key === r.siteKey);
      return this.createGrant({
        // URL＋一覧ページから決める（毎週同じ公募が同じ id になる）
        id: this.generateId(r.url, r.siteKey),
        name: r.name || r.title,
        organization: r.organization || site?.ministry || "要確認",
        targetProjects: site ? `${site.label}に掲載` : "",
        url: r.url,
        status: "不明",
      });
    });
  }
}

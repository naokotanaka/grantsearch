import Anthropic from "@anthropic-ai/sdk";
import axios from "axios";
import * as cheerio from "cheerio";
import { Grant, Eligibility } from "../models/grant";

/**
 * 公式ページ読み取りによる詳細情報の充填（AIエンリッチメント）
 *
 * 各助成金の公式ページ本文を取得し、Claude に読ませて
 * - 当団体が応募できるか（対象団体・対象地域・活動分野で判断）
 * - 対象団体、助成額、期間、締切、人件費/謝金/家賃の可否、一言要約
 * を構造化データとして抽出する。「対象外」と判断されたものは掲載しない。
 *
 * ANTHROPIC_API_KEY 未設定時は、無料のルールベース抽出にフォールバックする
 * （精度は落ちるが動作は続く）。
 */

/** 当団体のプロフィール（応募可否判断のためにAIへ渡す） */
const NPO_PROFILE = `
- 愛知県長久手市で活動する非営利団体
- 活動分野: 子育て支援、子ども食堂・フードパントリー、外国にルーツを持つ人の支援、児童の居場所づくり、学習支援
- 被災地支援・災害復興支援は行わない
- 全国対象・愛知県対象・長久手市対象の助成金に応募できる（他の都道府県・市町村限定は不可）
`.trim();

/** モデル（環境変数で上書き可。既定は軽量・低コストの Haiku） */
const MODEL = process.env.CLAUDE_MODEL ?? "claude-haiku-4-5";

/** 1回の実行で読み取る公式ページの上限（コスト暴走の防止） */
const MAX_PAGES = 150;

/** ページ本文をAIに渡す際の最大文字数 */
const MAX_TEXT_LENGTH = 8000;

interface ExtractionResult {
  applicable: "可能" | "対象外" | "要確認";
  reason: string;
  targetOrganizations: string;
  grantAmount: string;
  grantPeriod: string;
  applicationDeadline: string;
  personnelCosts: Eligibility;
  honorarium: Eligibility;
  rent: Eligibility;
  summary: string;
}

const ELIGIBILITY_ENUM = ["可", "不可", "要確認", "不明"];

/** 構造化出力のスキーマ（Claude の応答をこの形に強制する） */
const EXTRACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "applicable",
    "reason",
    "targetOrganizations",
    "grantAmount",
    "grantPeriod",
    "applicationDeadline",
    "personnelCosts",
    "honorarium",
    "rent",
    "summary",
  ],
  properties: {
    applicable: {
      type: "string",
      enum: ["可能", "対象外", "要確認"],
      description: "この団体がこの助成金に応募できるか",
    },
    reason: {
      type: "string",
      description: "応募可否の判断理由（40字以内・1文）",
    },
    targetOrganizations: {
      type: "string",
      description:
        "応募できる団体の条件の要点だけ（60字以内。例:「愛知県内の子ども食堂運営団体・法人格不問」）。ページに記載がなければ「不明」",
    },
    grantAmount: {
      type: "string",
      description:
        "助成額（上限など・50字以内）。資金でなく物品支給（食材・ギフトコード・商品券・物品寄贈等）の場合は「物品：内容」の形で書く。資金と物品の両方なら「◯万円＋物品：内容」。記載がなければ「不明」",
    },
    grantPeriod: {
      type: "string",
      description: "助成対象期間。記載がなければ「不明」",
    },
    applicationDeadline: {
      type: "string",
      description: "申込期間・締切。記載がなければ「不明」",
    },
    personnelCosts: {
      type: "string",
      enum: ELIGIBILITY_ENUM,
      description: "人件費に使えるか",
    },
    honorarium: {
      type: "string",
      enum: ELIGIBILITY_ENUM,
      description: "謝金に使えるか",
    },
    rent: {
      type: "string",
      enum: ELIGIBILITY_ENUM,
      description: "家賃・賃借料に使えるか",
    },
    summary: {
      type: "string",
      description: "この助成金の内容の一言要約（40字以内）",
    },
  },
} as const;

const SYSTEM_PROMPT = `あなたは日本のNPOの助成金調査担当です。助成金の公式ページ本文を読み、依頼された項目を正確に抽出します。

【依頼元の団体】
${NPO_PROFILE}

【ルール】
- ページに書かれていることだけを使う。推測で埋めない。書かれていなければ「不明」とする。
- applicable（応募可否）は、対象団体の条件・対象地域・活動分野の3点で判断する。
  - 他の都道府県・市町村限定（例: 京都市内の団体のみ）→「対象外」
  - 被災地支援・災害復興支援に限定された助成 →「対象外」
  - 活動分野が明らかに無関係（環境保全のみ、芸術のみ等）→「対象外」
  - 判断材料が不足している場合 →「要確認」（安易に対象外にしない）
- 経費（人件費・謝金・家賃）は、対象経費・使途の記載から判断。記載がなければ「不明」。
- 抽出結果はレポートの表のセルに入る。**長い引用ではなく要点の要約**にすること。
  文字数上限（summary 40字・targetOrganizations 60字・reason 40字・grantAmount 50字）を守る。
- 助成が資金ではなく物品（食材・ギフトコード・商品券・物品寄贈等）の場合、
  grantAmount は必ず「物品：」で始める（例:「物品：フルーツ5〜7万円相当」）。`;

/** AIクライアント（キー未設定なら null＝フォールバックモード） */
function getClient(): Anthropic | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  return new Anthropic();
}

/** ページ取得用の axios（スクレイパーと同じ礼儀正しい設定） */
const httpClient = axios.create({
  timeout: 30000,
  headers: {
    "User-Agent": "GrantSearch/1.0 (NPO Grant Research Tool)",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "ja,en;q=0.5",
  },
});

/** 公式ページの本文テキストを取得（スクリプト等を除去して圧縮） */
export async function fetchPageText(url: string): Promise<string | null> {
  try {
    const response = await httpClient.get(url, { responseType: "text" });
    const $ = cheerio.load(response.data);
    $("script, style, nav, footer, header, noscript, iframe").remove();
    const text = $("body")
      .text()
      .replace(/[\s\n\r\t]+/g, " ")
      .trim();
    return text.length > 200 ? text.slice(0, MAX_TEXT_LENGTH) : null; // 短すぎるページは情報なしとみなす
  } catch {
    return null;
  }
}

/** エンリッチメント対象かどうか（読みに行く価値のあるURLか） */
function isEnrichable(grant: Grant): boolean {
  if (!/^https?:\/\//.test(grant.url)) return false;
  if (/\.pdf($|[?#])/i.test(grant.url)) return false;
  if (/news\.google\.com/.test(grant.url)) return false; // 転送URLは読めない
  return (
    grant.status === "募集中" ||
    grant.status === "募集前" ||
    grant.status === "不明"
  );
}

/**
 * 全助成金の公式ページを読み、詳細情報を充填する。
 * 「対象外」と判断されたものはリストから除外して返す。
 */
export async function enrichGrants(grants: Grant[]): Promise<Grant[]> {
  const client = getClient();
  if (client) {
    console.log(
      `\n🤖 公式ページをAIで読み取り中（モデル: ${MODEL}、対象 ${Math.min(grants.filter(isEnrichable).length, MAX_PAGES)}件）...`,
    );
  } else {
    console.log(
      "\nℹ ANTHROPIC_API_KEY が未設定のため、ルールベースの簡易抽出で公式ページを読み取ります",
    );
    console.log(
      "  （GitHub の Settings → Secrets and variables → Actions に ANTHROPIC_API_KEY を登録するとAI読み取りが有効になります）",
    );
  }

  const result: Grant[] = [];
  let processed = 0;
  let excluded = 0;

  for (const grant of grants) {
    if (!isEnrichable(grant) || processed >= MAX_PAGES) {
      result.push(grant);
      continue;
    }
    processed++;

    const pageText = await fetchPageText(grant.url);
    if (!pageText) {
      result.push(grant); // ページが読めなければそのまま掲載
      continue;
    }

    try {
      if (client) {
        const extraction = await extractWithAI(client, grant, pageText);
        if (extraction.applicable === "対象外") {
          excluded++;
          console.log(
            `  ✗ 対象外: ${grant.name.slice(0, 40)}（${extraction.reason.slice(0, 50)}）`,
          );
          continue; // 掲載しない
        }
        result.push(applyExtraction(grant, extraction));
      } else {
        result.push(applyHeuristics(grant, pageText));
      }
    } catch (error) {
      console.error(
        `  ⚠ 読み取り失敗: ${grant.name.slice(0, 30)} - ${error instanceof Error ? error.message : error}`,
      );
      result.push(grant); // 失敗時はそのまま掲載
    }
  }

  console.log(
    `  → ${processed}ページを読み取り、対象外 ${excluded}件を除外しました`,
  );
  return result;
}

/** Claude に公式ページを読ませて構造化データを抽出する */
async function extractWithAI(
  client: Anthropic,
  grant: Grant,
  pageText: string,
): Promise<ExtractionResult> {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    output_config: {
      format: { type: "json_schema", schema: EXTRACTION_SCHEMA },
    },
    messages: [
      {
        role: "user",
        content: `以下は助成金「${grant.name}」（${grant.organization}）の公式ページ本文です。指定の項目を抽出してください。\n\n---\n${pageText}`,
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("AI応答にテキストがありません");
  }
  return JSON.parse(textBlock.text) as ExtractionResult;
}

/** AIが文字数上限を守らなかったときの保険（上限で切って「…」を付ける） */
function clamp(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 抽出結果を Grant に反映（既に良い値がある項目は上書きしない） */
function applyExtraction(grant: Grant, ex: ExtractionResult): Grant {
  const isEmpty = (v: string) =>
    !v || v === "要確認" || v === "不明" || v.startsWith("要確認");
  const pick = (current: string, extracted: string) =>
    isEmpty(current) && !isEmpty(extracted) ? extracted : current;

  // 対象団体＋要約を「対象事業」欄に表示（応募可否の判断材料が一目で分かるように）
  const targetInfo = [
    ex.summary && ex.summary !== "不明" ? clamp(ex.summary, 40) : "",
    ex.targetOrganizations && ex.targetOrganizations !== "不明"
      ? `【対象】${clamp(ex.targetOrganizations, 60)}`
      : "",
    ex.applicable === "要確認" ? `【要確認】${clamp(ex.reason, 40)}` : "",
  ]
    .filter(Boolean)
    .join(" ");

  return {
    ...grant,
    targetProjects: targetInfo || grant.targetProjects,
    grantAmount: pick(grant.grantAmount, clamp(ex.grantAmount, 60)),
    grantPeriod: pick(grant.grantPeriod, ex.grantPeriod),
    applicationDeadline: pick(
      grant.applicationDeadline,
      ex.applicationDeadline,
    ),
    personnelCosts:
      grant.personnelCosts === "不明"
        ? ex.personnelCosts
        : grant.personnelCosts,
    honorarium: grant.honorarium === "不明" ? ex.honorarium : grant.honorarium,
    rent: grant.rent === "不明" ? ex.rent : grant.rent,
  };
}

/** キー未設定時のルールベース抽出（AIより粗いが無料） */
function applyHeuristics(grant: Grant, pageText: string): Grant {
  const isEmpty = (v: string) =>
    !v || v === "要確認" || v === "不明" || v.startsWith("要確認");
  const updated = { ...grant };

  // 助成額
  if (isEmpty(updated.grantAmount)) {
    const amount =
      pageText.match(
        /(?:助成|補助)(?:金額|額|上限)[^。]{0,10}?([0-9,０-９]+\s*万?円[^。、\s]{0,10})/,
      ) ?? pageText.match(/上限[^。]{0,6}?([0-9,０-９]+\s*万円)/);
    if (amount) updated.grantAmount = amount[1];
  }

  // 経費の可否
  const expenses = detectExpenses(pageText);
  if (updated.personnelCosts === "不明")
    updated.personnelCosts = expenses.personnelCosts;
  if (updated.honorarium === "不明") updated.honorarium = expenses.honorarium;
  if (updated.rent === "不明") updated.rent = expenses.rent;

  // 対象団体
  if (isEmpty(updated.targetProjects)) {
    const target = pageText.match(
      /(?:助成)?対象(?:となる)?(?:団体|者)[^。]{0,5}[：:は]?\s*([^。]{10,80})/,
    );
    if (target) updated.targetProjects = `【対象】${target[1].trim()}`;
  }

  return updated;
}

function detectExpenses(text: string): {
  personnelCosts: Eligibility;
  honorarium: Eligibility;
  rent: Eligibility;
} {
  const result = {
    personnelCosts: "不明" as Eligibility,
    honorarium: "不明" as Eligibility,
    rent: "不明" as Eligibility,
  };
  if (/人件費/.test(text)) {
    result.personnelCosts =
      /人件費[^。]{0,20}(不可|除く|対象外|認められません)/.test(text)
        ? "不可"
        : "可";
  }
  if (/謝金|謝礼/.test(text)) {
    result.honorarium = /(謝金|謝礼)[^。]{0,20}(不可|除く|対象外)/.test(text)
      ? "不可"
      : "可";
  }
  if (/家賃|賃借料/.test(text)) {
    result.rent = /(家賃|賃借料)[^。]{0,20}(不可|除く|対象外)/.test(text)
      ? "不可"
      : "可";
  }
  return result;
}

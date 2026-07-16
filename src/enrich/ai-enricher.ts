import Anthropic from "@anthropic-ai/sdk";
import axios from "axios";
import * as cheerio from "cheerio";
import { PDFParse } from "pdf-parse";
import { Grant, Eligibility, BenefitType } from "../models/grant";

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
- 愛知県長久手市に所在し活動するNPO法人（法人格あり）。**長久手市内の団体**なので、
  長久手市限定・愛知県限定の助成・補助にも応募できる
- 活動分野: 子育て支援、子ども食堂・フードパントリー、外国にルーツを持つ人の支援、児童の居場所づくり、学習支援
- 被災地支援・災害復興支援は行わない
- フードバンクの運営は行わない（フードパントリー・子ども食堂は行う）
- 障害・病気のある子どもに特化した支援（小児がん・難病・医療的ケア・障がい児支援等）は行わない
- こども家庭庁・長久手市の委託事業、WAM（福祉医療機構）助成、日本財団助成などの採択実績がある
  （WAM助成のような大型・連携型の助成にも応募できる。応募要件を推測で厳しく解釈しない）
- 全国対象・愛知県対象・長久手市対象の助成金に応募できる（他の都道府県・市町村限定は不可。
  長久手市は名古屋市ではないため、名古屋市限定の助成・補助にも応募できない）
`.trim();

/** モデル（環境変数で上書き可。既定は軽量・低コストの Haiku） */
const MODEL = process.env.CLAUDE_MODEL ?? "claude-haiku-4-5";

/** 1回の実行で読み取る公式ページの上限（コスト暴走の防止） */
const MAX_PAGES = 150;

/** AIに渡すテキストの上限（ページ本文＋添付PDFの合計） */
const PAGE_TEXT_LIMIT = 6000;
const PDF_TEXT_LIMIT = 3000;
/** ページからたどって読む募集要項PDFの上限数 */
const MAX_LINKED_PDFS = 2;
/** PDFのダウンロード上限（バイト） */
const MAX_PDF_BYTES = 10 * 1024 * 1024;

interface ExtractionResult {
  applicable: "可能" | "対象外" | "要確認";
  reason: string;
  targetOrganizations: string;
  grantAmount: string;
  benefitType: BenefitType;
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
    "benefitType",
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
        "応募条件のうち絞り込みに効く要点だけ（40字以内。例:「愛知県内の子ども食堂運営団体」「活動実績2年以上」）。「非営利法人・団体」「NPO等」のような当然の条件、「法人格不問」「法人格がなくても可」のような緩和条件は書かない。絞り込み条件がなければ空文字。ページに記載がなければ「不明」",
    },
    grantAmount: {
      type: "string",
      description:
        "助成額の上限の数字だけ（例:「10万」「500万」「1億」）。範囲表記は上限側だけ取る（「5〜10万円」→「10万」）。「上限」の語・「円」・下限・「総額」「減額される場合あり」等の語は一切付けない。物品支給のみ内容と金額相当を書く（例:「フルーツ5〜7万円相当」）。記載がなければ「不明」",
    },
    benefitType: {
      type: "string",
      enum: ["資金", "物品", "資金＋物品", "その他", "不明"],
      description:
        "助成の種別。金銭の支給=「資金」、物品そのものの寄付・寄贈（食材・本・おもちゃ・ギフトコード・商品券など現物支給）=「物品」、両方=「資金＋物品」、表彰・人材派遣など=「その他」。物品の購入費用としてお金が出るもの（物品購入補助・備品購入費補助等）は現物ではないので「資金」",
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
      description:
        "何への助成かの一言（30字以内。例:「事業運営資金」「学習支援活動への助成」）。金額・締切・対象団体はここに書かない（別の欄がある）",
    },
  },
} as const;

const SYSTEM_PROMPT = `あなたは日本のNPOの助成金調査担当です。助成金の公式ページ本文を読み、依頼された項目を正確に抽出します。

【依頼元の団体】
${NPO_PROFILE}

【ルール】
- ページに書かれていることだけを使う。推測で埋めない。書かれていなければ「不明」とする。
- applicable（応募可否）は、対象団体の条件・対象地域・活動分野の3点で判断する。
  **判断の根拠は「対象団体」「応募資格」の定義部分**。本文のどこかに「子ども食堂」等の
  語が登場するだけでは対象と判断しない（例: フードバンク向け助成の説明文中に
  「集めた食品を子ども食堂へ提供」とあっても、応募できるのはフードバンクだけ）。
  - 他の都道府県・市町村限定（例: 京都市内の団体のみ、名古屋市内の子ども食堂のみ、
    千葉県・埼玉県・東京都に活動拠点がある団体のみ）→「対象外」。
    依頼元は長久手市の団体。名古屋市は隣接するが別の市なので、名古屋市限定には応募できない
    （愛知県全域が対象なら応募できる）
  - **地域の要件を読み取ったら、愛知県長久手市がその地域に含まれるか必ず確認して
    applicable に反映する**。含まれないのに「可能」にしない（targetOrganizations に
    地域を書くだけで済ませない）。
  - **地域の制限は、本文に明記された応募要件（「〇〇県内の団体」「〇〇に活動拠点が
    あること」等）だけを根拠にする**。主催団体・財団の所在地・住所を対象地域の制限と
    混同しない。自分の知識で地域制限を推測して作らない。明記がなければ地域制限なし
    （全国）として扱う。
  - 被災地支援・災害復興支援に限定された助成 →「対象外」
  - フードバンク関連の助成（フードバンクの立上げ・機能強化・食品の受入や保管・
    食料提供体制の整備等が主目的）→「対象外」。応募区分に子ども食堂等が含まれて
    いても、フードバンク事業が主軸なら対象外。子ども食堂・フードパントリーの
    活動自体への助成であれば対象。
  - 障害・病気のある子ども（小児がん・難病・医療的ケア児・障がい児等）とその家族への
    支援に限定された助成 →「対象外」（対象分野の一つとして含むだけなら対象外にしない）
  - 活動分野が明らかに無関係（環境保全のみ、芸術のみ等）→「対象外」
  - 判断材料が不足している場合 →「要確認」（安易に対象外にしない）
  - **「募集が終了している」「締切を過ぎている」は対象外の理由にしない**。毎年恒例の
    助成は翌年度また応募できるため、締切切れでも掲載を続ける（応募可否は
    団体・地域・分野だけで判断する）。
- 経費（人件費・謝金・家賃）は、対象経費・使途の記載から判断。記載がなければ「不明」。
- 抽出結果はレポートの表のセルに入る。**長い引用ではなく要点だけ**にすること。
  文字数上限（summary 30字・targetOrganizations 40字・reason 40字・grantAmount 30字）を守る。
- **当然のことは書かない**（レポートの読み手はNPO法人の助成金担当者）：
  - 「非営利法人・団体が対象」「NPO等が対象」→ NPO向け助成では当然なので書かない
  - 「法人格不問」「法人格がなくても実績があれば可」→ 依頼元は法人格のあるNPO法人
    なので無意味。書かない
  - 「減額される場合あり」「選考により決定」「予算の範囲内で」→ どの助成金でも当然
    なので書かない。助成額は額面だけ書く
- benefitType（種別）: 「物品」とは物品そのものを寄付・寄贈される現物支給のこと
  （食材・本・おもちゃ・ギフトコード・商品券など）。金銭が支給されるものは、使途が
  物品の購入に限られていても（物品購入補助等）現物支給ではないので「資金」。
  両方なら「資金＋物品」、表彰・人材派遣などなら「その他」。
- 本文に【添付PDF】の見出しが付いた部分は、そのページからリンクされた募集要項PDFの
  内容である。本文より詳しいことが多いので、経費の可否や締切はPDF側も必ず確認する。
- **申請書の様式・記入例・記入見本を応募条件と混同しない**。記入例の団体名・住所・
  事業内容はあくまで見本であり、応募資格ではない。提出先・主催団体の住所も同様。`;

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

/** URLがPDFを指しているか */
function isPdfUrl(url: string): boolean {
  return /\.pdf($|[?#])/i.test(url);
}

/** PDFをダウンロードして本文テキストを抽出する（失敗時は null） */
async function fetchPdfText(url: string): Promise<string | null> {
  try {
    const response = await httpClient.get(url, {
      responseType: "arraybuffer",
      maxContentLength: MAX_PDF_BYTES,
    });
    const parser = new PDFParse({ data: Buffer.from(response.data) });
    try {
      const result = await parser.getText();
      const text = result.text.replace(/[\s\n\r\t]+/g, " ").trim();
      return text.length > 100 ? text : null; // 画像だけのPDF等は情報なしとみなす
    } finally {
      await parser.destroy();
    }
  } catch {
    return null;
  }
}

/**
 * ページ内から「募集要項らしいPDF」へのリンクを最大 MAX_LINKED_PDFS 件拾う。
 * 要項系の語を含むリンクを優先し、足りなければ単なるPDFリンクで補う。
 */
function findPdfLinks($: cheerio.CheerioAPI, pageUrl: string): string[] {
  const KEYWORD = /募集要項|実施要領|応募要領|申請要領|要項|要領|募集案内/;
  const preferred: string[] = [];
  const others: string[] = [];

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") ?? "";
    if (!isPdfUrl(href)) return;
    let resolved: string;
    try {
      resolved = new URL(href, pageUrl).toString();
    } catch {
      return;
    }
    const label = `${$(el).text()} ${href}`;
    (KEYWORD.test(label) ? preferred : others).push(resolved);
  });

  return [...new Set([...preferred, ...others])].slice(0, MAX_LINKED_PDFS);
}

/**
 * 助成金の情報源テキストを取得する。
 * - PDF URL → PDF本文を抽出
 * - HTML → ページ本文＋リンクされた募集要項PDF（最大2件）を連結
 * 短すぎる・読めない場合は null。
 */
export async function fetchSourceText(url: string): Promise<string | null> {
  if (isPdfUrl(url)) {
    const text = await fetchPdfText(url);
    return text ? text.slice(0, PAGE_TEXT_LIMIT + PDF_TEXT_LIMIT) : null;
  }

  try {
    const response = await httpClient.get(url, { responseType: "text" });
    const $ = cheerio.load(response.data);
    const pdfLinks = findPdfLinks($, url);
    $("script, style, nav, footer, header, noscript, iframe").remove();
    const pageText = $("body")
      .text()
      .replace(/[\s\n\r\t]+/g, " ")
      .trim();

    const parts: string[] = [];
    if (pageText.length > 200) parts.push(pageText.slice(0, PAGE_TEXT_LIMIT));

    // 募集要項PDFの本文を追記（本文より詳しい情報が載っていることが多い）
    for (const pdfUrl of pdfLinks) {
      const pdfText = await fetchPdfText(pdfUrl);
      if (pdfText) {
        const fileName = decodeURIComponent(
          pdfUrl.split("/").pop() ?? "募集要項",
        );
        parts.push(
          `【添付PDF: ${fileName}】 ${pdfText.slice(0, PDF_TEXT_LIMIT)}`,
        );
      }
    }

    const combined = parts.join("\n").trim();
    return combined.length > 200 ? combined : null; // 短すぎるページは情報なしとみなす
  } catch {
    return null;
  }
}

/** エンリッチメント対象かどうか（読みに行く価値のあるURLか） */
function isEnrichable(grant: Grant): boolean {
  const url = grant.manualUrl || grant.url;
  if (!/^https?:\/\//.test(url)) return false;
  if (/news\.google\.com/.test(url)) return false; // 転送URLは読めない
  return (
    grant.status === "募集中" ||
    grant.status === "募集前" ||
    grant.status === "不明"
  );
}

/** 人間の判定履歴（AIの判断材料として渡す助成金名の一覧） */
export interface JudgmentExamples {
  relevant: string[];
  irrelevant: string[];
}

/** 判定履歴をプロンプトに追記する文面を組み立てる（最大30件ずつ・名前のみ） */
function buildJudgmentNote(examples?: JudgmentExamples): string {
  if (!examples) return "";
  const parts: string[] = [];
  if (examples.irrelevant.length > 0) {
    parts.push(
      `担当者が過去に「関係ない」と判定した助成金。助成の内容（分野・対象・支給内容）が
これらと同種のものは「対象外」に倒してよい。ただし、主催・仲介団体が同じというだけで
同種とみなさないこと（むすびえ・共同募金会などは性質の異なる多数の助成を扱っている。
判定はあくまで1件ごとの内容で行う）:\n` +
        examples.irrelevant
          .slice(0, 30)
          .map((n) => `  - ${n}`)
          .join("\n"),
    );
  }
  if (examples.relevant.length > 0) {
    parts.push(
      `担当者が過去に「関係あり」と判定した助成金（こういう系統を求めている）:\n` +
        examples.relevant
          .slice(0, 30)
          .map((n) => `  - ${n}`)
          .join("\n"),
    );
  }
  if (parts.length === 0) return "";
  return `\n\n【担当者の判定履歴】\n${parts.join("\n")}`;
}

/**
 * 全助成金の公式ページを読み、詳細情報を充填する。
 * 「対象外」と判断されたものはリストから除外して返す。
 * judgmentExamples を渡すと、人間の判定履歴をAIの判断材料に加える。
 */
export async function enrichGrants(
  grants: Grant[],
  judgmentExamples?: JudgmentExamples,
  protectedIds?: Set<string>,
): Promise<Grant[]> {
  const client = getClient();
  const enrichableCount = grants.filter(isEnrichable).length;
  if (enrichableCount > MAX_PAGES) {
    console.warn(
      `  ⚠ 読み取り対象 ${enrichableCount}件が上限 ${MAX_PAGES}件を超えています（超過分は読み取りをスキップして掲載）`,
    );
  }
  if (client) {
    console.log(
      `\n🤖 公式ページをAIで読み取り中（モデル: ${MODEL}、対象 ${Math.min(enrichableCount, MAX_PAGES)}件）...`,
    );
  } else {
    console.log(
      "\nℹ ANTHROPIC_API_KEY が未設定のため、ルールベースの簡易抽出で公式ページを読み取ります",
    );
    console.log(
      "  （.env に ANTHROPIC_API_KEY を設定するとAI読み取りが有効になります）",
    );
  }

  const judgmentNote = buildJudgmentNote(judgmentExamples);
  const result: Grant[] = [];
  let processed = 0;
  let excluded = 0;

  for (const grant of grants) {
    if (!isEnrichable(grant) || processed >= MAX_PAGES) {
      result.push(grant);
      continue;
    }
    processed++;

    // 人間が募集要項URLを登録していればそちらを優先して読む
    const sourceUrl = grant.manualUrl || grant.url;
    const pageText = await fetchSourceText(sourceUrl);
    if (!pageText) {
      result.push(grant); // ページが読めなければそのまま掲載
      continue;
    }

    try {
      if (client) {
        const extraction = await extractWithAI(
          client,
          grant,
          pageText,
          judgmentNote,
        );
        if (extraction.applicable === "対象外") {
          if (
            grant.manualUrl ||
            grant.humanJudgment === "関係あり" ||
            grant.source === "known" ||
            protectedIds?.has(grant.id)
          ) {
            // 人間が関係あると判断したもの・定番カタログ（人間が登録）は
            // AIの判断で消さず、要確認に落とす
            extraction.applicable = "要確認";
          } else if (
            /締切|締め切|〆切|募集.{0,4}終了/.test(extraction.reason)
          ) {
            // 「締切が過ぎている」は対象外の理由にしない決まり（毎年恒例の助成は
            // 翌年また応募できる）。AIがルールを破ったときの保険。
            extraction.applicable = "要確認";
          } else {
            excluded++;
            console.log(
              `  ✗ 対象外: ${grant.name.slice(0, 40)}（${extraction.reason.slice(0, 50)}）`,
            );
            continue; // 掲載しない
          }
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
  judgmentNote = "",
): Promise<ExtractionResult> {
  const response = await client.messages.create({
    model: MODEL,
    // モデルが思考にトークンを使う場合があるため、途中で切れない十分な上限にする
    max_tokens: 4096,
    system: SYSTEM_PROMPT + judgmentNote,
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
    throw new Error(
      `AI応答にテキストがありません（stop_reason: ${response.stop_reason}、ブロック: ${response.content.map((b) => b.type).join(",") || "なし"}）`,
    );
  }
  return JSON.parse(textBlock.text) as ExtractionResult;
}

/** AIが文字数上限を守らなかったときの保険（上限で切って「…」を付ける） */
function clamp(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * 抽出結果を Grant に反映する。
 * 通常（overwrite=false）は既に良い値がある項目を上書きしない。
 * 人間が募集要項URLを登録して読み直すとき（overwrite=true）は、
 * その要項を正とみなし、AIが読み取れた値で上書きする。
 * memo / manualUrl にはどちらのモードでも触らない。
 */
function applyExtraction(
  grant: Grant,
  ex: ExtractionResult,
  overwrite = false,
): Grant {
  const isEmpty = (v: string) =>
    !v || v === "要確認" || v === "不明" || v.startsWith("要確認");
  const pick = (current: string, extracted: string) =>
    (overwrite || isEmpty(current)) && !isEmpty(extracted)
      ? extracted
      : current;

  // 対象団体＋要約を「対象事業」欄に表示（応募可否の判断材料が一目で分かるように）
  const targetInfo = [
    ex.summary && ex.summary !== "不明" ? clamp(ex.summary, 30) : "",
    ex.targetOrganizations && ex.targetOrganizations !== "不明"
      ? `【対象】${clamp(ex.targetOrganizations, 40)}`
      : "",
    ex.applicable === "要確認" ? `【要確認】${clamp(ex.reason, 40)}` : "",
  ]
    .filter(Boolean)
    .join(" ");

  // 助成額: 既存の有効な値は上書きしない（「コースにより異なる」等の
  // 有用な注記を、AIの短い数値表記で潰さない）
  const grantAmount = pick(grant.grantAmount, clamp(ex.grantAmount, 30));

  return {
    ...grant,
    targetProjects: targetInfo || grant.targetProjects,
    grantAmount,
    grantPeriod: pick(grant.grantPeriod, ex.grantPeriod),
    applicationDeadline: pick(
      grant.applicationDeadline,
      ex.applicationDeadline,
    ),
    personnelCosts:
      (overwrite && ex.personnelCosts !== "不明") ||
      grant.personnelCosts === "不明"
        ? ex.personnelCosts
        : grant.personnelCosts,
    honorarium:
      (overwrite && ex.honorarium !== "不明") || grant.honorarium === "不明"
        ? ex.honorarium
        : grant.honorarium,
    rent:
      (overwrite && ex.rent !== "不明") || grant.rent === "不明"
        ? ex.rent
        : grant.rent,
    benefitType:
      (overwrite && ex.benefitType !== "不明") || grant.benefitType === "不明"
        ? ex.benefitType
        : grant.benefitType,
  };
}

/**
 * 1件だけAIで読み直す（募集要項URLの手動登録時に /api/manual-url から呼ばれる）。
 * 登録された要項を正とみなし、読み取れた値で既存値を上書きする。
 * AIキー未設定・ページが読めない場合は null を返す（呼び出し側でメッセージを分ける）。
 */
export async function enrichSingleGrant(grant: Grant): Promise<Grant | null> {
  const client = getClient();
  if (!client) return null;

  const sourceUrl = grant.manualUrl || grant.url;
  const pageText = await fetchSourceText(sourceUrl);
  if (!pageText) return null;

  const extraction = await extractWithAI(client, grant, pageText);
  if (extraction.applicable === "対象外") {
    // 人間が登録したものはAIの判断で消さない（要確認に落とすだけ）
    extraction.applicable = "要確認";
  }
  return {
    ...applyExtraction(grant, extraction, true),
    lastUpdated: new Date().toISOString(),
  };
}

/** 採択報告記事のタイトルから抽出した助成金情報 */
export interface AdoptionExtraction {
  /** 渡したタイトル配列の添字 */
  index: number;
  /** 助成金・基金の名称（抽出できなければ空文字） */
  grantName: string;
  /** 助成元の団体名（分からなければ空文字） */
  organization: string;
}

const ADOPTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["index", "grantName", "organization"],
        properties: {
          index: { type: "number", description: "タイトル一覧の番号" },
          grantName: {
            type: "string",
            description:
              "記事中の助成金・基金・助成プログラムの名称（例:「休眠預金活用助成」「子ども未来基金」）。タイトルに含まれていなければ空文字",
          },
          organization: {
            type: "string",
            description: "助成元の団体・財団名。分からなければ空文字",
          },
        },
      },
    },
  },
} as const;

/**
 * 他団体の採択報告記事のタイトル群から、助成金名と助成元をAIで抽出する。
 * （「NPO法人〇〇が△△助成に採択されました」→ 助成金名「△△助成」）
 * AIキー未設定時は正規表現による粗い抽出にフォールバックする。
 */
export async function extractGrantNamesFromTitles(
  titles: string[],
): Promise<AdoptionExtraction[]> {
  if (titles.length === 0) return [];

  const client = getClient();
  if (!client) {
    // フォールバック: 「〜助成」「〜基金」等で終わる語を切り出す（精度は低い）
    return titles
      .map((title, index) => {
        const m = title.match(
          /[「『]?([^\s「」『』、。]{2,30}?(?:助成金|助成|基金|ファンド|プログラム))[」』]?/,
        );
        return { index, grantName: m ? m[1] : "", organization: "" };
      })
      .filter((e) => e.grantName);
  }

  const numbered = titles.map((t, i) => `${i}: ${t}`).join("\n");
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 2048,
    system:
      "あなたは日本のNPOの助成金調査担当です。他団体の採択報告・活動報告の記事タイトル（「／」の後に本文抜粋が続く場合あり）から、助成金・基金の名称と助成元を抽出します。記事を書いた団体名（助成を受けた側）を助成金名や助成元と混同しないこと。",
    output_config: {
      format: { type: "json_schema", schema: ADOPTION_SCHEMA },
    },
    messages: [
      {
        role: "user",
        content: `以下は「助成に採択された」旨の記事タイトルの一覧です。それぞれから助成金・基金の名称と助成元を抽出してください。タイトルに助成金名が含まれない場合は grantName を空文字にしてください。\n\n${numbered}`,
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") return [];
  const parsed = JSON.parse(textBlock.text) as { items: AdoptionExtraction[] };
  return parsed.items.filter(
    (e) => e.grantName && e.index >= 0 && e.index < titles.length,
  );
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

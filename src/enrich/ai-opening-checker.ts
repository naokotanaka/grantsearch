import Anthropic from "@anthropic-ai/sdk";
import { Grant } from "../models/grant";
import { fetchSourceText } from "./ai-enricher";
import { searchWeb } from "../scrapers/web-search";
import { lastDeadlineDate } from "../scrapers/dedupe";

/**
 * 募集開始チェックのAI化
 *
 * 募集前（募集予定）のプログラムごとに、公式ページ（手動URL・前回のURL・その1段上の
 * ページ）を読み、Claude に「このプログラムの新しい回の募集が告知されているか」を
 * 判定させる。見つからなければ Web 検索で候補ページを探して同じ判定を行う。
 * AIが返した締切が「未来かつ1年以内」のときだけ「募集中」へ昇格させる。
 *
 * これまでの正規表現による検知（known-grants-checker）は、定番7件と👍13件しか
 * 対象にできず、行に保存された前年のURLしか読めなかった。
 * APIキー未設定時は呼ばれない（呼び出し側が従来の検知に戻す）。
 */

/** 判定に使うモデル（同一判定と同じ。判断の質を優先） */
const MODEL = process.env.CLAUDE_MATCH_MODEL ?? "claude-sonnet-5";

/** 1回の実行で読むページ数の上限（コスト・時間の暴走防止） */
export const MAX_FETCHES = 150;
/** 1回の実行で行う Web 検索の上限（DuckDuckGo への負荷・ブロック回避） */
export const MAX_SEARCHES = 40;
/** 例年の募集月が今からこの月数より先の行は、Web検索までは行わない（公式ページだけ読む） */
const SEARCH_WITHIN_MONTHS = 3;
/** 1プログラムあたり Web 検索結果から読むページ数 */
const RESULTS_PER_SEARCH = 3;

export interface OpeningVerdict {
  /** yes=新しい回の募集告知あり / no=無い（過去の回・別プログラムのみ） / unclear=判断不能 */
  announced: "yes" | "no" | "unclear";
  /** 今回の回の名前（例:「2027年度 八嶋佳子基金助成」） */
  roundName: string;
  /** 募集期間の原文（例:「2026年9月15日（火）～2026年10月30日（金）」） */
  period: string;
  /** 締切（必ず年付き。例:「2026年10月30日」） */
  deadline: string;
  reason: string;
}

/** ページ本文を読んで判定する関数（テストでは固定応答に差し替える） */
export type OpeningJudge = (
  grant: Grant,
  pageUrl: string,
  text: string,
) => Promise<OpeningVerdict>;

export interface OpeningCheckDeps {
  judge: OpeningJudge;
  fetchText?: (url: string) => Promise<string | null>;
  search?: (query: string) => Promise<{ url: string }[]>;
  now?: Date;
}

export interface OpeningCheckStats {
  checked: number;
  promoted: number;
  fetches: number;
  searches: number;
}

const SYSTEM_PROMPT = `
あなたはNPOの助成金担当者です。渡されたWebページ本文に、指定された助成金プログラムの
「新しい回の募集告知」があるかを判定してください。

判断の決まり:
- 「新しい回」とは、指定プログラムの、前回の募集期間より後に始まる募集のこと。
  前回の募集期間はあらかじめ知らせるので、それと同じ期間の案内は「新しい回」ではない。
- ページが過去の回の案内・採択結果・報告だけなら announced は "no"。
- 別のプログラム（同じ団体の別の助成、別のコース）の告知しか無ければ "no"。
- 募集予告（「〇月に募集開始予定」）だけで期間が確定していなければ "unclear"。
- 判定できたら、今回の回の名前・募集期間の原文・締切を書く。締切は必ず年を付けて
  「YYYY年M月D日」の形で書く。年がページに書かれていなければ文脈（掲載日・年度）から
  補い、補えなければ "unclear" にする。
- 推測で "yes" にしない。確信が持てなければ "unclear"。
`.trim();

const VERDICT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["announced", "roundName", "period", "deadline", "reason"],
  properties: {
    announced: { type: "string", enum: ["yes", "no", "unclear"] },
    roundName: {
      type: "string",
      description: "今回の回の名前（無ければ空文字）",
    },
    period: {
      type: "string",
      description: "募集期間の原文（無ければ空文字）",
    },
    deadline: {
      type: "string",
      description: "締切。必ず「YYYY年M月D日」の形（無ければ空文字）",
    },
    reason: { type: "string", description: "判断理由（40字以内）" },
  },
};

/** APIキーがあれば Claude による判定関数を返す。無ければ null */
export function createOpeningJudge(): OpeningJudge | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const client = new Anthropic();
  return async (grant, pageUrl, text) => {
    const response = await client.messages.create({
      model: MODEL,
      // モデルが思考にトークンを使う場合があるため、途中で切れない十分な上限にする
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      output_config: {
        format: { type: "json_schema", schema: VERDICT_SCHEMA },
      },
      messages: [
        {
          role: "user",
          content: [
            `助成金プログラム: ${grant.name}`,
            `助成元: ${grant.organization}`,
            `前回の募集期間: ${grant.expectedPeriod || grant.applicationDeadline || "不明"}`,
            grant.aliases.length > 0
              ? `別名: ${grant.aliases.map((a) => a.name).join(" / ")}`
              : "",
            `ページURL: ${pageUrl}`,
            "",
            "--- ページ本文 ---",
            text,
          ]
            .filter((line) => line !== "")
            .join("\n"),
        },
      ],
    });
    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      throw new Error(
        `AI応答にテキストがありません（stop_reason: ${response.stop_reason}）`,
      );
    }
    return JSON.parse(textBlock.text) as OpeningVerdict;
  };
}

/** URLの1段上のページ（例: /hp/miraiouen_r8/ → /hp/）。無ければ null */
export function parentUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const segments = u.pathname.split("/").filter(Boolean);
    if (segments.length < 2) return null;
    // 末尾がファイル名（.html/.pdf 等）なら、その1つ上のディレクトリではなく2つ上
    const last = segments[segments.length - 1];
    const drop = /\.[a-z0-9]{2,5}$/i.test(last) ? 2 : 1;
    if (segments.length - drop < 1) return null;
    u.pathname = "/" + segments.slice(0, segments.length - drop).join("/") + "/";
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

/** Web検索用の語（年度・回数・括弧書きを除いたプログラム名） */
export function searchTerm(name: string): string {
  return name
    .replace(/[（(【][^）)】]*[）)】]/g, " ")
    .replace(/20\d{2}\s*年度?|令和\d+\s*年度?|第\s*\d+\s*[回期次]/g, " ")
    .replace(/[「」『』｢｣]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 全角数字を半角にする（公式ページの「令和８年９月１４日」のような表記） */
function toHalfWidthDigits(text: string): string {
  return text.replace(/[０-９]/g, (c) =>
    String.fromCharCode(c.charCodeAt(0) - 0xfee0),
  );
}

/** AIの締切が「未来かつ1年以内」なら Date を返す。それ以外は null */
function validDeadline(deadline: string, now: Date): Date | null {
  const date = lastDeadlineDate(toHalfWidthDigits(deadline));
  if (!date) return null;
  const horizon = new Date(now);
  horizon.setMonth(horizon.getMonth() + 12);
  return date >= now && date <= horizon ? date : null;
}

/** AIの締切が「過去12ヶ月以内」（今年の回はもう終わった）なら true */
function recentlyClosed(deadline: string, now: Date): boolean {
  const date = lastDeadlineDate(toHalfWidthDigits(deadline));
  if (!date) return false;
  const floor = new Date(now);
  floor.setMonth(floor.getMonth() - 12);
  return date < now && date >= floor;
}

/**
 * 例年の募集月（expectedPeriod の「例年9月〜10月頃」の最初の月）が今から何ヶ月先か
 * （0〜11）。読めなければ null。今月または直近の行から順に確認するために使う。
 */
export function monthsUntilExpected(grant: Grant, now: Date): number | null {
  const m = grant.expectedPeriod.match(/例年\s*(\d{1,2})\s*月/);
  if (!m) return null;
  const month = parseInt(m[1]);
  if (month < 1 || month > 12) return null;
  return (month - 1 - now.getMonth() + 12) % 12;
}

/** expectedPeriod の「（前回: …）」を今年の回の期間で置き換える */
function withLatestRound(expectedPeriod: string, period: string): string {
  if (/[（(](?:前回|昨年実績)/.test(expectedPeriod)) {
    return expectedPeriod.replace(
      /[（(](?:前回|昨年実績)[^）)]*[）)]/,
      `（前回: ${period}）`,
    );
  }
  return expectedPeriod
    ? `${expectedPeriod}（前回: ${period}）`
    : `前回: ${period}`;
}

/** 同時に処理するプログラム数（ページ取得とAI判定の待ち時間を重ねる） */
const CONCURRENCY = 3;

/**
 * 募集前のプログラムの公式ページを読み、新しい回の募集を検知したら「募集中」へ
 * 昇格させて返す。読めない・判定できない・失敗したものは募集前のまま。
 * 結果の並び順は入力と同じ。
 */
export async function checkOpenings(
  grants: Grant[],
  deps: OpeningCheckDeps,
): Promise<{ grants: Grant[]; stats: OpeningCheckStats }> {
  const fetchText = deps.fetchText ?? fetchSourceText;
  const search =
    deps.search ?? ((q: string) => searchWeb(q, "募集開始チェック"));
  const now = deps.now ?? new Date();
  const stats: OpeningCheckStats = {
    checked: 0,
    promoted: 0,
    fetches: 0,
    searches: 0,
  };
  const result: Grant[] = new Array(grants.length);

  const processOne = async (grant: Grant): Promise<Grant> => {
    stats.checked++;
    const tried = new Set<string>();
    const candidates: string[] = [];
    const push = (u: string | null | undefined) => {
      if (!u || !/^https?:\/\//.test(u) || tried.has(u)) return;
      tried.add(u);
      candidates.push(u);
    };
    push(grant.manualUrl);
    push(grant.url);
    push(parentUrl(grant.manualUrl || grant.url));

    let promoted: Grant | null = null;
    let closedThisYear: Grant | null = null;
    const tryPage = async (pageUrl: string): Promise<boolean> => {
      if (stats.fetches >= MAX_FETCHES) return false;
      stats.fetches++;
      const text = await fetchText(pageUrl);
      if (!text) return false;
      let verdict: OpeningVerdict;
      try {
        verdict = await deps.judge(grant, pageUrl, text);
      } catch (error) {
        console.error(
          `  ⚠ 募集開始チェック失敗: ${grant.name.slice(0, 30)} - ${error instanceof Error ? error.message : error}`,
        );
        return false;
      }
      if (verdict.announced !== "yes") return false;
      const deadline = validDeadline(verdict.deadline, now);
      if (!deadline) {
        if (recentlyClosed(verdict.deadline, now)) {
          // 今年の回はもう終わっている → 「前回」の期間を今年のものに更新し、
          // これ以上（Web検索まで）探さない。期間の文字列に日付が無いとき
          // （AIが「募集は終了」のような文を返したとき）は締切だけを使う
          const hasDate = (s: string) => /\d{1,2}月\d{1,2}日/.test(s);
          const period = toHalfWidthDigits(
            hasDate(verdict.period) ? verdict.period : verdict.deadline,
          );
          closedThisYear = {
            ...grant,
            expectedPeriod: withLatestRound(grant.expectedPeriod, period),
          };
          console.log(
            `  ・${grant.name.slice(0, 30)}: 今年の回は終了（${period}）。前回の期間を更新`,
          );
          return true;
        }
        console.log(
          `  ・${grant.name.slice(0, 30)}: 告知ありと判定したが締切が不正（${verdict.deadline || "空"}）のため据え置き`,
        );
        return false;
      }
      promoted = {
        ...grant,
        status: "募集中",
        applicationDeadline: toHalfWidthDigits(
          verdict.period || verdict.deadline,
        ),
        url: pageUrl === grant.manualUrl ? grant.url : pageUrl,
        lastUpdated: new Date().toISOString(),
      };
      console.log(
        `  🟢 募集を検知: ${grant.name.slice(0, 30)} → ${verdict.roundName || "（回名なし）"}（${verdict.period || verdict.deadline}）`,
      );
      return true;
    };

    for (const pageUrl of candidates) {
      if (await tryPage(pageUrl)) break;
    }

    // 公式ページで見つからなければ Web 検索で候補ページを探す
    // （今年の回が終わったと分かった行と、例年の募集月がまだ先の行は探さない）
    const months = monthsUntilExpected(grant, now);
    const searchWorthwhile =
      months === null || months <= SEARCH_WITHIN_MONTHS || months >= 11;
    if (
      !promoted &&
      !closedThisYear &&
      searchWorthwhile &&
      stats.searches < MAX_SEARCHES
    ) {
      stats.searches++;
      try {
        const found = await search(`${searchTerm(grant.name)} 募集`);
        for (const r of found.slice(0, RESULTS_PER_SEARCH)) {
          if (tried.has(r.url)) continue;
          tried.add(r.url);
          if (await tryPage(r.url)) break;
        }
      } catch (error) {
        console.warn(
          `  ⚠ Web検索失敗: ${grant.name.slice(0, 30)} - ${error instanceof Error ? error.message : error}`,
        );
      }
    }

    if (promoted) stats.promoted++;
    return promoted ?? closedThisYear ?? grant;
  };

  // 例年の募集月が近い行から順に確認する（上限に達したとき、遠い行が後回しになる）。
  // 結果は入力と同じ並び順で返す
  const order = grants
    .map((g, index) => ({ index, months: monthsUntilExpected(g, now) ?? 6 }))
    .sort((a, b) => a.months - b.months)
    .map((o) => o.index);
  let next = 0;
  const worker = async () => {
    while (next < order.length) {
      const index = order[next++];
      result[index] = await processOne(grants[index]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, grants.length) }, worker),
  );

  return { grants: result, stats };
}

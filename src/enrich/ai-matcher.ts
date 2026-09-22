import Anthropic from "@anthropic-ai/sdk";
import { Grant } from "../models/grant";
import { MergeRecord } from "../models/database";
import {
  LEGAL_FORMS,
  adoptNewerRound,
  dedupeAcrossSources,
  isSameByRules,
  longestCommonSubstring,
  normalizeName,
  normalizeOrgName,
  representativeScore,
  roundDate,
} from "../scrapers/dedupe";

/**
 * AI照合：同じ助成金（プログラム）を指す複数の行を1行にまとめる
 *
 * 3層で判定する。
 * 1. 別名一致：候補の id、または名前＋助成元が、DBの既存行の別名一覧に一致すれば
 *    その行の回として扱う（AIは呼ばない）。
 * 2. 候補の絞り込み：文字列規則（名前の類似）と助成元の類似で、同一の可能性がある
 *    行をひとかたまりにする。
 * 3. AI判定：かたまりごとに Claude に「どれとどれが同じプログラムか」を判定させる。
 *    判定結果は別名一覧に残し、次回以降はAIを呼ばない。
 *
 * APIキー未設定・AI失敗時は、文字列規則だけでまとめる（従来どおり）。
 */

/** 同一判定に使うモデル（週に十数回の呼び出し。判断の質を優先して Sonnet） */
const MATCH_MODEL = process.env.CLAUDE_MATCH_MODEL ?? "claude-sonnet-5";

/** 1回の実行でAIに聞くかたまりの上限（コスト暴走の防止） */
const MAX_AI_GROUPS = 40;
/** 1つのかたまりの行数の上限（超えた分はAIに聞かず、まとめない） */
const MAX_GROUP_SIZE = 25;

/** AIが返す「同じプログラム」の組 */
export interface ProgramGroup {
  programName: string;
  memberIds: string[];
  reason: string;
}

/** かたまり（同じ助成元の候補一覧）を受け取り、同じプログラムの組を返す */
export type Judge = (rows: Grant[]) => Promise<ProgramGroup[]>;

export interface MatchResult {
  grants: Grant[];
  merges: MergeRecord[];
}

const SYSTEM_PROMPT = `
あなたはNPOの助成金情報を整理する担当者です。渡された助成金の一覧（助成元が同じか
似ているもの）を、「同じプログラム」ごとの組に分けてください。
同じプログラムとは、毎年・毎期くり返し募集される同じ助成制度のことです。

判断基準:
- 同じ助成元で、年度・回数・期（春募集/秋募集、前期/後期、第Ⅰ期/第Ⅱ期）・枠の表記
  （【一般枠】など）だけが違う名前は、同じプログラム。副題や表記が年度で少し変わる
  こともある（例:「2026年度 八嶋佳子基金「女性や子どもを支援する事業への助成」」と
  「2027年度 八嶋佳子基金助成」は同じプログラム）。
- 基金全体を指す行（例:「むすびえ・こども食堂基金（年2回募集）」）と、その基金の
  特定の回・コースの行（例:「むすびえ・こども食堂基金 2026年度 春募集 Aコース」）は
  同じプログラムにまとめる。
- 同じ助成元・同じ締切でも、別のコース名・プログラム名を持つ行どうしは別プログラム
  （例: プログラムA／B-1／B-4、通常助成／モデル事業／補正予算事業、
  「食事支援に取り組む団体への助成」と「財団助成金」のような別制度）。
- 助成元が別の団体なら別プログラム。ただし、共催・事務局・部署名の表記違い
  （例:「福祉医療機構」と「福祉医療機構 NPOリソースセンター」）は同じ団体とみなす。
- 別のサイトに載った同じ告知（名前がほぼ同じ）は同じプログラム。
- 迷ったら別プログラムにする。誤ってまとめると、担当者の判定やメモが別の助成金に
  付いてしまうため。

出力: 渡された全行を、漏れなく・重複なく、いずれかの組に入れる。1行だけの組も可。
各組には、年度や回数を除いた安定したプログラム名（30字以内）と、判断理由（40字以内）を付ける。
`.trim();

const GROUPING_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["groups"],
  properties: {
    groups: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["programName", "memberIds", "reason"],
        properties: {
          programName: {
            type: "string",
            description: "年度・回数を除いた安定したプログラム名（30字以内）",
          },
          memberIds: {
            type: "array",
            items: { type: "string" },
            description: "この組に入る行の id（入力の id をそのまま使う）",
          },
          reason: { type: "string", description: "判断理由（40字以内）" },
        },
      },
    },
  },
};

/** APIキーがあれば Claude による判定関数を返す。無ければ null */
export function createAiJudge(): Judge | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const client = new Anthropic();
  return async (rows: Grant[]): Promise<ProgramGroup[]> => {
    const input = rows.map((g) => ({
      id: g.id,
      name: g.name,
      organization: g.organization,
      status: g.status,
      period: g.status === "募集中" ? g.applicationDeadline : g.expectedPeriod,
      url: g.url,
      human: g.humanJudgment === "関係あり" ? "👍" : g.memo ? "メモあり" : "",
      aliases: g.aliases.map((a) => a.name),
    }));
    const response = await client.messages.create({
      model: MATCH_MODEL,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      output_config: {
        format: { type: "json_schema", schema: GROUPING_SCHEMA },
      },
      messages: [
        {
          role: "user",
          content: `以下の助成金の一覧を、同じプログラムごとの組に分けてください。\n\n${JSON.stringify(input, null, 1)}`,
        },
      ],
    });
    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      throw new Error(
        `AI応答にテキストがありません（stop_reason: ${response.stop_reason}）`,
      );
    }
    const parsed = JSON.parse(textBlock.text) as { groups: ProgramGroup[] };
    return parsed.groups;
  };
}

/**
 * 別名一覧の照合キー（名前＋助成元の正規化）。
 * 年度・回数に加えて、春/秋・前期/後期のような回の表記も除く
 * （同じ基金の春募集を別名に持っていれば、秋募集も同じプログラムとして扱う）
 */
function aliasKey(name: string, organization: string): string {
  const n = normalizeName(name).replace(
    /春|夏|秋|冬|前期|後期|上期|下期|第[ⅠⅡⅢⅣ1-4]期|通年/g,
    "",
  );
  return `${n}|${normalizeOrgName(organization)}`;
}

/** 団体名から一般語を除いた比較用の文字列 */
function orgCore(org: string): string {
  return normalizeOrgName(org)
    .replace(LEGAL_FORMS, "")
    .replace(
      /財団|基金|協会|委員会|事務局|センター|グループ|ホールディングス|株式会社|会社|法人|推進|運動|国民|\/|／/g,
      "",
    );
}

/** 助成元が同じ団体（または表記違い）とみなせるか */
export function isSimilarOrganization(a: string, b: string): boolean {
  const ca = orgCore(a);
  const cb = orgCore(b);
  if (!ca || !cb) return false;
  if (ca === cb) return true;
  const shorter = ca.length <= cb.length ? ca : cb;
  if (shorter.length >= 3 && (ca.includes(cb) || cb.includes(ca))) return true;
  return longestCommonSubstring(ca, cb) >= 4;
}

/**
 * 同一の可能性がある行をひとかたまりにする（union-find）。
 * 名前の規則で同一とみなせる組と、助成元が似ている組をつなぐ。
 */
export function clusterCandidates(grants: Grant[]): Grant[][] {
  const parent = grants.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  for (let i = 0; i < grants.length; i++) {
    for (let j = i + 1; j < grants.length; j++) {
      if (
        isSameByRules(grants[i], grants[j]) ||
        isSimilarOrganization(grants[i].organization, grants[j].organization)
      ) {
        union(i, j);
      }
    }
  }
  const groups = new Map<number, Grant[]>();
  grants.forEach((g, i) => {
    const root = find(i);
    const list = groups.get(root) ?? [];
    list.push(g);
    groups.set(root, list);
  });
  return Array.from(groups.values());
}

/**
 * 同じプログラムの組を1行にまとめる。代表は representativeScore が高い行。
 * 他の行は古い回から順に取り込む（最後に取り込んだ新しい回の情報が残る）。
 */
function mergeGroup(
  members: Grant[],
  storedIds: Set<string>,
  protectedIds: Set<string>,
  reason: string,
  merges: MergeRecord[],
): Grant {
  const sorted = members
    .slice()
    .sort(
      (a, b) =>
        representativeScore(b, storedIds) - representativeScore(a, storedIds),
    );
  const kept = sorted[0];
  const others = sorted
    .slice(1)
    .sort(
      (a, b) => (roundDate(a)?.getTime() ?? 0) - (roundDate(b)?.getTime() ?? 0),
    );
  const isProtected = (g: Grant) =>
    g.source === "known" || g.humanJudgment === "関係あり";
  for (const folded of others) {
    if (isProtected(folded)) protectedIds.add(kept.id);
    const keptName = kept.name.slice(0, 40);
    const adopted = adoptNewerRound(kept, folded);
    if (adopted) {
      console.log(
        `  ↻ 新しい回を取り込み: ${keptName} ← ${folded.name.slice(0, 40)}`,
      );
    }
    merges.push({
      keptId: kept.id,
      keptName: kept.name,
      foldedName: folded.name,
      foldedSource: folded.source,
      reason,
    });
  }
  if (isProtected(kept)) protectedIds.add(kept.id);
  return kept;
}

/**
 * 全候補をプログラム単位にまとめる。
 *
 * @param grants   今回の検索で集まった候補（DBの既存行も含む）
 * @param stored   検索開始前のDBの全行（id → 行）。別名一覧の参照元
 * @param protectedIds 定番・👍の保護を引き継ぐ代表 id の集合（呼び出し側が用意）
 * @param judge    AI判定関数。null なら文字列規則だけでまとめる
 */
export async function matchPrograms(
  grants: Grant[],
  stored: Map<string, Grant>,
  protectedIds: Set<string>,
  judge: Judge | null,
): Promise<MatchResult> {
  const merges: MergeRecord[] = [];
  const storedIds = new Set(stored.keys());
  const working = new Map<string, Grant>(grants.map((g) => [g.id, g]));

  // 1. 別名一致（AIを呼ばない）
  const aliasById = new Map<string, string>();
  const aliasByKey = new Map<string, string>();
  for (const s of stored.values()) {
    for (const a of s.aliases) {
      aliasById.set(a.id, s.id);
      aliasByKey.set(aliasKey(a.name, a.organization), s.id);
    }
  }
  for (const g of Array.from(working.values())) {
    if (storedIds.has(g.id)) continue; // DBにある行はそれ自体がプログラム
    const programId =
      aliasById.get(g.id) ?? aliasByKey.get(aliasKey(g.name, g.organization));
    if (!programId || programId === g.id) continue;
    let program = working.get(programId);
    if (!program) {
      // 代表行が今回の候補に無ければ、DBの行を引き継いで代表にする
      const s = stored.get(programId);
      if (!s) continue;
      program = { ...s, aliases: s.aliases.slice() };
      working.set(programId, program);
    }
    working.delete(g.id);
    mergeGroup([program, g], storedIds, protectedIds, "別名一致", merges);
  }

  // 2. AI判定が使えなければ、文字列規則だけでまとめる（従来どおり）
  if (!judge) {
    const result = dedupeAcrossSources(
      Array.from(working.values()),
      protectedIds,
      storedIds,
      (kept, folded) =>
        merges.push({
          keptId: kept.id,
          keptName: kept.name,
          foldedName: folded.name,
          foldedSource: folded.source,
          reason: "名前の規則",
        }),
    );
    return { grants: result, merges };
  }

  // 3. かたまりごとにAIへ聞く
  const clusters = clusterCandidates(Array.from(working.values()));
  const targets = clusters.filter((c) => c.length >= 2);
  console.log(
    `\n🧩 同一判定: ${targets.length}かたまりをAIで照合中（モデル: ${MATCH_MODEL}）...`,
  );
  const result: Grant[] = clusters.filter((c) => c.length === 1).map((c) => c[0]);
  let asked = 0;
  for (const cluster of targets) {
    if (asked >= MAX_AI_GROUPS || cluster.length > MAX_GROUP_SIZE) {
      console.warn(
        `  ⚠ 照合をスキップ（上限超過）: ${cluster[0].organization}（${cluster.length}行）`,
      );
      result.push(...cluster);
      continue;
    }
    asked++;
    let groups: ProgramGroup[];
    try {
      groups = await judge(cluster);
    } catch (error) {
      console.error(
        `  ⚠ 照合失敗（まとめずに掲載）: ${cluster[0].organization} - ${error instanceof Error ? error.message : error}`,
      );
      result.push(...cluster);
      continue;
    }
    const byId = new Map(cluster.map((g) => [g.id, g]));
    const assigned = new Set<string>();
    for (const group of groups) {
      const members = group.memberIds
        .filter((id) => byId.has(id) && !assigned.has(id))
        .map((id) => byId.get(id)!);
      members.forEach((m) => assigned.add(m.id));
      if (members.length === 0) continue;
      if (members.length === 1) {
        result.push(members[0]);
        continue;
      }
      console.log(
        `  🧩 同じプログラム「${group.programName}」: ${members.map((m) => m.name.slice(0, 30)).join(" / ")}（${group.reason}）`,
      );
      result.push(
        mergeGroup(
          members,
          storedIds,
          protectedIds,
          `AI: ${group.reason}`,
          merges,
        ),
      );
    }
    // AIが組に入れ忘れた行はそのまま残す
    for (const g of cluster) {
      if (!assigned.has(g.id)) result.push(g);
    }
  }
  return { grants: result, merges };
}

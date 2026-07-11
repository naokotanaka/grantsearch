/**
 * 助成金・補助金のデータモデル
 */

/** 対象地域 */
export type Region = "全国" | "愛知県" | "長久手市";

/** 経費の利用可否 */
export type Eligibility = "可" | "不可" | "要確認" | "不明";

/**
 * 助成金の募集状態
 * - 募集中: 締切が確認でき、まだ過ぎていない（今応募できる）
 * - 募集前: 昨年度までに募集実績があり、新年度分が未発表（例年時期を expectedPeriod に表示）
 * - 募集終了: 締切が過ぎた（レポートには表示しない）
 * - 不明: 状態を読み取れなかった（要確認として表示）
 */
export type GrantStatus = "募集中" | "募集前" | "募集終了" | "不明";

/** 助成金・補助金の情報 */
export interface Grant {
  /** 一意なID（ソース名_ハッシュ） */
  id: string;

  /** 助成金・補助金名 */
  name: string;

  /** 助成元の団体・機関名 */
  organization: string;

  /** 対象地域 */
  region: Region;

  /** 対象事業の説明 */
  targetProjects: string;

  /** 助成額（テキスト表記） */
  grantAmount: string;

  /** 助成期間 */
  grantPeriod: string;

  /** 申し込み締切 */
  applicationDeadline: string;

  /**
   * 例年の募集時期（募集前のときに表示する予告情報）
   * 例:「例年6〜7月頃（昨年実績: 2025/6/1〜7/9）」。情報がなければ空文字。
   */
  expectedPeriod: string;

  /** 人件費に使えるか */
  personnelCosts: Eligibility;

  /** 謝金に使えるか */
  honorarium: Eligibility;

  /** 家賃に使えるか */
  rent: Eligibility;

  /** 募集状態 */
  status: GrantStatus;

  /** 情報のURL */
  url: string;

  /** データソース名 */
  source: string;

  /** 最終更新日（ISO形式） */
  lastUpdated: string;
}

/** スクレイパーの設定 */
export interface ScraperConfig {
  /** スクレイパー名 */
  name: string;

  /** 対象URL */
  urls: string[];

  /** 対象地域 */
  region: Region;

  /** 有効/無効 */
  enabled: boolean;
}

/** 検索キーワード */
export const SEARCH_KEYWORDS = [
  "子育て支援",
  "子ども食堂",
  "子供食堂",
  "こども食堂",
  "児童",
  "子ども",
  "子育て",
  "外国人支援",
  "外国にルーツ",
  "多文化共生",
  "居場所づくり",
  "学習支援",
  "フードパントリー",
  "子どもの貧困",
];

/**
 * 除外キーワード：対象がこれらに限定される助成金は掲載しない
 * （当団体の活動分野外。被災地・災害支援は行わない方針）
 */
export const EXCLUDE_KEYWORDS = ["被災", "震災", "災害", "復興", "被災地"];

/** 検索対象の事業分野 */
export const TARGET_FIELDS = [
  "子育て支援",
  "子ども食堂・フードパントリー",
  "外国にルーツを持つ人の支援",
  "児童・少年の健全育成",
  "居場所づくり",
  "学習支援",
  "地域福祉",
];

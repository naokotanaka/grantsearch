import * as cheerio from "cheerio";
import { BaseScraper } from "./base-scraper";
import { Grant, Region } from "../models/grant";

/**
 * 愛知県社会福祉協議会ボランティアセンター「助成金等の情報」ページのスクレイパー
 * http://aichivc.jp/volunteer/ouenplaza/plaza_subsidy.html
 *
 * ページ構造（実HTMLを確認済み）:
 * - 各助成金は「<p>◆<strong>助成金名</strong>（助成元）New</p>」の見出し段落で始まり、
 *   説明段落と「■期間：…」「■詳細：<a href>URL</a>」の段落が続く。
 * - ◆と助成金名が別々の<strong>に分かれる場合や、見出しに「（終了）」が付く場合がある。
 * - 2023年度以降の古い助成金も削除されず残るアーカイブ型のページ。
 *
 * このアーカイブを「昨年度の募集実績」として活用する：
 * 同一プログラムの年度違いをグループ化し、最新ラウンドで判定する。
 * - 締切が未来 or New付き → 募集中（実期間を表示）
 * - 締切が過去でも15ヶ月以内 → 募集前（例年時期を expectedPeriod に生成）
 * - それより古い → 事業終了とみなし非掲載
 */
export class AichiVcScraper extends BaseScraper {
  private pageUrl = "http://aichivc.jp/volunteer/ouenplaza/plaza_subsidy.html";

  /** 募集前として掲載する実績の新しさ（ヶ月） */
  private static readonly RECENT_MONTHS = 15;

  constructor() {
    super("aichi_vc", "愛知県");
  }

  async search(): Promise<Grant[]> {
    try {
      const $ = await this.fetchPage(this.pageUrl);
      const grants = this.parseDocument($);

      if (grants.length === 0) {
        console.error(
          "[愛知VC] 助成金を抽出できませんでした（ページ構成が変わった可能性があります）",
        );
      }
      return grants;
    } catch (error) {
      console.error(
        "[愛知VC] ページ取得に失敗:",
        error instanceof Error ? error.message : error,
      );
      return [];
    }
  }

  /** ページ全体を解析し、募集中＋募集前（昨年度実績あり）の助成金を返す */
  private parseDocument($: cheerio.CheerioAPI): Grant[] {
    interface Block {
      name: string;
      organization: string;
      isNew: boolean;
      closed: boolean;
      body: string;
      url: string;
      order: number;
    }

    // 全<p>を順に走査し、「◆＋太字」の見出しごとにブロック化する
    const blocks: Block[] = [];
    let current: Block | null = null;

    $("p").each((index, elem) => {
      const $p = $(elem);
      const text = this.cleanText($p.text());
      const strongs = $p.find("strong");

      if (text.startsWith("◆") && strongs.length > 0) {
        if (current) blocks.push(current);

        // 見出し行の全テキストから解析する。
        // （名前の一部が<strong>の外にはみ出す・◆が別タグ等、タグ構造の揺れが多いため
        //  タグに頼らず「末尾の（助成元）」を切り出す方式が最も頑健）
        const isNew = /New/i.test(text);
        const closed = /[（(]\s*終了\s*[）)]/.test(text);
        let headerText = this.cleanText(
          text
            .replace(/[◆◇♦]/g, "")
            .replace(/[（(]\s*終了\s*[）)]/g, "")
            .replace(/New/gi, ""),
        );

        // 末尾の（…）を助成元とみなす（名前の途中の（…）はコース名等なので残す）
        let name = headerText;
        let organization = "要確認";
        const orgMatch = headerText.match(/^(.*)[（(]([^（()）]*)[）)]\s*$/);
        if (orgMatch && this.cleanText(orgMatch[2])) {
          name = this.cleanText(orgMatch[1])
            .replace(/[（(]\s*$/, "")
            .trim();
          organization = this.cleanText(orgMatch[2]);
        }

        current = {
          name,
          organization,
          isNew,
          closed,
          body: "",
          url: "",
          order: index,
        };
      } else if (current) {
        current.body += " " + text;
        if (!current.url) {
          const a = $p.find('a[href^="http"]').first();
          if (a.length) current.url = a.attr("href") ?? "";
        }
      }
    });
    if (current) blocks.push(current);

    // 同一プログラムの年度違いをグループ化（年度・回数表記を除いた基底名＋助成元）
    interface Round {
      block: Block;
      deadline: string;
      deadlineDate: Date | null;
    }
    const programs = new Map<string, Round[]>();

    for (const block of blocks) {
      if (block.name.length < 6) continue;

      const deadlineMatch = block.body.match(/期間[：:]\s*([^■]+)/);
      const deadline = deadlineMatch ? this.cleanText(deadlineMatch[1]) : "";
      const key = `${this.normalizeProgramName(block.name)}|${block.organization}`;

      const rounds = programs.get(key) ?? [];
      rounds.push({ block, deadline, deadlineDate: this.lastDateIn(deadline) });
      programs.set(key, rounds);
    }

    const now = new Date();
    const recentCutoff = new Date(now);
    recentCutoff.setMonth(
      recentCutoff.getMonth() - AichiVcScraper.RECENT_MONTHS,
    );

    const grants: Grant[] = [];

    for (const rounds of programs.values()) {
      try {
        // 最新ラウンド＝締切日が最も新しいもの（日付不明はページ順で先のもの）
        const latest = rounds.reduce((a, b) => {
          if (a.deadlineDate && b.deadlineDate)
            return a.deadlineDate >= b.deadlineDate ? a : b;
          if (a.deadlineDate) return a;
          if (b.deadlineDate) return b;
          return a.block.order <= b.block.order ? a : b;
        });

        const { block, deadline, deadlineDate } = latest;
        const isOpen =
          !block.closed && deadlineDate !== null && deadlineDate >= now;
        const isNewUnclosed = !block.closed && block.isNew;

        // 名称・助成元に愛知/名古屋を含むものだけ愛知県、他は全国募集とみなす
        const region: Region = /愛知|名古屋/.test(
          block.name + block.organization,
        )
          ? "愛知県"
          : "全国";
        const amountMatch = block.body.match(
          /補助額[】\]]?\s*([^）)■【]+[）)]?)/,
        );
        const grantAmount = amountMatch
          ? this.cleanText(amountMatch[1])
          : "要確認";

        if (isOpen || isNewUnclosed) {
          // 今募集中
          grants.push(
            this.createGrant({
              name: block.name,
              organization: block.organization,
              region,
              applicationDeadline: deadline || "要確認",
              grantAmount,
              url: block.url || this.pageUrl,
              status: "募集中",
            }),
          );
        } else if (deadlineDate !== null && deadlineDate >= recentCutoff) {
          // 直近15ヶ月以内に募集実績あり → 募集予定として予告掲載
          grants.push(
            this.createGrant({
              name: block.name,
              organization: block.organization,
              region,
              applicationDeadline: "未発表",
              expectedPeriod: this.buildExpectedPeriod(deadline),
              grantAmount,
              url: block.url || this.pageUrl,
              status: "募集前",
            }),
          );
        }
        // それより古い実績しかないプログラムは非掲載（事業終了とみなす）
      } catch {
        // 個別プログラムの解析エラーはスキップ
      }
    }

    return grants;
  }

  /** 年度・回数などの表記を除いた基底名（同一プログラムの年度違いをまとめるため） */
  private normalizeProgramName(name: string): string {
    return name
      .replace(/【[^】]*】/g, "")
      .replace(/[（(][^）)]*[）)]/g, "")
      .replace(/(20|２０)[0-9０-９]{2}\s*年度?/g, "")
      .replace(/令和\s*[0-9０-９]+\s*年度?/g, "")
      .replace(/第\s*[0-9０-９]+\s*[回期次]/g, "")
      .replace(/(春|夏|秋|冬)期?募集/g, "")
      .replace(/[\s　・]/g, "");
  }

  /** 昨年実績の期間文字列から「例年◯月頃（昨年実績: …）」を組み立てる */
  private buildExpectedPeriod(lastPeriod: string): string {
    if (!lastPeriod) return "時期不明（昨年度に募集実績あり）";

    const dates = [
      ...lastPeriod.matchAll(/(?:令和\d+年|\d{4}年)(\d{1,2})月\d{1,2}日/g),
    ];
    if (dates.length === 0) return `時期不明（昨年実績: ${lastPeriod}）`;

    const startMonth = parseInt(dates[0][1], 10);
    const endMonth = parseInt(dates[dates.length - 1][1], 10);
    const monthLabel =
      startMonth === endMonth
        ? `例年${startMonth}月頃`
        : `例年${startMonth}月〜${endMonth}月頃`;
    return `${monthLabel}（昨年実績: ${lastPeriod}）`;
  }

  /** 期間文字列の最後に現れる日付（＝締切側）を返す */
  private lastDateIn(text: string): Date | null {
    const matches = [
      ...text.matchAll(/(?:令和\d+年|\d{4}年)\d{1,2}月\d{1,2}日/g),
    ];
    if (matches.length === 0) return null;
    return this.parseJapaneseDate(matches[matches.length - 1][0]);
  }
}

/**
 * 議事録・貼った文・通話のまとめから、予定と締切（やること）の候補を拾う。**純粋関数。規則だけで決める。**
 * 本人の設計 2026-11-05「Genie Schedule Intelligence」: 抽出は自動、登録は承認制。抽出元の文を必ず残す。
 *
 *   「来週水曜14時から定例会議」          → 予定の候補「定例会議」（11/11(水) 14:00〜）
 *   「金曜までに見積書提出（田中）」       → やることの候補「見積書提出」（11/13(金)まで）
 *
 * 読まないもの: 問い、日の言葉が無い時刻（「14時に」だけ）、過ぎた日時、例示（「例えば」「例:」）、
 * 繰り返し。1 つの文に予定と締切の両方があれば予定として読む（時刻があるほうが具体的）。
 */
import { findEventTime, normalizeNumbers, type ParseContext } from './parse.js';
import { findDeadline, type DueDate } from './todo-parse.js';

export type Candidate =
  | {
      readonly kind: 'event';
      readonly title: string;
      readonly start: number;
      readonly end: number | null;
      /** 抽出元の文（そのまま。なぜ提案したかを本人が確かめられるように） */
      readonly excerpt: string;
    }
  | {
      readonly kind: 'todo';
      readonly title: string;
      readonly due: DueDate;
      readonly excerpt: string;
    };

/** 一度に出す候補の数（多すぎると確かめられない） */
export const MAX_CANDIDATES = 8;

const EXAMPLE = /(?:例えば|たとえば|例[:：]|例）|e\.g\.)/i;
const BULLET = /^(?:[・\-*●○◯■□▶︎>]\s*|\d+[.)．]\s*)+/u;

export function extractCandidates(text: string, context: ParseContext): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (const sentence of sentences(text)) {
    if (out.length >= MAX_CANDIDATES) break;
    if (/[?？]\s*$/.test(sentence) || EXAMPLE.test(sentence)) continue;
    const clean = sentence.replace(BULLET, '').trim();
    const event = findEventTime(normalizeDates(clean), context);
    if (event) {
      const title = eventTitle(normalizeDates(clean), event.index, event.length);
      const key = `e:${title}:${String(event.start)}`;
      if (title && !seen.has(key)) {
        seen.add(key);
        out.push({ kind: 'event', title, start: event.start, end: event.end, excerpt: sentence });
      }
      continue;
    }
    const deadline = findDeadline(normalizeDates(clean, true), context);
    if (deadline) {
      const title = deadline.title.replace(/[（(][^）)]{1,20}[）)]\s*$/u, '').trim();
      const key = `t:${title}`;
      if (title.length >= 2 && !seen.has(key)) {
        seen.add(key);
        out.push({ kind: 'todo', title, due: deadline.due, excerpt: sentence });
      }
    }
  }
  return out;
}

/** 行と句点で切る。長すぎる行は読まない（文の境が分からない）。 */
function sentences(text: string): string[] {
  return text
    .split(/[\n\r]+|(?<=[。！!])/u)
    .map((s) => s.trim())
    .filter((s) => s.length >= 4 && s.length <= 160);
}

/**
 * 「11/11(水)」「11/11（水）」を日付の言葉にする（予定の読み取りは「11月11日」を読む）。
 * 締切のほうは「11/13」をそのまま読めるので、曜日の括弧だけを外す。
 */
function normalizeDates(s: string, keepSlash = false): string {
  const t = normalizeNumbers(s).replace(/[（(][日月火水木金土](?:曜日?)?[）)]/gu, '');
  return keepSlash ? t : t.replace(/(?<!\d)(\d{1,2})\s*\/\s*(\d{1,2})(?!\d)/g, '$1月$2日');
}

/** 時刻の言い方を外した残りを、予定の名前にする（「定例会議を行う」→「定例会議」）。 */
function eventTitle(s: string, index: number, length: number): string {
  return `${s.slice(0, index)} ${s.slice(index + length)}`
    .replace(/[:：]/g, ' ')
    .replace(
      /(?:を|で|に|の)?\s*(?:行う|行います|おこなう|実施(?:する|します|予定)?|開催(?:する|します|予定)?|予定(?:です)?|設定(?:する|します|済み)?|決定|確定|とする|とします|で調整|でお願いします)\s*$/u,
      '',
    )
    .replace(/[、,。．.！!\s]+/g, ' ')
    .replace(/^(?:\s|の|を|に|は|で|、)+|(?:\s|の|を|に|は|で|と|、)+$/gu, '')
    .replace(/(?<=[^\x20-\x7e]) | (?=[^\x20-\x7e])/gu, '')
    .trim()
    .slice(0, 80);
}

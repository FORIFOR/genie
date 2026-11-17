/**
 * 電話の結果の報告（service-phone の executor が書く Markdown）の形。
 * 書く側と、チャットで結果のカードにする側（service-channels）が同じ定義を使う。
 *
 * 結果は Oathra の outcome（見出し）だけで決める。会話の記録から「予約できた」などを推し量らない。
 * 留守番電話・折り返しは Oathra が区別しないので、ここにも無い（「要確認」に入る）。
 */
export type CallReportOutcome = 'succeeded' | 'declined' | 'needs_review';

export const CALL_REPORT = {
  declinedHeading: '相手が断りました',
  reviewHeading: '結果を確かめてください',
  transcriptHeading: '会話の記録',
  targetLabel: '相手',
  productLabel: '商品',
  recordLabel: 'Oathra の記録',
} as const;

export const CALL_OUTCOME_TEXT: Readonly<Record<CallReportOutcome, string>> = {
  succeeded: '会話で確認済み',
  declined: '相手が辞退',
  needs_review: '要確認',
};

export interface CallReport {
  readonly outcome: CallReportOutcome;
  /** 見出し（「用件をお伝えしました。」「相手が断りました」…）。 */
  readonly headline: string;
  /** 見出しの下の説明（何を確かめたか・確かめていないか）。 */
  readonly note: string;
  readonly target: string | null;
  readonly product: string | null;
  /** 会話の記録の発言の数（中身はカードに出さない）。 */
  readonly turns: number;
}

/**
 * 報告を読む。報告の形でなければ null（Oathra の記録の行が無いものは電話の報告とみなさない）。
 * 会話の記録より後ろ（相手の発言）は、数えるだけで形の判断に使わない。
 */
export function parseCallReport(markdown: string): CallReport | null {
  const lines = markdown.split('\n');
  const first = lines[0] ?? '';
  if (!first.startsWith('# ')) return null;
  const headline = first.slice(2).trim();
  const split = lines.indexOf(`## ${CALL_REPORT.transcriptHeading}`);
  const head = split >= 0 ? lines.slice(1, split) : lines.slice(1);
  const tail = split >= 0 ? lines.slice(split + 1) : [];
  const field = (label: string) => {
    const line = head.find((l) => l.startsWith(`- ${label}: `));
    return line ? line.slice(label.length + 4).trim() || null : null;
  };
  if (!head.some((l) => l.startsWith(`- ${CALL_REPORT.recordLabel}: `))) return null;
  const note = head.find((l) => l.trim() && !l.startsWith('- '))?.trim() ?? '';
  return {
    outcome:
      headline === CALL_REPORT.declinedHeading
        ? 'declined'
        : headline === CALL_REPORT.reviewHeading
          ? 'needs_review'
          : 'succeeded',
    headline,
    note,
    target: field(CALL_REPORT.targetLabel),
    product: field(CALL_REPORT.productLabel),
    turns: tail.filter((l) => /^- (?:AI|相手): /.test(l)).length,
  };
}

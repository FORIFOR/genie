/** Provider-neutral execution contract. Inputs and model proposals are untrusted. */
export type ExecutionRoute = 'api' | 'mcp' | 'accessibility' | 'vision';
export type VerificationLevel = 'readback' | 'field' | 'visual';
export type ExecutionOperation = 'mail.draft' | 'calendar.create' | 'text.insert' | 'computer.run';
export interface ExecutionIntent {
  operation: ExecutionOperation;
  parameters: Record<string, unknown>;
}
export interface ExecutionCapability {
  id: string;
  route: ExecutionRoute;
  label: string;
  fingerprint: string;
  operations: readonly ExecutionOperation[];
  verification: VerificationLevel;
}
export interface PreparedExecution {
  version: 1;
  status: 'ready' | 'needs_input' | 'unavailable';
  id: string;
  goal: string;
  deviceId?: string;
  intent: ExecutionIntent | null;
  capability: ExecutionCapability | null;
  message: string;
  expiresAt: number;
  details: { label: string; value: string }[];
}
export interface ExecutionReceipt {
  version: 1;
  status: 'verified' | 'needs_input' | 'unavailable' | 'unverified';
  route: ExecutionRoute | null;
  level: VerificationLevel | null;
  summary: string;
  checkedAt: string | null;
  evidence: string | null;
}
export const RECEIPT_PREFIX = '<!--genie-execution:';
export const ROUTES: readonly ExecutionRoute[] = ['api', 'mcp', 'accessibility', 'vision'];
export function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function text(value: unknown, max: number): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= max &&
    !value.includes('\0')
  );
}
/** Known operations only. Missing data is not completed with imagined people or addresses. */
export function intentOf(value: unknown, goal: string): ExecutionIntent | null {
  const row = object(value),
    p = object(row?.['parameters']);
  if (!row || !p || /Outlook|Microsoft|Appleカレンダー|iCloud/i.test(goal)) return null;
  const only = (keys: string[]) => Object.keys(p).every((k) => keys.includes(k));
  switch (row['operation']) {
    case 'mail.draft': {
      if (
        !only(['to', 'subject', 'body']) ||
        /添付|attachment|\bcc\b|\bbcc\b/i.test(goal) ||
        !/下書き|draft/i.test(goal) ||
        !Array.isArray(p['to']) ||
        !p['to'].length ||
        p['to'].length > 10 ||
        !p['to'].every(
          (e) =>
            typeof e === 'string' && /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(e) && goal.includes(e),
        ) ||
        !text(p['subject'], 200) ||
        /[\r\n]/.test(p['subject']) ||
        !text(p['body'], 8000)
      )
        return null;
      return {
        operation: 'mail.draft',
        parameters: { to: p['to'], subject: p['subject'], body: p['body'] },
      };
    }
    case 'calendar.create': {
      const iso = (v: unknown): v is string =>
        typeof v === 'string' &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})$/.test(v) &&
        Number.isFinite(Date.parse(v));
      if (
        !only(['title', 'start', 'end']) ||
        /繰り返|毎週|毎日|毎月|終日|recurr|repeat|all.day/i.test(goal) ||
        !/予定|カレンダー|calendar|event/i.test(goal) ||
        !text(p['title'], 200) ||
        !iso(p['start']) ||
        !iso(p['end']) ||
        Date.parse(p['end']) <= Date.parse(p['start']) ||
        Date.parse(p['end']) - Date.parse(p['start']) > 7 * 86400000 ||
        /招待|invite|attendee/i.test(goal)
      )
        return null;
      return {
        operation: 'calendar.create',
        parameters: { title: p['title'], start: p['start'], end: p['end'] },
      };
    }
    case 'text.insert': {
      // The initial field route inserts an explicitly supplied string, not a model rewrite.
      if (
        !only(['text']) ||
        !/入力欄|テキスト欄|text field/i.test(goal) ||
        !text(p['text'], 2000) ||
        /[\r\n\t]/.test(p['text']) ||
        !goal.includes(p['text'])
      )
        return null;
      return { operation: 'text.insert', parameters: { text: p['text'] } };
    }
    case 'computer.run': {
      if (
        !/画面|アプリ|ウィンドウ|screen|window|app\b/i.test(goal) ||
        /送信|決済|支払|削除|購入|発注|公開|予約|経費|請求書|ログイン|password|delete|payment|publish|book\b|send\b/i.test(
          goal,
        )
      )
        return null;
      return { operation: 'computer.run', parameters: { goal, successCriteria: goal } };
    }
    default:
      return null;
  }
}
export function requiredLevel(operation: ExecutionOperation): VerificationLevel {
  return operation === 'text.insert'
    ? 'field'
    : operation === 'computer.run'
      ? 'visual'
      : 'readback';
}
/** Rank only candidates which implement the exact operation AND its completion evidence. */
export function selectExecutionRoute(
  intent: ExecutionIntent,
  candidates: readonly ExecutionCapability[],
): ExecutionCapability | null {
  return (
    [...candidates]
      .filter(
        (c) =>
          c.id &&
          c.fingerprint &&
          ROUTES.includes(c.route) &&
          c.operations.includes(intent.operation) &&
          c.verification === requiredLevel(intent.operation),
      )
      .sort(
        (a, b) => ROUTES.indexOf(a.route) - ROUTES.indexOf(b.route) || a.id.localeCompare(b.id),
      )[0] ?? null
  );
}
export function previewDetails(
  intent: ExecutionIntent,
  capability: ExecutionCapability,
): PreparedExecution['details'] {
  const p = intent.parameters;
  const items = [{ label: '実行先', value: capability.label }];
  if (intent.operation === 'mail.draft')
    items.push(
      { label: '宛先', value: (p['to'] as string[]).join(', ') },
      { label: '件名', value: String(p['subject']) },
      { label: '下書き本文（未送信）', value: String(p['body']) },
    );
  if (intent.operation === 'calendar.create')
    items.push(
      { label: '予定名', value: String(p['title']) },
      { label: '開始', value: String(p['start']) },
      { label: '終了', value: String(p['end']) },
      { label: '招待', value: '送信しません' },
    );
  if (intent.operation === 'text.insert')
    items.push({ label: '入力する文字', value: String(p['text']) });
  if (intent.operation === 'computer.run')
    items.push({ label: '確認する状態', value: String(p['successCriteria']) });
  items.push({
    label: '結果確認',
    value:
      capability.verification === 'readback'
        ? '保存先から内容を読み戻して照合'
        : capability.verification === 'field'
          ? '入力欄の値を読み戻して照合（保存・送信は未確認）'
          : '新しい画像で表示を確認（保存・送信は未確認）',
  });
  return items;
}
const stringList = (v: unknown): string[] | null =>
  Array.isArray(v) && v.every((s) => typeof s === 'string') ? v : null;
const lines = (v: unknown): string | null =>
  typeof v === 'string' ? v.replace(/\r\n/g, '\n') : null;
/** Checks independent provider readback, NEVER the write response or an LLM's success flag. */
export function matchesReadback(intent: ExecutionIntent, writtenID: string, raw: unknown): boolean {
  const value = object(raw),
    p = intent.parameters;
  if (!value || !writtenID || value['id'] !== writtenID) return false;
  if (intent.operation === 'mail.draft') {
    const to = stringList(value['to']),
      expected = stringList(p['to']);
    return (
      !!to &&
      !!expected &&
      JSON.stringify(to.map((x) => x.toLowerCase()).sort()) ===
        JSON.stringify(expected.map((x) => x.toLowerCase()).sort()) &&
      value['subject'] === p['subject'] &&
      lines(value['body']) === lines(p['body']) &&
      value['draft'] === true
    );
  }
  if (intent.operation === 'calendar.create')
    return (
      value['title'] === p['title'] &&
      typeof value['start'] === 'string' &&
      typeof value['end'] === 'string' &&
      Date.parse(value['start']) === Date.parse(String(p['start'])) &&
      Date.parse(value['end']) === Date.parse(String(p['end'])) &&
      value['cancelled'] === false &&
      Array.isArray(value['attendees']) &&
      value['attendees'].length === 0
    );
  return false;
}
export function receiptArtifact(receipt: ExecutionReceipt): {
  artifact: { title: string; markdown: string };
  receipt: ExecutionReceipt;
} {
  const safe = { ...receipt, summary: receipt.summary.replace(/[\r\n]/g, ' ').slice(0, 500) };
  const marker = JSON.stringify(safe).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
  return {
    receipt: safe,
    artifact: {
      title: safe.summary,
      markdown: `${RECEIPT_PREFIX}${marker}-->\n\n${safe.summary}\n\n${safe.level === 'visual' ? '画面表示のみ確認しました。保存・外部送信は確認していません。' : safe.level === 'field' ? '入力欄の内容を確認しました。アプリ側の保存・送信は別途確認が必要です。' : safe.status === 'verified' ? '実行先から対象を読み戻し、承認した内容と照合しました。' : '完了確認は取れていません。書き込みを自動では繰り返しません。'}\n`,
    },
  };
}

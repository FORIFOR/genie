/** Pure, fail-closed checks shared by the vision loop and regression tests. */
export class VisionFailure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export interface VisionFrame {
  id: string;
  bundleId: string;
  windowId: number;
  pid: number;
  capturedAt: number;
  width: number;
  height: number;
  bounds: { x: number; y: number; width: number; height: number };
  sha256: string;
}

export interface GroundedAction {
  action: 'click' | 'type' | 'key';
  frameId: string;
  target: [number, number, number, number];
  expectation: string;
  confidence: number;
  risk: 'navigation' | 'draft';
  text?: string;
  key?: 'TAB' | 'ESC' | 'LEFT' | 'RIGHT' | 'UP' | 'DOWN';
}

export type VisionDecision =
  | GroundedAction
  | {
      action: 'done';
      frameId: string;
      reason: string;
    }
  | {
      action: 'stop';
      frameId: string;
      reason: string;
    };

const KEYS = ['TAB', 'ESC', 'LEFT', 'RIGHT', 'UP', 'DOWN'];
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new VisionFailure('invalid_response');
  return value as Record<string, unknown>;
}
function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
export function frameOf(raw: unknown, now: number): VisionFrame {
  const f = record(raw);
  const b = record(f['bounds']);
  if (
    typeof f['id'] !== 'string' ||
    !/^cv-[a-f0-9-]{36}$/.test(f['id']) ||
    typeof f['bundleId'] !== 'string' ||
    !f['bundleId'] ||
    !Number.isSafeInteger(f['windowId']) ||
    Number(f['windowId']) < 1 ||
    !Number.isSafeInteger(f['pid']) ||
    Number(f['pid']) < 1 ||
    !finite(f['capturedAt']) ||
    f['capturedAt'] > now + 1000 ||
    now - f['capturedAt'] > 60_000 ||
    !Number.isSafeInteger(f['width']) ||
    Number(f['width']) < 1 ||
    Number(f['width']) > 1600 ||
    !Number.isSafeInteger(f['height']) ||
    Number(f['height']) < 1 ||
    Number(f['height']) > 1600 ||
    typeof f['sha256'] !== 'string' ||
    !/^[a-f0-9]{64}$/.test(f['sha256']) ||
    !['x', 'y', 'width', 'height'].every((k) => finite(b[k])) ||
    Number(b['width']) <= 0 ||
    Number(b['height']) <= 0 ||
    Math.abs(Number(b['x'])) > 50_000 ||
    Math.abs(Number(b['y'])) > 50_000 ||
    Number(b['width']) > 20_000 ||
    Number(b['height']) > 20_000
  )
    throw new VisionFailure('invalid_frame');
  return raw as VisionFrame;
}

export function assertScope(frame: VisionFrame, initial: VisionFrame): void {
  if (
    frame.bundleId !== initial.bundleId ||
    frame.windowId !== initial.windowId ||
    frame.pid !== initial.pid
  )
    throw new VisionFailure('target_changed');
}

export function requireApproval(value: unknown, operation: string, now: number): void {
  let a: Record<string, unknown>;
  try {
    a = record(value);
  } catch {
    throw new VisionFailure('approval_required');
  }
  const decided = typeof a['decidedAt'] === 'string' ? Date.parse(a['decidedAt']) : NaN;
  const expires = typeof a['expiresAt'] === 'string' ? Date.parse(a['expiresAt']) : NaN;
  if (
    a['operationId'] !== operation ||
    a['decision'] !== 'APPROVED' ||
    typeof a['approvalId'] !== 'string' ||
    !a['approvalId'] ||
    typeof a['decidedBy'] !== 'string' ||
    !a['decidedBy'] ||
    !Number.isFinite(decided) ||
    !Number.isFinite(expires) ||
    decided > now ||
    expires <= now ||
    expires <= decided
  )
    throw new VisionFailure('approval_required');
}

export function decisionOf(raw: unknown, frame: VisionFrame): VisionDecision {
  const d = record(raw);
  if (d['frameId'] !== frame.id) throw new VisionFailure('stale_plan');
  if (d['action'] === 'done' || d['action'] === 'stop') {
    if (typeof d['reason'] !== 'string' || !d['reason'].trim() || d['reason'].length > 500)
      throw new VisionFailure('invalid_plan');
    return { action: d['action'], frameId: frame.id, reason: d['reason'] };
  }
  if (
    !['click', 'type', 'key'].includes(String(d['action'])) ||
    !finite(d['confidence']) ||
    d['confidence'] < 0.9 ||
    d['confidence'] > 1 ||
    !['navigation', 'draft'].includes(String(d['risk'])) ||
    typeof d['expectation'] !== 'string' ||
    !d['expectation'].trim() ||
    d['expectation'].length > 500
  )
    throw new VisionFailure('ungrounded_action');
  const box = d['target'];
  if (!Array.isArray(box) || box.length !== 4 || !box.every(finite))
    throw new VisionFailure('invalid_target');
  const [x1, y1, x2, y2] = box as [number, number, number, number];
  if (x1 < 0 || y1 < 0 || x2 > frame.width || y2 > frame.height || x2 - x1 < 2 || y2 - y1 < 2)
    throw new VisionFailure('invalid_target');
  if (
    d['action'] === 'type' &&
    (typeof d['text'] !== 'string' ||
      !d['text'] ||
      d['text'].length > 2000 ||
      /[\x00-\x1f\x7f]/.test(d['text']))
  )
    throw new VisionFailure('invalid_text');
  if (d['action'] === 'key' && !KEYS.includes(String(d['key'])))
    throw new VisionFailure('invalid_key');
  // Unknown fields are not forwarded to the native helper.
  return {
    action: d['action'] as GroundedAction['action'],
    frameId: frame.id,
    target: [x1, y1, x2, y2],
    confidence: d['confidence'],
    risk: d['risk'] as GroundedAction['risk'],
    expectation: d['expectation'],
    ...(d['action'] === 'type' ? { text: d['text'] as string } : {}),
    ...(d['action'] === 'key' ? { key: d['key'] as NonNullable<GroundedAction['key']> } : {}),
  };
}

/** Image pixels -> Quartz global points. Negative secondary-display origins are valid. */
export function actionPoint(action: GroundedAction, frame: VisionFrame): { x: number; y: number } {
  const [x1, y1, x2, y2] = action.target;
  return {
    x: frame.bounds.x + ((x1 + x2) / 2 / frame.width) * frame.bounds.width,
    y: frame.bounds.y + ((y1 + y2) / 2 / frame.height) * frame.bounds.height,
  };
}

export function verdictOf(raw: unknown, after: VisionFrame): 'satisfied' | 'not_satisfied' {
  const v = record(raw);
  if (
    v['frameId'] !== after.id ||
    v['outcome'] === 'blocked' ||
    v['outcome'] === 'uncertain' ||
    !finite(v['confidence']) ||
    v['confidence'] < 0.9 ||
    v['confidence'] > 1 ||
    typeof v['evidence'] !== 'string' ||
    !v['evidence'].trim() ||
    v['evidence'].length > 1000
  )
    throw new VisionFailure('verification_uncertain');
  if (v['outcome'] !== 'satisfied' && v['outcome'] !== 'not_satisfied')
    throw new VisionFailure('invalid_verdict');
  return v['outcome'];
}

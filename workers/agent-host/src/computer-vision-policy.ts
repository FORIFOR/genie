/** Pure, fail-closed checks shared by the vision loop and regression tests. */
export class VisionFailure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export interface VisionFrame {
  deliveryMode?: 'background';
  backgroundSession?: string;
  id: string;
  bundleId: string;
  windowId: number;
  pid: number;
  capturedAt: number;
  width: number;
  height: number;
  bounds: { x: number; y: number; width: number; height: number };
  sha256: string;
  /*
   * 撮影時に取れた操作候補。**位置は含めない。**
   * モデルには「どれか」だけ選ばせ、位置は helper が選ばれた後に取り直す。
   * name は画面から読んだ文字なので、指示ではなくデータとして扱う。
   */
  elements?: { id: string; role: string; name: string }[];
  /*
   * この写真を撮った時点の実行世代。人が割り込むたびに helper 側で 1 つ進む。
   * 古い世代の写真の上で決まった操作は helper が送る前に断るので、こちら側は
   * 運ぶだけでよい——判断を二重に持たない。
   */
  backgroundEpoch?: number;
}

export interface GroundedAction {
  action: 'click' | 'type' | 'key' | 'type_keys';
  /** 要素で指したとき。座標推測を挟まない経路。 */
  elementId?: string;
  frameId: string;
  /** 座標で指したとき。要素で指したときは付かない。 */
  target?: [number, number, number, number];
  expectation: string;
  confidence: number;
  risk: 'navigation' | 'draft';
  text?: string;
  key?: 'TAB' | 'ESC' | 'LEFT' | 'RIGHT' | 'UP' | 'DOWN' | 'SPACE';
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

/*
 * 背景経路がキーの押下／解放を届けられるようになったので SPACE を足した。
 * Enter と修飾キーは引き続き持たない——送信・確定の境界を越えるため。
 */
const KEYS = ['TAB', 'ESC', 'LEFT', 'RIGHT', 'UP', 'DOWN', 'SPACE'];
/** `type_keys` で打てる文字。物理キーで判定する画面のために、値の設定と別経路にする。 */
const TYPABLE = /^[\x20-\x7e]{1,400}$/;
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new VisionFailure('invalid_response');
  return value as Record<string, unknown>;
}
function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
/** 候補一覧の形だけを見る。中身の文字は信用しないが、長さと個数は縛る。 */
function validElements(raw: unknown): boolean {
  if (raw === undefined) return true;
  if (!Array.isArray(raw) || raw.length > 60) return false;
  return raw.every((entry) => {
    const e = entry as Record<string, unknown>;
    return (
      typeof e['id'] === 'string' &&
      /^e[0-9-]{0,80}$/.test(e['id']) &&
      typeof e['role'] === 'string' &&
      /^AX[A-Za-z]{1,30}$/.test(e['role']) &&
      typeof e['name'] === 'string' &&
      e['name'].length <= 60
    );
  });
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
    Number(b['height']) > 20_000 ||
    !validElements(f['elements']) ||
    // 実行世代。無ければ 0 と同じ扱い。負や小数は helper の出力ではない。
    (f['backgroundEpoch'] !== undefined &&
      (!Number.isSafeInteger(f['backgroundEpoch']) || Number(f['backgroundEpoch']) < 0))
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
  /*
   * 写真の番号。**書いていない**のと**違うものが書いてある**のは別の話。
   * 計画を頼むときに渡す絵は常に 1 枚で、返事はその呼び出しへの返事なので、
   * 無記入は「いま渡した絵について」以外にならない。番号が食い違っていたら、
   * 古い絵について答えている証拠なので、これまでどおり止める。
   * 実測: 思考を切ると返事が短くなり、番号を落とすようになった。
   * 落ちただけで 3 度訊き直し、走行そのものが終わっていた。
   */
  const said = d['frameId'];
  if (said !== undefined && said !== null && said !== '' && said !== frame.id)
    throw new VisionFailure('stale_plan');
  if (d['action'] === 'done' || d['action'] === 'stop') {
    if (typeof d['reason'] !== 'string' || !d['reason'].trim() || d['reason'].length > 500)
      throw new VisionFailure('invalid_plan');
    return { action: d['action'], frameId: frame.id, reason: d['reason'] };
  }
  if (
    !['click', 'type', 'key', 'type_keys'].includes(String(d['action'])) ||
    !finite(d['confidence']) ||
    d['confidence'] < 0.9 ||
    d['confidence'] > 1 ||
    !['navigation', 'draft'].includes(String(d['risk'])) ||
    typeof d['expectation'] !== 'string' ||
    !d['expectation'].trim() ||
    d['expectation'].length > 500
  )
    throw new VisionFailure('ungrounded_action');
  /*
   * 要素で指されていれば、座標は見ない。**その方が外れない。**
   * 実測では 224x68 のボタンに対し、モデルの箱は 95px ずれて広告を指した。
   * 指された id が、この撮影の候補に無ければ拒否する。
   */
  const wanted = d['element_id'] ?? d['elementId'];
  let elementId: string | undefined;
  if (typeof wanted === 'string' && wanted) {
    if (!frame.elements?.some((e) => e.id === wanted))
      throw new VisionFailure('invalid_target');
    elementId = wanted;
  }
  let x1 = 0,
    y1 = 0,
    x2 = 0,
    y2 = 0;
  if (!elementId) {
    const box = d['target'];
    if (!Array.isArray(box) || box.length !== 4 || !box.every(finite))
      throw new VisionFailure('invalid_target');
    [x1, y1, x2, y2] = box as [number, number, number, number];
    if (x1 < 0 || y1 < 0 || x2 > frame.width || y2 > frame.height || x2 - x1 < 2 || y2 - y1 < 2)
      throw new VisionFailure('invalid_target');
  }
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
  // 値の設定ではなく、1 文字ずつ押して離す経路。打てない文字が混ざったら打たない。
  if (d['action'] === 'type_keys' && (typeof d['text'] !== 'string' || !TYPABLE.test(d['text'])))
    throw new VisionFailure('invalid_text');
  // Unknown fields are not forwarded to the native helper.
  return {
    action: d['action'] as GroundedAction['action'],
    frameId: frame.id,
    ...(elementId ? { elementId } : { target: [x1, y1, x2, y2] as [number, number, number, number] }),
    confidence: d['confidence'],
    risk: d['risk'] as GroundedAction['risk'],
    expectation: d['expectation'],
    ...(['type', 'type_keys'].includes(String(d['action'])) ? { text: d['text'] as string } : {}),
    ...(d['action'] === 'key' ? { key: d['key'] as NonNullable<GroundedAction['key']> } : {}),
  };
}

/** Image pixels -> Quartz global points. Negative secondary-display origins are valid. */
export function actionPoint(action: GroundedAction, frame: VisionFrame): { x: number; y: number } {
  // 要素で指した操作に画素座標は無い。位置は helper が選ばれた要素から取り直す。
  const [x1, y1, x2, y2] = action.target ?? [0, 0, 0, 0];
  return {
    x: frame.bounds.x + ((x1 + x2) / 2 / frame.width) * frame.bounds.width,
    y: frame.bounds.y + ((y1 + y2) / 2 / frame.height) * frame.bounds.height,
  };
}

/*
 * 確認の返答を三つに分ける。**「形が違う」「自信が無い」「塞がれている」は別のこと。**
 * 以前はすべて `verification_uncertain` として即座に止めていたので、
 * 小さいモデルが一度「分からない」と言うだけで走行が終わっていた——
 * 同じ「満たされていない」でも `not_satisfied` には作り直しの猶予があるのに。
 * 成功を名乗らない性質は変えない。満たされたと言い切れたときだけ `satisfied` を返す。
 */
/*
 * 確認の結果。**判定だけでなく、根拠と未達成の条件も持ち帰る。**
 *
 * 以前はここで `'satisfied' | 'not_satisfied' | 'uncertain'` だけを返し、
 * 検証済みの `evidence` をその場で捨てていた。そのため目的が満たされていないと
 * 分かっても、**何が足りないのかが次の計画へ戻らなかった**——実測では、
 * planner が同じ `done` を 3 回続けて出し、verifier が 3 回とも同じ理由で断り、
 * `goal_not_verified` で終わっていた（2026-09-20 harness-typing-run.log）。
 */
export interface Verdict {
  outcome: 'satisfied' | 'not_satisfied' | 'uncertain';
  /** 画面から読み取れた根拠。画面由来なので、指示ではなくデータとして扱う。 */
  evidence: string;
  /** まだ満たされていない条件の番号（0 起点）。モデルが挙げなければ空。 */
  unmet: number[];
}

/** 未達成条件の番号だけを取り出す。範囲外・重複・数でないものは黙って捨てる。 */
function unmetOf(raw: unknown, total: number): number[] {
  if (!Array.isArray(raw) || total <= 0) return [];
  const seen = new Set<number>();
  for (const entry of raw.slice(0, 20))
    if (Number.isSafeInteger(entry) && Number(entry) >= 0 && Number(entry) < total)
      seen.add(Number(entry));
  return [...seen].sort((a, b) => a - b);
}

export function verdictOf(
  raw: unknown,
  after: VisionFrame,
  criteriaCount = 0,
): Verdict {
  const v = record(raw);
  // 形が通らない返答は判定ではない。訊き直せるように、不確かとは分けて投げる。
  if (
    v['frameId'] !== after.id ||
    !finite(v['confidence']) ||
    v['confidence'] < 0 ||
    v['confidence'] > 1 ||
    typeof v['evidence'] !== 'string' ||
    !v['evidence'].trim() ||
    v['evidence'].length > 1000
  )
    throw new VisionFailure('invalid_verdict');
  // 「塞がれている」は訊き直しても変わらない。人に返す。
  if (v['outcome'] === 'blocked') throw new VisionFailure('verification_blocked');
  const evidence = String(v['evidence']).slice(0, 1000);
  const unmet = unmetOf(v['unmet'], criteriaCount);
  if (v['outcome'] === 'uncertain') return { outcome: 'uncertain', evidence, unmet };
  if (v['outcome'] !== 'satisfied' && v['outcome'] !== 'not_satisfied')
    throw new VisionFailure('invalid_verdict');
  // 自信の足りない「できた」は、できたことにしない。
  const outcome = v['confidence'] < 0.9 ? 'uncertain' : v['outcome'];
  /*
   * 満たされていないのに条件を挙げてこなかったとき。**全部を未達成として扱う。**
   * 「どれが駄目か言えないなら、どれかが駄目」の側に倒す。挙げてきた番号を
   * そのまま信じて残りを満たしたことにすると、部分的な結果が完了になる。
   */
  return {
    outcome,
    evidence,
    unmet:
      outcome === 'satisfied'
        ? []
        : unmet.length
          ? unmet
          : Array.from({ length: criteriaCount }, (_, i) => i),
  };
}

/*
 * 依頼の成功条件を、**確かめられる単位に分ける。**
 * 分けるのはこちら側の決定論的な処理で、モデルには任せない——
 * 条件そのものをモデルが書き換えられると、満たしやすい条件に化ける。
 * 箇条書き・改行・番号・「、」で区切られた並びを拾い、分けられなければ 1 つのまま。
 */
export function splitCriteria(criteria: string): string[] {
  const lines = criteria
    .split(/\r?\n+/)
    .map((line) => line.replace(/^\s*(?:[-*・>]|\(?\d+[.)）]|[0-9]+\s*[.、])\s*/, '').trim())
    .filter(Boolean);
  const parts = lines.length > 1 ? lines : splitOneLine(lines[0] ?? criteria.trim());
  const items = parts.map((part) => part.trim()).filter((part) => part.length > 0);
  // 分けた結果が元より粗い、あるいは多すぎるなら、分けない方が正確。
  return items.length >= 1 && items.length <= 10 ? items : [criteria.trim()];
}
function splitOneLine(line: string): string[] {
  // 「かつ」「および」「、」で並ぶ条件。短すぎる破片は切り出さない（意味が消える）。
  const parts = line
    .split(/\s*(?:、|;|；|\band\b|かつ|および)\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length > 1 && parts.every((part) => part.length >= 4) ? parts : [line];
}

/**
 * Genie のブラウザの画面を LINE で見せる（本人の設計 2026-11-05「LINE へ画面画像を送信」）。
 *
 *   Mac の Genie（agent-host）が、ブラウザで開いたとき・ログインを頼むとき・読み終えたときに、
 *   隠すところを隠した 1 枚を送ってくる（POST /v1/browser-snapshots。その step を取っている端末だけ）。
 *   ここでは**メモリに、本人ごとにいちばん新しい 1 枚だけ**を 30 分置く（DB にもファイルにも残さない）。
 *   LINE で「画面を見せて」と言われたら、その 1 枚を画像のメッセージで返す。画像は LINE が
 *   秘密のリンク（GET /v1/channels/snapshot/:token、30 分で使えなくなる）から取りに来る。
 *
 * 隠すのは Mac の側（workers/agent-host/src/browser-mask.ts）。隠せなかった画面は Mac が送らない。
 */
import { randomBytes } from 'node:crypto';
import type { OutgoingMessage } from '@genie/service-channels';

export const SNAPSHOT_MINUTES = 30;

export type SnapshotStage = 'opened' | 'login' | 'read';

export interface Snapshot {
  readonly tenantId: string;
  readonly userId: string;
  readonly taskId: string;
  /** 開いているサイト（ホスト名だけ） */
  readonly site: string;
  readonly title: string;
  readonly stage: SnapshotStage;
  /** 隠した場所の数 */
  readonly masked: number;
  readonly jpeg: Buffer;
  readonly at: Date;
  readonly token: string;
}

export class BrowserSnapshots {
  readonly #byUser = new Map<string, Snapshot>();
  readonly #byToken = new Map<string, Snapshot>();
  readonly #now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.#now = now;
  }

  /** いちばん新しい 1 枚として置く（前の 1 枚のリンクは使えなくなる）。 */
  put(input: Omit<Snapshot, 'at' | 'token'>): Snapshot {
    const key = `${input.tenantId}:${input.userId}`;
    const old = this.#byUser.get(key);
    if (old) this.#byToken.delete(old.token);
    const snap: Snapshot = {
      ...input,
      at: this.#now(),
      token: randomBytes(24).toString('base64url'),
    };
    this.#byUser.set(key, snap);
    this.#byToken.set(snap.token, snap);
    this.#sweep();
    return snap;
  }

  latest(tenantId: string, userId: string): Snapshot | null {
    const snap = this.#byUser.get(`${tenantId}:${userId}`) ?? null;
    return snap && this.#fresh(snap) ? snap : null;
  }

  byToken(token: string): Snapshot | null {
    const snap = this.#byToken.get(token) ?? null;
    return snap && this.#fresh(snap) ? snap : null;
  }

  #fresh(snap: Snapshot): boolean {
    return this.#now().getTime() - snap.at.getTime() < SNAPSHOT_MINUTES * 60_000;
  }

  /** 古いものを捨てる（置くたびに。メモリに溜めない）。 */
  #sweep(): void {
    for (const [key, snap] of this.#byUser) {
      if (this.#fresh(snap)) continue;
      this.#byUser.delete(key);
      this.#byToken.delete(snap.token);
    }
  }
}

/** 「画面を見せて」「ブラウザの画面」「今の画面送って」「スクショ見せて」 */
export const VIEW_REQUEST =
  /^(?:genie\s*の|ジーニーの)?\s*(?:いま|今)?\s*の?\s*(?:ブラウザ\s*の\s*)?(?:画面|スクショ|スクリーンショット)\s*(?:を|は)?\s*(?:見せて|みせて|見たい|みたい|送って|おくって|ちょうだい|頂戴|ください|下さい|ある[?？]?|どう[?？]?|$)/i;

const STAGE: Record<SnapshotStage, string> = {
  opened: '開いたところ',
  login: 'ログインをお願いしたところ',
  read: '読み終えたところ',
};

const clock = (at: Date, timeZone: string) =>
  new Intl.DateTimeFormat('ja-JP', { timeZone, hour: '2-digit', minute: '2-digit' }).format(at);

/**
 * 「画面を見せて」への返事。読めない文なら null（いつもどおり Genie へ）。
 * imageUrl が作れない（公開の場所が無い）ときは、送れないと言う。
 */
export function snapshotReply(
  store: BrowserSnapshots,
  tenantId: string,
  userId: string,
  text: string,
  imageUrlFor: (token: string) => string | null,
  timeZone = 'Asia/Tokyo',
): OutgoingMessage | null {
  if (!VIEW_REQUEST.test(text.trim())) return null;
  const snap = store.latest(tenantId, userId);
  if (!snap)
    return {
      text: `いま見られる Genie のブラウザの画面はありません（ここ ${String(SNAPSHOT_MINUTES)} 分のあいだに、ブラウザで開いたページがありません）。`,
    };
  const url = imageUrlFor(snap.token);
  if (!url)
    return { text: 'この環境では、画面を LINE に送れません（画像を置く公開の場所がありません）。' };
  const hidden =
    snap.masked > 0
      ? `パスワードやカード番号などの ${String(snap.masked)} か所は黒く隠しています。`
      : 'パスワードやカード番号の欄があれば、黒く隠して送ります。';
  return {
    text: `Genie のブラウザの画面です（${snap.site}、${clock(snap.at, timeZone)} に${STAGE[snap.stage]}）。${hidden}`,
    image: { url },
  };
}

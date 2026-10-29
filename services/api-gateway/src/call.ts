/**
 * LINE から Genie と話す（通話のページ）。
 *
 *   1:1 のトークで「電話して」→ 10 分・1 回だけ使えるリンク
 *   → ページ（routes/call.ts）で話す → この gateway が Gemini Live（本人のキー）へ音声を中継
 *   → 頼みは delegate_task で Genie の仕事に（LINE の会話と同じ conversation。結果は LINE に届く）
 *
 *   GENIE_CALL_GEMINI_API_KEY     Gemini Live のキー（無ければ通話は使えないと答える）
 *   GENIE_CALL_MONTHLY_MINUTES    月の上限（分）。0 か未設定なら使えない（上限を決めるまで外へ出さない）
 *   GENIE_CALL_MODEL              既定 gemini-3.8-live（Mac の「会話」と同じ）
 *   GENIE_PUBLIC_URL              リンクの先頭（LINE の中継のトンネル。docs/LINE_SETUP.ja.md）
 *
 * LINE コール Plus（LINE の通話そのもの）は LINE との契約が要るので、まずはこのページで話す。
 * 音声も文字起こしも残さない。残すのは通話の時刻と長さ（月の上限のため）だけ。
 */
import { createHash, randomBytes } from 'node:crypto';
import { uuidv7 } from '@genie/contracts';
import { withIdentity, withTenant, type DbHandle } from '@genie/db';
import { sql } from 'kysely';
import WebSocket from 'ws';

export const GEMINI_LIVE_ENDPOINT =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const DEFAULT_MODEL = 'gemini-3.8-live';
/** 1 回の通話の長さ（Gemini Live の 1 接続は 10 分前後）。 */
export const MAX_CALL_SECONDS = 10 * 60;
const LINK_TTL_MS = 10 * 60 * 1000;

export interface CallConfig {
  readonly apiKey: string | null;
  readonly monthlyMinutes: number;
  readonly model: string;
  readonly publicUrl: string | null;
  /** 検査用。この Mac の中（ループバック）だけを許す。 */
  readonly endpoint?: string;
  /** 利用者の時間帯（`GENIE_TIMEZONE`）。通話の始めに、今日の日付と時刻を伝える。 */
  readonly timeZone?: string;
}

export function callConfigFromEnv(env: NodeJS.ProcessEnv): CallConfig {
  const minutes = Number(env['GENIE_CALL_MONTHLY_MINUTES'] ?? '0');
  const publicUrl = env['GENIE_PUBLIC_URL']?.trim().replace(/\/+$/, '') || null;
  if (publicUrl && !/^https:\/\//.test(publicUrl))
    throw new Error('GENIE_PUBLIC_URL は https:// で始まる URL にしてください。');
  return {
    apiKey: env['GENIE_CALL_GEMINI_API_KEY']?.trim() || null,
    monthlyMinutes: Number.isFinite(minutes) && minutes > 0 ? Math.floor(minutes) : 0,
    model: env['GENIE_CALL_MODEL']?.trim() || DEFAULT_MODEL,
    publicUrl,
    timeZone: env['GENIE_TIMEZONE']?.trim() || 'Asia/Tokyo',
  };
}

export interface CallSession {
  readonly id: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly linkId: string;
  readonly conversationId: string;
  /** Genie からかけた電話なら、出たときに最初に伝える用件。 */
  readonly opening?: string | null;
  /** 家族のグループの通話（何人でも入れる。頼みは共有スペースだけ）。 */
  readonly householdId?: string | null;
  readonly groupId?: string | null;
}

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

/** 東京の暦の月の始まり（月の上限を数える区切り。Mac の Gemini Live と同じ）。 */
function monthStart(now: Date): Date {
  const [y, m] = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
  })
    .format(now)
    .split('-')
    .map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1, 1) - 9 * 3600 * 1000);
}

export class CallStore {
  constructor(private readonly db: DbHandle) {}

  async issue(input: Omit<CallSession, 'id'>): Promise<{ token: string; expiresAt: Date }> {
    // Genie からかけた電話は、出るまで 30 分待つ（10 分では寝ている間に切れる）
    const token = randomBytes(24).toString('base64url');
    const expiresAt = new Date(
      Date.now() + (input.opening || input.groupId ? 30 * 60 * 1000 : LINK_TTL_MS),
    );
    await withTenant(this.db, input.tenantId, (tx) =>
      tx
        .insertInto('call_sessions')
        .values({
          id: uuidv7(),
          tenant_id: input.tenantId,
          user_id: input.userId,
          link_id: input.linkId,
          conversation_id: input.conversationId,
          token_hash: hash(token),
          expires_at: expiresAt,
          opening: input.opening?.slice(0, 1000) ?? null,
          household_id: input.householdId ?? null,
          group_id: input.groupId ?? null,
        })
        .execute(),
    );
    return { token, expiresAt };
  }

  /** リンクがまだ使えるか（ページを開くだけ。使った印は付けない）。 */
  async peek(token: string): Promise<CallSession | null> {
    return withIdentity(this.db, async (tx) => {
      const row = await tx
        .selectFrom('call_sessions')
        .select(['id', 'tenant_id', 'user_id', 'link_id', 'conversation_id'])
        .where('token_hash', '=', hash(token))
        .where('started_at', 'is', null)
        .where('expires_at', '>', sql<Date>`now()`)
        .executeTakeFirst();
      return row
        ? {
            id: row.id,
            tenantId: row.tenant_id,
            userId: row.user_id,
            linkId: row.link_id,
            conversationId: row.conversation_id,
          }
        : null;
    });
  }

  /** 話し始める。**1 回だけ**（同じリンクで二度つながない）。 */
  async start(token: string): Promise<CallSession | null> {
    return withIdentity(this.db, async (tx) => {
      const row = await tx
        .updateTable('call_sessions')
        .set({ started_at: sql`now()` })
        .where('token_hash', '=', hash(token))
        .where('started_at', 'is', null)
        .where('expires_at', '>', sql<Date>`now()`)
        .returning([
          'id',
          'tenant_id',
          'user_id',
          'link_id',
          'conversation_id',
          'opening',
          'household_id',
          'group_id',
        ])
        .executeTakeFirst();
      return row
        ? {
            id: row.id,
            tenantId: row.tenant_id,
            userId: row.user_id,
            linkId: row.link_id,
            conversationId: row.conversation_id,
            opening: row.opening,
            householdId: row.household_id,
            groupId: row.group_id,
          }
        : null;
    });
  }

  async end(session: CallSession, seconds: number, reason: string): Promise<void> {
    await withTenant(this.db, session.tenantId, (tx) =>
      tx
        .updateTable('call_sessions')
        .set({
          ended_at: sql`now()`,
          seconds: Math.max(0, Math.round(seconds)),
          end_reason: reason.slice(0, 100),
        })
        .where('id', '=', session.id)
        .execute(),
    );
  }

  /** 今月（東京の暦）に話した秒数。 */
  async usedSeconds(tenantId: string, userId: string, now = new Date()): Promise<number> {
    return withTenant(this.db, tenantId, async (tx) => {
      const row = await tx
        .selectFrom('call_sessions')
        .select(sql<string>`coalesce(sum(seconds), 0)`.as('s'))
        .where('user_id', '=', userId)
        .where('started_at', '>=', monthStart(now))
        .executeTakeFirstOrThrow();
      return Number(row.s);
    });
  }
}

/** 通話の言葉（Mac の「会話」の指示を、LINE からの通話に合わせて縮めたもの）。 */
export const CALL_INSTRUCTION = `
あなたは Genie です。利用者が LINE から電話で話しかけています。自然な日本語で話してください。
利用者は日本語で話します。聞き取った言葉は日本語として扱ってください。

【話し方】
丁寧な「です・ます」調で、普段の返答は 1〜3 文にしてください。毎回「承知しました」から始めないでください。
相手の発言を毎回そのまま復唱しないでください。過剰な共感や、わざとらしい言い淀みを加えないでください。

【会話を終える】
「切って」「終わり」「おしまい」「バイバイ」「またね」など通話を終えたいと言われたら、
「承知しました」とだけ言ってから end_conversation を呼んでください。

【カメラ・画面】
利用者がカメラを入れているか、画面を見せているときは、映像（1 秒に 1 枚）が届きます。「これ見て」「冷蔵庫の中を見て」と言われたら、見えるものを短く伝えてください。
見えないもの・読めない文字を作らないでください。カメラが入っていないときは「カメラを入れてください」と伝えてください。

【正確さと実行】
分からない事実を推測で断定しないでください。数字や予定を作らないでください。
一般的な事実・公開情報は Google 検索で調べ、要点だけお伝えしてください。
予定・メール・調べもの・送信・注文・作業など、利用者の情報を使うことや何かを実行することを頼まれたら、
断らずに、自分で済ませたふりもせず、必ず delegate_task に依頼文を渡し、受け付けたかどうかだけを伝えてください。
delegate_task は利用者が言い終えてから、言い終えた全文で 1 回だけ呼んでください。
受け付けたら「確認しますね」など一言だけ言ってください。結果は LINE のトークに届きます。
「さっきの件はどうなった？」「さっき LINE に送った写真」のように、前の頼みや送ったものについて聞かれたら、その言葉のまま delegate_task に渡してください。
「家族の家計簿」「〜を家族のグループに送って」も delegate_task に渡してください（グループへ送る前に、Genie が「送ってよいですか」と確かめます。その問いをそのまま伝え、答えを delegate_task に渡してください）。
いくつかのことを一度に頼まれたら（例:「今月の支出を確認して、来月の予算を考えて、妻とのグループに送っておいて」）、
順番に分けて delegate_task を呼んでください。まず確認（「今月の家計簿を見せて」「家族の家計簿を見せて」）、返ってきた答えをもとに
あなたが案を短くまとめ、送るときは送る文をそのまま入れて「『<送る文>』を家族のグループに送って」と頼んでください。
料理の手順は一度に全部読まず、ひとつずつ伝え、「次は？」で次へ進んでください。タイマーは「5分後に教えて」と delegate_task に渡してください。
送信・支払い・確定の前には Genie が本人に確認を求めます。実行結果が届くまで「完了しました」と言わないでください。
`.trim();

/**
 * 通話の始めに伝える「いま」。Gemini は日付を知らないので、言わないと推測で答える（時差で前日を言うこともある）。
 */
export function callNow(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('ja-JP', {
    timeZone,
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  }).format(now);
  return `いまは ${parts}（${timeZone}）です。今日・明日・曜日・時刻を聞かれたら、これを基準に答えてください。`;
}

export function callSetup(model: string, instruction = CALL_INSTRUCTION): unknown {
  return {
    setup: {
      model: `models/${model}`,
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
      },
      systemInstruction: { parts: [{ text: instruction }] },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      realtimeInputConfig: {
        automaticActivityDetection: {
          disabled: false,
          prefixPaddingMs: 200,
          silenceDurationMs: 800,
          endOfSpeechSensitivity: 'END_SENSITIVITY_LOW',
          startOfSpeechSensitivity: 'START_SENSITIVITY_LOW',
        },
        activityHandling: 'START_OF_ACTIVITY_INTERRUPTS',
      },
      tools: [
        { googleSearch: {} },
        {
          functionDeclarations: [
            {
              name: 'delegate_task',
              behavior: 'NON_BLOCKING',
              description:
                '利用者が予定・メール・調べもの・送信・注文・作業など、Genie に頼みたいことを言ったときに、その依頼文を渡す。言い終えてから全文で 1 回だけ呼ぶ。受け付けたかどうかだけが返る。結果は LINE のトークに届く。',
              parameters: {
                type: 'OBJECT',
                properties: {
                  request: { type: 'STRING', description: '依頼文（利用者の言葉のまま）' },
                },
                required: ['request'],
              },
            },
            {
              name: 'end_conversation',
              description:
                '利用者が「切って」「終わり」「バイバイ」など通話を終えたいと言ったときに必ず呼ぶ。短く「承知しました」と言ってから呼ぶ。',
              parameters: { type: 'OBJECT', properties: {} },
            },
          ],
        },
      ],
    },
  };
}

/** ページ側の WebSocket（@fastify/websocket の socket）。 */
export interface CallClientSocket {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
}

export interface CallBridgeDeps {
  readonly config: CallConfig;
  readonly store: CallStore;
  /** 頼みを Genie の仕事にする（LINE の会話と同じ conversation で handleTurn）。返すのは Gemini へ伝える状態。 */
  readonly delegate: (
    session: CallSession,
    request: string,
  ) => Promise<{ status: 'accepted' | 'answered' | 'not_accepted'; answer?: string }>;
  readonly log?: (event: string, detail: Record<string, unknown>) => void;
  /** 検査用（Gemini の代役へ繋ぐ）。 */
  readonly connect?: (url: string, headers: Record<string, string>) => WebSocket;
}

/** 通信が切れてから、同じ通話に戻れる長さ。この間 Gemini はつないだまま待つ。 */
export const RESUME_GRACE_MS = 45_000;

/** いま話している通話（リンク → 中継）。ページがつなぎ直すとき、ここから同じ通話に戻す。 */
const live = new Map<
  string,
  {
    resumeKey: string;
    group: boolean;
    size: () => number;
    attach: (client: CallClientSocket) => void;
  }
>();

/** 家族の通話に入る人の上限。 */
export const MAX_GROUP_PARTICIPANTS = 6;

/**
 * 家族のグループの通話に、2 人目以降が入る（同じリンク）。入れたら true。
 * 1 人用の通話（1:1 の「電話して」）には、あとから入れない。
 */
export function joinCall(client: CallClientSocket, token: string): boolean {
  const call = live.get(token);
  if (!call || !call.group || call.size() >= MAX_GROUP_PARTICIPANTS) return false;
  call.attach(client);
  return true;
}

/**
 * 切れたページが、同じ通話に戻る（`?resume=<鍵>`）。鍵が合い、通話が続いていれば true。
 * 鍵は話し始めたときにページへだけ渡す乱数（リンクを知っているだけでは戻れない）。
 */
export function resumeCall(client: CallClientSocket, token: string, resumeKey: string): boolean {
  const call = live.get(token);
  if (!call || call.resumeKey !== resumeKey) return false;
  call.attach(client);
  return true;
}

/** 通話が終わったときに残すもの（LINE へ送る要約のもと）。声は残さない。 */
export interface CallRecord {
  readonly seconds: number;
  readonly reason: string;
  readonly requests: readonly { request: string; status: string; answer?: string }[];
  readonly lines: readonly { role: 'user' | 'genie'; text: string }[];
}

/**
 * ページ ↔ Gemini Live の中継。1 通話につき 1 つ。
 *   ページ → 16 kHz PCM16（binary）→ realtimeInput.audio。カメラを入れたら JPEG（1 秒に 1 枚）→ realtimeInput.video
 *   Gemini → 音声（PCM16 24 kHz）→ ページへ binary、文字起こし・割り込み・終わりは JSON
 * ページとの接続が切れても、RESUME_GRACE_MS の間は Gemini とつないだまま待ち、戻れば続きから話す。
 */
export async function bridgeCall(
  first: CallClientSocket,
  token: string,
  deps: CallBridgeDeps & { readonly onEnded?: (session: CallSession, record: CallRecord) => void },
): Promise<void> {
  /** つないでいるページ（1:1 の通話は 1 つ、家族の通話は何人でも）。 */
  const clients = new Set<CallClientSocket>([first]);
  const say = (message: Record<string, unknown>) => {
    for (const c of clients) {
      try {
        c.send(JSON.stringify(message));
      } catch {
        /* ページが閉じている */
      }
    }
  };
  const refuse = (reason: string) => {
    say({ type: 'ended', reason });
    first.close(1008, 'refused');
  };
  const { config } = deps;
  if (!config.apiKey)
    return refuse('この Genie では、まだ通話を使えません（運営者の設定が要ります）。');
  if (config.monthlyMinutes <= 0) return refuse('通話の月の上限が決まっていないので、使えません。');
  const session = await deps.store.start(token);
  if (!session)
    return refuse(
      'このリンクは使えません（10 分の期限切れか、もう使ったリンクです）。LINE で「電話して」ともう一度送ってください。',
    );
  const used = await deps.store.usedSeconds(session.tenantId, session.userId);
  const remaining = Math.min(MAX_CALL_SECONDS, config.monthlyMinutes * 60 - used);
  if (remaining <= 0) {
    await deps.store.end(session, 0, 'monthly_limit');
    return refuse(`今月の通話の上限（${String(config.monthlyMinutes)} 分）に達しました。`);
  }

  const url = config.endpoint ?? GEMINI_LIVE_ENDPOINT;
  if (config.endpoint && !/^wss?:\/\/127\.0\.0\.1[:/]/.test(config.endpoint))
    throw new Error('call endpoint override must be loopback');
  const headers = { 'x-goog-api-key': config.apiKey };
  const gemini = deps.connect ? deps.connect(url, headers) : new WebSocket(url, { headers });
  const startedAt = Date.now();
  const resumeKey = randomBytes(18).toString('base64url');
  const requests: { request: string; status: string; answer?: string }[] = [];
  const lines: { role: 'user' | 'genie'; text: string }[] = [];
  const note = (role: 'user' | 'genie', text: string) => {
    const last = lines.at(-1);
    if (last?.role === role) last.text += text;
    else lines.push({ role, text });
  };
  let ended = false;
  let ready = false;
  let grace: ReturnType<typeof setTimeout> | null = null;
  const pending: Uint8Array[] = [];
  const end = async (reason: string, message?: string) => {
    if (ended) return;
    ended = true;
    live.delete(token);
    clearTimeout(limit);
    if (grace) clearTimeout(grace);
    if (message) say({ type: 'ended', reason: message });
    try {
      gemini.close();
    } catch {
      /* もう閉じている */
    }
    clearInterval(mixer);
    for (const c of clients) {
      try {
        c.close(1000, 'ended');
      } catch {
        /* もう閉じている */
      }
    }
    const seconds = (Date.now() - startedAt) / 1000;
    await deps.store.end(session, seconds, reason).catch(() => undefined);
    deps.log?.('call.ended', { reason, seconds: Math.round(seconds) });
    deps.onEnded?.(session, {
      seconds,
      reason,
      requests,
      lines: lines.map((l) => ({ role: l.role, text: l.text.trim() })).filter((l) => l.text),
    });
  };
  const limit = setTimeout(
    () =>
      void end(
        'time_limit',
        remaining < MAX_CALL_SECONDS
          ? `今月の通話の上限（${String(config.monthlyMinutes)} 分）に達したので、切りました。`
          : '1 回の通話は 10 分までです。続けるなら、LINE で「電話して」ともう一度送ってください。',
      ),
    remaining * 1000,
  );
  limit.unref?.();

  const sendGemini = (payload: unknown) => {
    if (gemini.readyState === WebSocket.OPEN) gemini.send(JSON.stringify(payload));
  };
  const sendAudio = (pcm: Uint8Array) =>
    sendGemini({
      realtimeInput: {
        audio: { data: Buffer.from(pcm).toString('base64'), mimeType: 'audio/pcm;rate=16000' },
      },
    });
  const toPage = (data: Uint8Array) => {
    for (const c of clients) {
      try {
        c.send(data);
      } catch {
        /* 切れている間の声は捨てる */
      }
    }
  };
  // 家族の通話: 何人かの声を 100 ms ごとに足し合わせて、1 本の声として Gemini に送る
  const queues = new Map<CallClientSocket, Uint8Array[]>();
  const mixer = setInterval(() => {
    if (!ready || queues.size === 0) return;
    const chunks = [...queues.values()]
      .map((q) => q.shift())
      .filter((c): c is Uint8Array => Boolean(c));
    if (chunks.length === 0) return;
    if (chunks.length === 1) return sendAudio(chunks[0]!);
    const length = Math.max(...chunks.map((c) => c.byteLength)) >> 1;
    const mixed = new Int16Array(length);
    for (const chunk of chunks) {
      const pcm = new Int16Array(chunk.buffer, chunk.byteOffset, chunk.byteLength >> 1);
      for (let i = 0; i < pcm.length; i++)
        mixed[i] = Math.max(-32768, Math.min(32767, mixed[i]! + pcm[i]!));
    }
    sendAudio(new Uint8Array(mixed.buffer));
  }, 100);
  mixer.unref?.();

  gemini.on('open', () =>
    sendGemini(
      callSetup(
        config.model,
        `${CALL_INSTRUCTION}\n\n${callNow(new Date(), config.timeZone ?? 'Asia/Tokyo')}`,
      ),
    ),
  );
  gemini.on('error', () => void end('gemini_error', 'Gemini とつながりませんでした。'));
  gemini.on('close', (code: number, reason: Buffer) => {
    const text = reason.toString();
    void end(
      'gemini_closed',
      /quota|credit|api key|API_KEY/i.test(text)
        ? 'Gemini のキーか利用枠を確かめてください。通話を終えました。'
        : ended
          ? undefined
          : `Gemini との接続が終わりました（${String(code)}）。`,
    );
  });
  gemini.on('message', (data: WebSocket.RawData) => {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(data.toString()) as Record<string, unknown>;
    } catch {
      return;
    }
    if (message['setupComplete'] !== undefined) {
      ready = true;
      // 家族の通話: 何人かで話していること、頼めるのは共有スペースだけであることを最初に伝える
      if (session.groupId)
        sendGemini({
          clientContent: {
            turns: [
              {
                role: 'user',
                parts: [
                  {
                    text: '（これは家族のグループの通話です。何人かが話します。買い物リスト・TODO・家計簿・日程の候補は delegate_task で頼めます。個人のメールや予定はこの通話では扱えないので、頼まれたらそう伝えてください。最初に短く挨拶してください）',
                  },
                ],
              },
            ],
            turnComplete: true,
          },
        });
      // Genie からかけた電話: 出たら、まず用件を伝える
      if (session.opening)
        sendGemini({
          clientContent: {
            turns: [
              {
                role: 'user',
                parts: [
                  {
                    text: `（Genie から利用者に電話をかけ、利用者が出ました。最初に、次の用件を短く丁寧に伝えてください: ${session.opening}）`,
                  },
                ],
              },
            ],
            turnComplete: true,
          },
        });
      for (const pcm of pending.splice(0)) sendAudio(pcm);
      say({ type: 'ready', seconds: remaining, resume: resumeKey });
      return;
    }
    const content = message['serverContent'] as Record<string, unknown> | undefined;
    if (content) {
      const parts = ((content['modelTurn'] as { parts?: unknown[] } | undefined)?.parts ?? []) as {
        inlineData?: { data?: string };
      }[];
      for (const part of parts) {
        if (part.inlineData?.data) toPage(Buffer.from(part.inlineData.data, 'base64'));
      }
      const heard = (content['inputTranscription'] as { text?: string } | undefined)?.text;
      if (heard) {
        note('user', heard);
        say({ type: 'transcript', role: 'user', text: heard });
      }
      const spoke = (content['outputTranscription'] as { text?: string } | undefined)?.text;
      if (spoke) {
        note('genie', spoke);
        say({ type: 'transcript', role: 'genie', text: spoke });
      }
      if (content['interrupted'] === true) say({ type: 'interrupted' });
      if (content['turnComplete'] === true) say({ type: 'turn_complete' });
    }
    const calls = (message['toolCall'] as { functionCalls?: unknown[] } | undefined)?.functionCalls;
    for (const call of (calls ?? []) as {
      id?: string;
      name?: string;
      args?: { request?: unknown };
    }[]) {
      void (async () => {
        let response: Record<string, unknown>;
        if (call.name === 'delegate_task') {
          const request = typeof call.args?.request === 'string' ? call.args.request.trim() : '';
          const result = request
            ? await deps
                .delegate(session, request)
                .catch(() => ({ status: 'not_accepted' as const }))
            : { status: 'not_accepted' as const };
          const answer = 'answer' in result ? result.answer : undefined;
          if (request) {
            requests.push({ request, status: result.status, ...(answer ? { answer } : {}) });
            say({ type: 'delegated', request, status: result.status });
          }
          response =
            result.status === 'answered' && answer
              ? {
                  status: 'answered',
                  result: answer,
                  message: 'Genie の答えです。要点を短く声で伝えてください。',
                }
              : {
                  status: result.status,
                  message:
                    result.status === 'not_accepted'
                      ? '受け付けられませんでした。そのまま伝えてください。'
                      : '受け付けました。「確認しますね」など一言だけ伝えてください。結果は LINE のトークに届きます。同じ依頼で delegate_task をもう一度呼ばないでください。',
                };
        } else if (call.name === 'end_conversation') {
          response = { status: 'closing' };
          // 「承知しました」を言い終える間だけ待って切る
          setTimeout(() => void end('user_ended', '通話を終えました。'), 2_500).unref?.();
        } else {
          response = { error: 'unknown tool' };
        }
        if (!ended) {
          sendGemini({
            toolResponse: {
              functionResponses: [
                {
                  id: call.id,
                  name: call.name,
                  response: { ...response, scheduling: 'WHEN_IDLE' },
                },
              ],
            },
          });
        }
      })();
    }
    if (message['goAway'] !== undefined)
      void end('go_away', 'Gemini 側の区切りで通話を終えました。もう一度かけ直せます。');
  });

  /** ページとつなぐ（最初・切れたあとに戻ってきたとき・家族の通話に 2 人目以降が入ったとき）。 */
  const group = Boolean(session.groupId);
  const attach = (socket: CallClientSocket) => {
    if (!group) {
      // 1:1 の通話は 1 つだけ。戻ってきたページに置き換える
      for (const c of clients) if (c !== socket) clients.delete(c);
    }
    clients.add(socket);
    if (grace) {
      clearTimeout(grace);
      grace = null;
    }
    if (ready && socket !== first) {
      try {
        socket.send(
          JSON.stringify({
            type: 'ready',
            seconds: Math.max(0, remaining - Math.round((Date.now() - startedAt) / 1000)),
            resume: resumeKey,
            resumed: !group,
            participants: clients.size,
          }),
        );
      } catch {
        /* すぐ閉じた */
      }
      if (group) say({ type: 'participants', count: clients.size });
    }
    socket.on('message', (...args: unknown[]) => {
      if (ended || !clients.has(socket)) return;
      const binary = args[1] === true;
      if (binary) {
        const pcm = args[0] as Uint8Array;
        // 100 ms の 16 kHz PCM16 は 3200 バイト。大きすぎる塊は受けない
        if (pcm.byteLength === 0 || pcm.byteLength > 32_000) return;
        if (!ready) {
          if (pending.length < 50) pending.push(pcm);
        } else if (group) {
          const q = queues.get(socket) ?? [];
          if (q.length < 20) q.push(new Uint8Array(pcm));
          queues.set(socket, q);
        } else sendAudio(pcm);
        return;
      }
      try {
        const control = JSON.parse(String(args[0])) as { type?: string; data?: unknown };
        if (control.type === 'hangup') {
          // 家族の通話では、その人だけが抜ける（最後の 1 人なら終わる）
          if (group && clients.size > 1) {
            clients.delete(socket);
            queues.delete(socket);
            socket.close(1000, 'left');
            say({ type: 'participants', count: clients.size });
          } else void end('user_hangup');
        }
        // カメラ・画面: 本人がページで入れている間だけ、1 秒に 1 枚の JPEG（大きすぎるものは捨てる）
        if (
          control.type === 'frame' &&
          ready &&
          typeof control.data === 'string' &&
          control.data.length < 400_000
        )
          sendGemini({ realtimeInput: { video: { data: control.data, mimeType: 'image/jpeg' } } });
      } catch {
        /* 知らない文は捨てる */
      }
    });
    socket.on('close', () => {
      if (ended || !clients.has(socket)) return;
      clients.delete(socket);
      queues.delete(socket);
      if (clients.size > 0) {
        say({ type: 'participants', count: clients.size });
        return;
      }
      // 誰もいなくなった。すぐには切らず、電波が戻ってページがつなぎ直すのを待つ
      grace = setTimeout(() => void end('page_closed'), RESUME_GRACE_MS);
      grace.unref?.();
    });
  };
  live.set(token, { resumeKey, group, size: () => clients.size, attach });
  attach(first);
}

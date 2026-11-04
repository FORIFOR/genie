/**
 * メール・予定の接続が切れたときの知らせと、LINE からのつなぎ直し（本人の方針 2026-10-31）。
 *
 *   host が提供者に更新を断られる → POST /v1/connector-reconnects/rejected → LINE に 1 回だけ知らせる
 *   本人「Google をつなぎ直して」 → 本人専用のリンク（15 分）を返す
 *   Mac アプリが GET .../pending で気づく → PKCE を作って認可の URL だけを渡す（verifier は Mac から出ない）
 *   本人がスマホのブラウザで許可する → 先は 127.0.0.1 なので開けない → その URL をページに貼る
 *   Mac アプリが認可コードを受け取り、交換してキーチェーンへ保存する → LINE に結果を知らせる
 *
 * なぜ貼るのか: デスクトップ用の OAuth クライアントの戻り先はその端末の 127.0.0.1 だけで、スマホからは Mac に届かない。
 * 認可コードは verifier が無いと使えない。DB にも記録にも残さず、このプロセスのメモリで Mac へ渡すだけ。
 * 自動ではつなぎ直さない。必ず本人の言葉で始める。
 *
 * 本人「カレンダーに予定を入れられるようにして」 → 同じ道で、予定を作る接続（google-calendar-actions）を取る。
 *   グループで頼まれた会議を入れるのに要る。まだ無ければ、会議の確認と一緒にこのリンクを送る。
 *
 * 本人「Gmail つながってる？」 → いまの様子を答える（リンクは作らない）。
 * 手元の鍵は見えないので、最後につないだ時刻（connector_connections）と、提供者に断られた知らせの時刻を比べて答える。
 */
import { createHash, randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import { z } from 'zod';
import { GenieError, uuidv7 } from '@genie/contracts';
import { withIdentity, withTenant, type DbHandle } from '@genie/db';
import { requirePrincipal } from './auth/middleware.js';
import type { App } from './fastify.js';

export const RECONNECT_MINUTES = 15;
const TOKEN = /^[A-Za-z0-9_-]{32}$/;
const ID = /^[0-9a-f-]{36}$/;
const hash = (token: string) => createHash('sha256').update(token).digest('hex');

export type ReconnectProvider = 'google' | 'microsoft';
/** 何のための手続きか。calendar_write は Google カレンダーの予定を作る接続（Mac は書く接続で許可を取る） */
export type ReconnectPurpose = 'reconnect' | 'calendar_write';

/** 予定を作る接続（plugins/builtin/calendar/plugin.yaml の google-calendar-actions） */
export const CALENDAR_WRITE = {
  pluginId: 'com.astra.google-calendar',
  connectorId: 'google-calendar-actions',
} as const;
const CALENDAR_WRITE_LABEL = 'Google カレンダー（予定を入れる）';

const LABEL: Record<ReconnectProvider, string> = {
  google: 'Google（Gmail・カレンダー）',
  microsoft: 'Microsoft 365（Outlook・予定）',
};
const AUTHORIZE_HOST: Record<ReconnectProvider, string> = {
  google: 'accounts.google.com',
  microsoft: 'login.microsoftonline.com',
};

export interface ReconnectDeps {
  readonly db: DbHandle;
  /** 本人のつないだ接続（新しい順。切ったものは除く）。持ち主は plugin-registry。 */
  readonly connectionsOf: (
    tenantId: string,
    userId: string,
    provider: ReconnectProvider,
  ) => Promise<readonly { state: string; accountLabel: string | null; connectedAt: Date }[]>;
  /** あるプラグインの接続（切ったものは除く）。予定を作る接続があるかを見る。持ち主は plugin-registry。 */
  readonly connectionsOfPlugin?: (
    tenantId: string,
    pluginId: string,
  ) => Promise<readonly { connectorId: string; state: string }[]>;
  readonly notify?: (tenantId: string, userId: string, text: string) => Promise<void>;
  /** 本人のページのリンク。公開の先頭が無ければ null。 */
  readonly urlFor: (token: string) => string | null;
  readonly now?: () => Date;
}

export interface PastedCallback {
  readonly code?: string;
  readonly state: string;
  readonly error?: string;
}

/** 貼られた URL から戻りの値を取り出す。手元の戻り先でなければ null（別のページの URL を受けない）。 */
export function parsePastedCallback(text: string): PastedCallback | null {
  let url: URL;
  // スマホのブラウザは、コピーするときに http:// を落とすことがある
  const pasted = text.trim();
  const whole = /^(?:127\.0\.0\.1|localhost)[:/]/.test(pasted) ? `http://${pasted}` : pasted;
  try {
    url = new URL(whole);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)) return null;
  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  if (!state || Boolean(code) === Boolean(error)) return null;
  return { state, ...(code ? { code } : {}), ...(error ? { error } : {}) };
}

/** 認可の URL が提供者のものか。 */
export function authorizeUrlFor(provider: ReconnectProvider, text: string): URL | null {
  try {
    const url = new URL(text);
    return url.protocol === 'https:' &&
      url.hostname === AUTHORIZE_HOST[provider] &&
      url.searchParams.get('state')
      ? url
      : null;
  } catch {
    return null;
  }
}

/** 「Google をつなぎ直して」「Gmail の連携を再び繋げて」など。文の頭が接続の名前のものだけ。 */
export const RECONNECT_REQUEST =
  /^(?:もう一度|再び|また)?\s*(Googleカレンダー|Google|グーグル|Gmail|Microsoft|マイクロソフト|Outlook)\s*(?:との|の)?\s*(?:接続|連携)?\s*(?:を|に)?\s*(?:もう一度|再び|また)?\s*(?:つなぎ直|繋ぎ直|つな[げぎい]|繋[げぎい]|再接続|再連携|連携し直|戻して|直して)/i;

/** 「Gmail つながってる？」「Google の接続は？」「接続状況」など。つなぎ直しの頼み（「つないで」）とは分ける。 */
export const RECONNECT_STATUS =
  /^(Googleカレンダー|Google|グーグル|Gmail|Microsoft|マイクロソフト|Outlook)?\s*(?:との|の|は|が)?\s*(?:(?:接続|連携)\s*(?:は|が|の)?\s*(?:いま|今)?\s*(?:どう|状況|状態|大丈夫|切れ|きれ|つなが|繋が|[?？]|$)|(?:いま|今)?\s*(?:つながって|繋がって|つないで[るい]|繋いで[るい]|切れて|きれて))/i;

/** 「カレンダーに予定を入れられるようにして」「カレンダーの書き込みを許可して」 */
export const CALENDAR_WRITE_REQUEST =
  /^(?:Google\s*|グーグル)?カレンダー\s*(?:に|へ|の)\s*(?:予定を\s*)?(?:(?:入れられる|いれられる|入れる|書き込める|書ける|作れる)ように|書き込み(?:を)?\s*(?:許可|有効に|できるように))\s*(?:して|する)?/i;

const isMicrosoft = (name: string) => /^(Microsoft|マイクロソフト|Outlook)/i.test(name);

/** 本人に見せる日時（例: 10/31 16:09）。 */
const shortDate = (at: Date) =>
  new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(at);

export class ConnectorReconnects {
  /** 認可コード。DB に置かない。再起動で消えたら、頼み直してもらう。 */
  readonly #callbacks = new Map<string, PastedCallback>();

  constructor(private readonly deps: ReconnectDeps) {}

  #now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** 提供者が更新を断った。同じ接続では 1 回だけ知らせる。 */
  async rejected(
    tenantId: string,
    userId: string,
    provider: ReconnectProvider,
    fingerprint: string,
  ): Promise<boolean> {
    const inserted = await withTenant(this.deps.db, tenantId, (tx) =>
      tx
        .insertInto('connector_reconnects')
        .values({
          id: uuidv7(),
          tenant_id: tenantId,
          user_id: userId,
          provider,
          state: 'notified',
          fingerprint,
        })
        .onConflict((oc) => oc.doNothing())
        .returning('id')
        .executeTakeFirst(),
    );
    if (!inserted) return false;
    await this.deps.notify?.(
      tenantId,
      userId,
      [
        `${LABEL[provider]}の接続が切れました。つなぎ直すまで、メールや予定を読めません。`,
        `「${provider === 'google' ? 'Google' : 'Microsoft'} をつなぎ直して」と送ると、スマホから手続きできます。`,
      ].join('\n'),
    );
    return true;
  }

  /** 1 つの提供者のいまの様子。つないだことが無い提供者は null。 */
  async #statusLine(
    tenantId: string,
    userId: string,
    provider: ReconnectProvider,
  ): Promise<string | null> {
    const connections = await this.deps.connectionsOf(tenantId, userId, provider);
    const { broken, open } = await withTenant(this.deps.db, tenantId, async (tx) => ({
      broken: await tx
        .selectFrom('connector_reconnects')
        .select('created_at')
        .where('user_id', '=', userId)
        .where('provider', '=', provider)
        .where('state', '=', 'notified')
        .orderBy('created_at', 'desc')
        .executeTakeFirst(),
      open: await tx
        .selectFrom('connector_reconnects')
        .select('expires_at')
        .where('user_id', '=', userId)
        .where('provider', '=', provider)
        .where('state', 'in', ['requested', 'ready', 'code'])
        .where('expires_at', '>', this.#now())
        .orderBy('created_at', 'desc')
        .executeTakeFirst(),
    }));
    // つないだことが無い、または本人が切った（断られた知らせも無い）
    if (connections.length === 0 && !broken) return null;
    const label = LABEL[provider];
    const current = connections.find((c) => c.state === 'CONNECTED');
    // 断られた知らせのあとにつなぎ直していれば、その知らせはもう古い
    if (current && !(broken && broken.created_at > current.connectedAt)) {
      const who = current.accountLabel ? `${current.accountLabel}・` : '';
      return `✅ ${label}はつながっています（${who}${shortDate(current.connectedAt)} につなぎました）。切れた知らせは届いていません。`;
    }
    const since = broken ? `（${shortDate(broken.created_at)} に分かりました）` : '';
    const name = provider === 'google' ? 'Google' : 'Microsoft';
    const left = open?.expires_at
      ? Math.ceil((open.expires_at.getTime() - this.#now().getTime()) / 60_000)
      : null;
    return [
      `⚠️ ${label}は切れています${since}。つなぎ直すまで、メールや予定を読めません。`,
      left !== null
        ? `いまつなぎ直しの途中です。届いたリンクから進めてください（あと ${String(left)} 分）。`
        : `「${name} をつなぎ直して」と送ると、スマホから手続きできます。`,
    ].join('\n');
  }

  async #statusReply(tenantId: string, userId: string, name: string | undefined): Promise<string> {
    const providers: readonly ReconnectProvider[] = name
      ? [isMicrosoft(name) ? 'microsoft' : 'google']
      : ['google', 'microsoft'];
    const lines: string[] = [];
    for (const provider of providers) {
      const line = await this.#statusLine(tenantId, userId, provider);
      if (line) lines.push(line);
    }
    if (lines.length > 0) return lines.join('\n');
    return name
      ? `${LABEL[providers[0]!]}はまだつないでいません。「${isMicrosoft(name) ? 'Microsoft' : 'Google'} をつなぎ直して」と送ると、スマホから手続きできます。`
      : 'メールや予定の接続はまだありません。「Google をつなぎ直して」と送ると、スマホから手続きできます。';
  }

  async command(tenantId: string, userId: string, text: string): Promise<string | null> {
    const asking = /[?？]|なぜ|どうして|ません|ないの/.test(text);
    if (CALENDAR_WRITE_REQUEST.test(text.trim()) && !asking) {
      if (await this.calendarWritable(tenantId))
        return `${CALENDAR_WRITE_LABEL}はもう許可されています。グループで頼まれた会議も入れられます。`;
      return this.#issue(tenantId, userId, 'google', 'calendar_write');
    }
    const asked = RECONNECT_STATUS.exec(text.trim());
    if (asked) return this.#statusReply(tenantId, userId, asked[1]);
    const m = RECONNECT_REQUEST.exec(text.trim());
    // 「なぜつなげないの？」のような問いは頼みではない
    if (!m || asking) return null;
    return this.#issue(tenantId, userId, isMicrosoft(m[1]!) ? 'microsoft' : 'google', 'reconnect');
  }

  /** 予定を作る接続がつながっているか（グループの会議を入れる前に見る）。 */
  async calendarWritable(tenantId: string): Promise<boolean> {
    // 接続の記録の持ち主は plugin-registry。ここでは読まない（§5.1）
    const connections =
      (await this.deps.connectionsOfPlugin?.(tenantId, CALENDAR_WRITE.pluginId)) ?? [];
    return connections.some(
      (c) => c.connectorId === CALENDAR_WRITE.connectorId && c.state === 'CONNECTED',
    );
  }

  /**
   * グループの会議の確認に添える文。予定を作る接続がまだ無ければ、許可の手続きのリンクを作って返す。
   * もうあれば null（何も足さない）。
   */
  async calendarWriteNotice(tenantId: string, userId: string): Promise<string | null> {
    if (await this.calendarWritable(tenantId)) return null;
    const link = await this.#issue(tenantId, userId, 'google', 'calendar_write');
    return [
      'この会議を入れるには、Google カレンダーに予定を入れる許可が要ります（まだもらっていません）。',
      '先に下の手続きを済ませてから、届く確認で「予定を入れる」を押してください。',
      link,
    ].join('\n');
  }

  async #issue(
    tenantId: string,
    userId: string,
    provider: ReconnectProvider,
    purpose: ReconnectPurpose,
  ): Promise<string> {
    const token = randomBytes(24).toString('base64url');
    const url = this.deps.urlFor(token);
    if (!url)
      return purpose === 'calendar_write'
        ? 'この環境では、カレンダーに予定を入れる許可を LINE から取れません（公開の場所がありません）。'
        : 'この環境では LINE からつなぎ直せません。Mac の Apps → Connections から行ってください。';
    const expires = new Date(this.#now().getTime() + RECONNECT_MINUTES * 60_000);
    await withTenant(this.deps.db, tenantId, async (tx) => {
      // 前のリンクは使えなくする（同時に 1 つだけ）
      await tx
        .updateTable('connector_reconnects')
        .set({ state: 'failed', authorize_url: null, token_hash: null, updated_at: this.#now() })
        .where('user_id', '=', userId)
        .where('provider', '=', provider)
        .where('state', 'in', ['requested', 'ready', 'code'])
        .execute();
      await tx
        .insertInto('connector_reconnects')
        .values({
          id: uuidv7(),
          tenant_id: tenantId,
          user_id: userId,
          provider,
          state: 'requested',
          token_hash: hash(token),
          expires_at: expires,
          purpose,
        })
        .execute();
    });
    const what =
      purpose === 'calendar_write'
        ? `${CALENDAR_WRITE_LABEL}の許可の手続き`
        : `${LABEL[provider]}のつなぎ直し`;
    return [
      `${what}です。下のリンクを開いて、手順どおりに進めてください（${String(RECONNECT_MINUTES)} 分使えるあなた専用のリンクです。人に送らないでください）。`,
      url,
    ].join('\n');
  }

  /** Mac アプリが見る。期限の切れたものは出さない。 */
  async pending(tenantId: string, userId: string) {
    const rows = await withTenant(this.deps.db, tenantId, (tx) =>
      tx
        .selectFrom('connector_reconnects')
        .select(['id', 'provider', 'state', 'purpose'])
        .where('user_id', '=', userId)
        .where('state', 'in', ['requested', 'code'])
        .where('expires_at', '>', this.#now())
        .execute(),
    );
    return rows.map((row) => {
      const callback = row.state === 'code' ? this.#callbacks.get(row.id) : undefined;
      return {
        id: row.id,
        provider: row.provider,
        state: row.state,
        // 予定を作る接続の許可。Mac は読む接続ではなく、この接続で許可を取る
        ...(row.purpose === 'calendar_write'
          ? { plugin_id: CALENDAR_WRITE.pluginId, connector_id: CALENDAR_WRITE.connectorId }
          : {}),
        ...(callback
          ? {
              callback_state: callback.state,
              ...(callback.code ? { code: callback.code } : {}),
              ...(callback.error ? { error: callback.error } : {}),
            }
          : {}),
      };
    });
  }

  /** Mac アプリが認可の URL を渡す。 */
  async authorize(tenantId: string, userId: string, id: string, text: string): Promise<boolean> {
    const row = await withTenant(this.deps.db, tenantId, (tx) =>
      tx
        .selectFrom('connector_reconnects')
        .select(['provider', 'state'])
        .where('id', '=', id)
        .where('user_id', '=', userId)
        .executeTakeFirst(),
    );
    if (row?.state !== 'requested') return false;
    if (!authorizeUrlFor(row.provider as ReconnectProvider, text)) return false;
    await withTenant(this.deps.db, tenantId, (tx) =>
      tx
        .updateTable('connector_reconnects')
        .set({ state: 'ready', authorize_url: text, updated_at: this.#now() })
        .where('id', '=', id)
        .execute(),
    );
    return true;
  }

  /** Mac アプリが結果を伝える。認可コードはここで消す。 */
  async finished(
    tenantId: string,
    userId: string,
    id: string,
    ok: boolean,
    account: string | null,
  ): Promise<boolean> {
    this.#callbacks.delete(id);
    const row = await withTenant(this.deps.db, tenantId, (tx) =>
      tx
        .updateTable('connector_reconnects')
        .set({
          state: ok ? 'done' : 'failed',
          authorize_url: null,
          token_hash: null,
          updated_at: this.#now(),
        })
        .where('id', '=', id)
        .where('user_id', '=', userId)
        .where('state', 'in', ['requested', 'ready', 'code'])
        .returning(['provider', 'purpose'])
        .executeTakeFirst(),
    );
    if (!row) return false;
    if (row.purpose === 'calendar_write') {
      await this.deps.notify?.(
        tenantId,
        userId,
        ok
          ? `${CALENDAR_WRITE_LABEL}を許可しました${account ? `（${account}）` : ''}。グループで頼まれた会議を入れられます。`
          : `${CALENDAR_WRITE_LABEL}の許可を取れませんでした。もう一度「カレンダーに予定を入れられるようにして」と送ってください。`,
      );
      return true;
    }
    const label = LABEL[row.provider as ReconnectProvider];
    await this.deps.notify?.(
      tenantId,
      userId,
      ok
        ? `${label}をつなぎ直しました${account ? `（${account}）` : ''}。またメールや予定を読めます。`
        : `${label}をつなぎ直せませんでした。もう一度「つなぎ直して」と送るか、Mac の Apps → Connections から行ってください。`,
    );
    return true;
  }

  /** リンクから引く（ページはサインインしない）。 */
  async #byToken(token: string) {
    if (!TOKEN.test(token)) return null;
    const row = await withIdentity(this.deps.db, (tx) =>
      tx
        .selectFrom('connector_reconnects')
        .select(['id', 'tenant_id', 'user_id', 'provider'])
        .where('token_hash', '=', hash(token))
        .where('expires_at', '>', sql<Date>`now()`)
        .executeTakeFirst(),
    );
    return row ?? null;
  }

  /** ページの見る状態。リンクが無効なら null。 */
  async status(token: string) {
    const row = await this.#byToken(token);
    if (!row) return null;
    const full = await withTenant(this.deps.db, row.tenant_id, (tx) =>
      tx
        .selectFrom('connector_reconnects')
        .select(['state', 'authorize_url', 'created_at', 'purpose'])
        .where('id', '=', row.id)
        .executeTakeFirstOrThrow(),
    );
    return {
      provider: row.provider,
      state: full.state,
      authorize_url: full.state === 'ready' ? full.authorize_url : null,
      label:
        full.purpose === 'calendar_write'
          ? CALENDAR_WRITE_LABEL
          : LABEL[row.provider as ReconnectProvider],
    };
  }

  /** ページから貼られた URL を受ける。 */
  async paste(
    token: string,
    text: string,
  ): Promise<'ok' | 'gone' | 'not_callback' | 'wrong_state'> {
    const row = await this.#byToken(token);
    if (!row) return 'gone';
    const callback = parsePastedCallback(text);
    if (!callback) return 'not_callback';
    const full = await withTenant(this.deps.db, row.tenant_id, (tx) =>
      tx
        .selectFrom('connector_reconnects')
        .select(['state', 'authorize_url'])
        .where('id', '=', row.id)
        .executeTakeFirstOrThrow(),
    );
    if (full.state !== 'ready' || !full.authorize_url) return 'gone';
    // 今回の手続きの戻りだけを受ける（古いタブ・別の人の URL を受けない）
    if (new URL(full.authorize_url).searchParams.get('state') !== callback.state)
      return 'wrong_state';
    this.#callbacks.set(row.id, callback);
    await withTenant(this.deps.db, row.tenant_id, (tx) =>
      tx
        .updateTable('connector_reconnects')
        .set({ state: 'code', updated_at: this.#now() })
        .where('id', '=', row.id)
        .execute(),
    );
    return 'ok';
  }
}

const Rejected = z
  .object({
    plugin_id: z.string().max(120),
    connector_id: z.string().max(120),
    fingerprint: z.string().min(16).max(128),
  })
  .strict();
const Authorize = z.object({ authorize_url: z.string().max(4000) }).strict();
const Finished = z
  .object({ ok: z.boolean(), account: z.string().max(200).nullable().optional() })
  .strict();
const Paste = z.object({ url: z.string().max(4000) }).strict();

const PROVIDER_OF_PLUGIN: Record<string, ReconnectProvider> = {
  'com.astra.gmail': 'google',
  'com.astra.google-calendar': 'google',
  'com.astra.outlook': 'microsoft',
  'com.astra.microsoft-todo': 'microsoft',
};

const pageHeaders = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex',
};

export function registerConnectorReconnectRoutes(app: App, store: ConnectorReconnects): void {
  app.post('/v1/connector-reconnects/rejected', async (request, reply) => {
    const p = requirePrincipal();
    const body = Rejected.parse(request.body);
    const provider = PROVIDER_OF_PLUGIN[body.plugin_id];
    if (!provider) return reply.status(204).send();
    await store.rejected(p.tenantId, p.userId, provider, body.fingerprint);
    return reply.status(204).send();
  });

  app.get('/v1/connector-reconnects/pending', async () => {
    const p = requirePrincipal();
    return { items: await store.pending(p.tenantId, p.userId) };
  });

  app.post<{ Params: { id: string } }>(
    '/v1/connector-reconnects/:id/authorize',
    async (request, reply) => {
      const p = requirePrincipal();
      const { authorize_url } = Authorize.parse(request.body);
      if (!ID.test(request.params.id)) throw new GenieError('common.not_found', 'no such request');
      const ok = await store.authorize(p.tenantId, p.userId, request.params.id, authorize_url);
      if (!ok) throw new GenieError('common.not_found', 'no such request');
      return reply.status(204).send();
    },
  );

  app.post<{ Params: { id: string } }>(
    '/v1/connector-reconnects/:id/finished',
    async (request, reply) => {
      const p = requirePrincipal();
      const body = Finished.parse(request.body);
      if (!ID.test(request.params.id)) throw new GenieError('common.not_found', 'no such request');
      await store.finished(p.tenantId, p.userId, request.params.id, body.ok, body.account ?? null);
      return reply.status(204).send();
    },
  );

  const config = {
    auth: false,
    rateLimit: { limit: 60, windowMs: 60_000, by: 'ip', bucket: 'channel-reconnect' },
  } as const;

  app.get<{ Params: { token: string } }>(
    '/v1/channels/reconnect/:token',
    { config },
    async (request, reply) => {
      const found = await store.status(request.params.token);
      return reply
        .status(found ? 200 : 410)
        .headers({ ...pageHeaders, 'content-type': 'text/html; charset=utf-8' })
        .send(reconnectPage());
    },
  );

  app.get<{ Params: { token: string } }>(
    '/v1/channels/reconnect/:token/status',
    { config },
    async (request, reply) => {
      const found = await store.status(request.params.token);
      return reply
        .status(found ? 200 : 410)
        .headers(pageHeaders)
        .send(found ?? { state: 'gone' });
    },
  );

  app.post<{ Params: { token: string } }>(
    '/v1/channels/reconnect/:token/callback',
    { config },
    async (request, reply) => {
      const parsed = Paste.safeParse(request.body);
      const result = parsed.success
        ? await store.paste(request.params.token, parsed.data.url)
        : 'not_callback';
      return reply
        .status(result === 'ok' ? 200 : result === 'gone' ? 410 : 422)
        .headers(pageHeaders)
        .send({ result });
    },
  );
}

/** 本人のページ。外部のスクリプト・フォントは読まない。中身は textContent で入れる。 */
function reconnectPage(): string {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Genie · つなぎ直し</title>
<style>
:root { --bg:#F6F7F9; --card:#FFFFFF; --text:#14171F; --muted:#677084; --line:#E3E6EC; --accent:#0A7D5A; --warn:#9A5B00; }
@media (prefers-color-scheme: dark) { :root { --bg:#0F1218; --card:#181C24; --text:#F2F4F8; --muted:#9AA3B5; --line:#2A303C; --accent:#4CC79A; --warn:#F2B35E; } }
* { box-sizing:border-box; } [hidden] { display:none !important; }
body { margin:0; background:var(--bg); color:var(--text); font:16px/1.6 -apple-system, "Hiragino Sans", system-ui, sans-serif; }
main { max-width:520px; margin:0 auto; padding:calc(16px + env(safe-area-inset-top)) 16px 32px; }
h1 { font-size:20px; margin:0 0 12px; } .muted { color:var(--muted); font-size:14px; } .warn { color:var(--warn); font-size:14px; }
section { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:14px; margin-top:12px; }
a.go, button { display:block; width:100%; text-align:center; font:inherit; font-weight:700; border-radius:10px; border:0; padding:12px; margin-top:10px; background:var(--accent); color:#fff; text-decoration:none; }
textarea { width:100%; font-size:16px; min-height:96px; border-radius:10px; border:1px solid var(--line); background:var(--bg); color:var(--text); padding:10px; margin-top:8px; }
</style></head><body><main>
<h1 id="title">つなぎ直し</h1>
<p id="wait" class="muted">Mac の Genie の準備を待っています…</p>
<div id="steps" hidden>
<section><strong>1. 許可する</strong><p class="muted">開いたページで、いつものアカウントを選んで許可してください。</p><a id="go" class="go" target="_blank" rel="noopener">許可のページを開く</a></section>
<section><strong>2. 開けなかったページの URL を貼る</strong><p class="muted">許可すると「ページを開けません」と出ます。それで正しいです。そのページのアドレス（http://127.0.0.1 で始まるもの）をコピーして、ここへ戻って貼ってください。</p><textarea id="url" autocapitalize="off" autocomplete="off" spellcheck="false" placeholder="http://127.0.0.1…"></textarea><button id="send">送る</button><p id="error" class="warn" hidden></p></section>
</div>
<p id="done" hidden></p>
</main><script>
const base = location.pathname.replace(/\\/$/, '');
const $ = (id) => document.getElementById(id);
let waited = 0;
const show = (text) => { $('wait').hidden = true; $('steps').hidden = true; $('done').hidden = false; $('done').textContent = text; };
async function tick() {
  let s;
  try { s = await (await fetch(base + '/status', { cache: 'no-store' })).json(); } catch { return schedule(); }
  if (s.label) $('title').textContent = s.label + 'のつなぎ直し';
  if (s.state === 'gone') return show('このリンクは使えません。LINE でもう一度「つなぎ直して」と送ってください。');
  if (s.state === 'done') return show('つなぎ直しました。LINE に戻ってください。');
  if (s.state === 'failed') return show('つなぎ直せませんでした。LINE の案内をご覧ください。');
  if (s.state === 'code') { $('steps').hidden = true; $('wait').hidden = false; $('wait').textContent = 'Mac の Genie が保存しています…'; return schedule(); }
  if (s.state === 'ready' && s.authorize_url) { $('wait').hidden = true; $('steps').hidden = false; $('go').href = s.authorize_url; return schedule(); }
  waited += 1;
  if (waited > 16) $('wait').textContent = 'Mac の Genie から返事がありません。Mac が起きていて Genie が動いているか確かめてください。';
  schedule();
}
function schedule() { setTimeout(tick, 5000); }
$('send').addEventListener('click', async () => {
  $('error').hidden = true;
  const r = await fetch(base + '/callback', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: $('url').value }) }).then((x) => x.json()).catch(() => ({ result: 'network' }));
  if (r.result === 'ok') { $('url').value = ''; return tick(); }
  $('error').hidden = false;
  $('error').textContent = r.result === 'wrong_state' ? '今回の手続きの URL ではありません。上のボタンから開き直してください。' : r.result === 'gone' ? 'このリンクは使えません。LINE で頼み直してください。' : 'http://127.0.0.1 で始まる URL をそのまま貼ってください。';
});
tick();
</script></body></html>`;
}

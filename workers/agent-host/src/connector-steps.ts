/**
 * 端末で connector の step を走らせる。正本 §2.4・§4.4・§21。
 *
 * **ここが、トークンが存在する唯一の場所。**
 * cloud から来るのは「何をしてほしいか」だけで、鍵は端末の資格情報ストアにある。
 *
 * 承認は cloud で取ってあるが、**ここでもう一度確かめる。**
 * 経路が 1 本しかないと、いつか誰かが近道を作り、それが既定になる。
 */
import { createHash } from 'node:crypto';
import {
  ApprovalRequired,
  ConnectorError,
  CONNECTOR_RECOVERY,
  GmailConnector,
  GoogleCalendarConnector,
  MicrosoftTodoConnector,
  OutlookCalendarConnector,
  OutlookMailConnector,
  type ApprovalProof,
  type CreateEventInput,
  type DraftMessage,
} from '@genie/service-connectors';
import {
  needsRefresh,
  refresh,
  TokenStore,
  type ProviderConfig,
  type SecretStore,
  type TokenSet,
} from '@genie/oauth';

/** cloud から渡ってくる、端末にやってほしいこと。 */
export interface HostStep {
  readonly id: string;
  readonly toolId: string;
  readonly args: Record<string, unknown>;
  readonly approval: ApprovalProof | null;
}

export interface StepOutcome {
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: { code: string; message: string };
}

export interface ConnectorRuntimeDeps {
  readonly secrets: SecretStore;
  /** どの connector にどの参照が結びついているか。 */
  readonly credentialRefFor: (pluginId: string, connectorId: string) => string;
  /** 実際に許された scope。**要求した scope ではない。** */
  readonly grantedScopes: (pluginId: string) => readonly string[];
  /** トークンを更新するための設定。無ければ更新しない（切れたら繋ぎ直しを促す）。 */
  readonly refreshConfig?: (
    provider: string,
    connectorId: string,
    scopes: readonly string[],
  ) => ProviderConfig | null;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => Date;
  /** 提供者が更新を断ったことを Mac アプリへ知らせる（値は渡さない。指紋だけ）。 */
  readonly reportRenewalRejected?: (
    pluginId: string,
    connectorId: string,
    fingerprint: string,
  ) => Promise<void>;
}

/**
 * この端末が扱う接続。**tool → 接続の表。**
 *
 * 同意は capability 単位（manifest の `connectors[].grants`）。Gmail は「読む」接続と
 * 「下書き・送信・整理」接続に分かれ、**読む tool は読む接続のトークンしか触らない。**
 * Work Context の同期が使うのも読む接続だけ。送る接続が無ければ、送る tool は
 * 「何のために繋ぐか」を添えて `not_connected` を返す（purpose-first、JIT）。
 */
export const CONNECTORS = {
  gmail: {
    pluginId: 'com.astra.gmail',
    connectorId: 'gmail',
    provider: 'google',
    label: 'Gmail（読むだけ）',
    purpose: 'メールを読む',
  },
  'gmail-actions': {
    pluginId: 'com.astra.gmail',
    connectorId: 'gmail-actions',
    provider: 'google',
    label: 'Gmail（下書き・送信・整理）',
    purpose: '返事を下書きし、承認したメールを送り、受信箱を整理する',
  },
  'google-calendar': {
    pluginId: 'com.astra.google-calendar',
    connectorId: 'google-calendar',
    provider: 'google',
    label: 'Google Calendar（読むだけ）',
    purpose: '予定を読む',
  },
  'google-calendar-actions': {
    pluginId: 'com.astra.google-calendar',
    connectorId: 'google-calendar-actions',
    provider: 'google',
    label: 'Google Calendar（予定を作る）',
    purpose: '承認した予定を作る',
  },
  outlook: {
    pluginId: 'com.astra.outlook',
    connectorId: 'outlook',
    provider: 'microsoft',
    label: 'Outlook（読むだけ）',
    purpose: 'メールと予定を読む',
  },
  'outlook-actions': {
    pluginId: 'com.astra.outlook',
    connectorId: 'outlook-actions',
    provider: 'microsoft',
    label: 'Outlook（返信を送る）',
    purpose: '確認した返信を Outlook から送信する',
  },
  'microsoft-todo': {
    pluginId: 'com.astra.microsoft-todo',
    connectorId: 'microsoft-todo',
    provider: 'microsoft',
    label: 'Microsoft To Do（読むだけ）',
    purpose: 'タスクを読む',
  },
} as const;
export type ConnectorKey = keyof typeof CONNECTORS;

/** どの tool がどの接続のトークンで動くか。**読む tool を送る接続に結ばない。** */
export const TOOL_CONNECTOR: Readonly<Record<string, ConnectorKey>> = {
  'mail.search': 'gmail',
  'mail.read': 'gmail',
  'mail.draft.create': 'gmail-actions',
  'mail.send': 'gmail-actions',
  'mail.trash': 'gmail-actions',
  'calendar.list_events': 'google-calendar',
  'calendar.get_event': 'google-calendar',
  'calendar.create_event': 'google-calendar-actions',
  // 予定の時間を変える（承認つき。「元に戻して」も同じ道）
  'calendar.move_event': 'google-calendar-actions',
  'outlook.mail.search': 'outlook',
  'outlook.mail.read': 'outlook',
  'outlook.calendar.list_events': 'outlook',
  'outlook.mail.reply': 'outlook-actions',
  'todo.list_tasks': 'microsoft-todo',
};

export function connectorForTool(toolId: string): ConnectorKey | null {
  return TOOL_CONNECTOR[toolId] ?? null;
}

/** 更新した分を置く別項目の名前の末尾。アプリが作った項目とは分ける。 */
export const HOST_RENEWAL_SUFFIX = '.host-renewal';

/** 別項目の中身。どのアプリ側の接続から更新したか（`origin`）を持つ。 */
type HostRenewal = TokenSet & { readonly origin: string };

/**
 * 接続の指紋（更新用トークンのハッシュの先頭）。値そのものは出さない。
 * Mac アプリも同じ計算で、「断られた」がいまの接続のことかを見分ける。
 */
export function credentialFingerprint(tokens: Pick<TokenSet, 'refreshToken' | 'accessToken'>) {
  return createHash('sha256')
    .update(tokens.refreshToken ?? tokens.accessToken)
    .digest('hex')
    .slice(0, 32);
}

export class ConnectorRuntime {
  readonly #deps: ConnectorRuntimeDeps;
  readonly #tokens: TokenStore;
  /**
   * 接続ごとに、進行中の更新は 1 つだけ。同時に呼ばれた側はその結果を待つ。
   * 2 つが同時に更新・保存すると、同じキーチェーン項目への書き込みが競合して片方が
   * 「既に存在します」で落ち、同期全体が失敗になっていた（2026-10-07〜12、毎時）。
   */
  readonly #refreshing = new Map<string, Promise<string>>();

  constructor(deps: ConnectorRuntimeDeps) {
    this.#deps = deps;
    this.#tokens = new TokenStore(deps.secrets);
  }

  /** この端末はこの step を扱えるか。**扱えないものを引き受けない。** */
  handles(toolId: string): boolean {
    return connectorForTool(toolId) !== null;
  }

  /**
   * この接続のトークンが端末にあるか。**値は返さない。**
   * Work Context の同期が、繋いでいないサービスを黙って飛ばすために見る。
   */
  async connected(key: ConnectorKey): Promise<boolean> {
    const { pluginId, connectorId } = CONNECTORS[key];
    const tokens = await this.#tokens.load(this.#deps.credentialRefFor(pluginId, connectorId));
    return tokens !== null;
  }

  /** この接続の plugin に実際に許された Genie の許可。 */
  granted(key: ConnectorKey): readonly string[] {
    return this.#deps.grantedScopes(CONNECTORS[key].pluginId);
  }

  /**
   * 走らせる。
   *
   * **失敗を成功として返さない。**理由は種類ごとに分け、
   * 「何をすれば直るか」まで載せる（§21）。
   */
  async run(step: HostStep, signal?: AbortSignal): Promise<StepOutcome> {
    try {
      return { ok: true, result: await this.#dispatch(step, signal) };
    } catch (error) {
      if (error instanceof ApprovalRequired) {
        return {
          ok: false,
          error: {
            code: 'connector.approval_required',
            message: 'この操作には確認が必要です。',
          },
        };
      }
      if (error instanceof ConnectorError) {
        const key = connectorForTool(step.toolId);
        const message =
          error.reason === 'not_connected' && key
            ? // どの接続が、何のために要るかを言う（purpose-first）。送る接続は JIT で求める。
              `${CONNECTORS[key].purpose}には「${CONNECTORS[key].label}」の接続が要ります。`
            : // tool 側の文言をそのまま出さない（§7.2）。何をすれば直るかを言う。
              CONNECTOR_RECOVERY[error.reason];
        return {
          ok: false,
          error: { code: `connector.${error.reason}`, message },
        };
      }
      return {
        ok: false,
        error: {
          code: 'connector.failed',
          message: '端末でこの操作を完了できませんでした。',
        },
      };
    }
  }

  async #dispatch(step: HostStep, signal?: AbortSignal): Promise<unknown> {
    const { args } = step;

    switch (step.toolId) {
      case 'mail.search':
        return this.gmail().list(
          {
            ...(typeof args['query'] === 'string' ? { query: args['query'] } : {}),
            ...(typeof args['max_results'] === 'number' ? { maxResults: args['max_results'] } : {}),
          },
          signal,
        );
      case 'mail.read':
        return this.gmail().get(requireString(args, 'message_id'), signal);
      case 'mail.draft.create':
        return this.gmailActions().draft(draftFrom(args), signal);
      case 'mail.send':
        if (typeof args['in_reply_to'] === 'string' && args['in_reply_to']) {
          return this.gmailActions().reply(
            args['in_reply_to'],
            draftFrom(args),
            step.approval ?? undefined,
            typeof args['thread_id'] === 'string' ? args['thread_id'] : undefined,
            signal,
          );
        }
        return this.gmailActions().send(draftFrom(args), step.approval ?? undefined, signal);
      case 'mail.trash':
        return this.gmailActions().trash(
          requireString(args, 'message_id'),
          step.approval ?? undefined,
          signal,
        );
      case 'calendar.list_events':
        return this.googleCalendar().list(
          {
            timeMin: requireString(args, 'time_min'),
            timeMax: requireString(args, 'time_max'),
            ...(typeof args['query'] === 'string' ? { query: args['query'] } : {}),
          },
          signal,
        );
      case 'calendar.get_event':
        return this.googleCalendar().get({ eventId: requireString(args, 'event_id') }, signal);
      case 'calendar.create_event':
        return this.googleCalendarActions().create(
          eventFrom(args),
          step.approval ?? undefined,
          signal,
        );
      case 'calendar.move_event': {
        const timeZone = typeof args['time_zone'] === 'string' ? args['time_zone'] : undefined;
        // 日付だけなら終日、それ以外は日時（eventFrom の when と同じ読み方）
        const at = (value: string) =>
          /^\d{4}-\d{2}-\d{2}$/.test(value)
            ? { date: value }
            : { dateTime: value, ...(timeZone ? { timeZone } : {}) };
        return this.googleCalendarActions().move(
          {
            eventId: requireString(args, 'event_id'),
            start: at(requireString(args, 'start')),
            end: at(requireString(args, 'end')),
          },
          step.approval ?? undefined,
          signal,
        );
      }
      case 'outlook.mail.search':
        return this.outlookMail().list(
          {
            ...(typeof args['query'] === 'string' ? { query: args['query'] } : {}),
            ...(typeof args['max_results'] === 'number' ? { maxResults: args['max_results'] } : {}),
            ...(args['folder'] === 'sentitems' ? { folder: 'sentitems' as const } : {}),
            ...(typeof args['since'] === 'string' ? { since: args['since'] } : {}),
          },
          signal,
        );
      case 'outlook.mail.read':
        return this.outlookMail().get(requireString(args, 'message_id'), signal);
      case 'outlook.calendar.list_events':
        return this.outlookCalendar().list(
          { timeMin: requireString(args, 'time_min'), timeMax: requireString(args, 'time_max') },
          signal,
        );
      case 'outlook.mail.reply':
        return this.outlookMailActions().reply(
          requireString(args, 'message_id'),
          requireString(args, 'comment'),
          step.approval ?? undefined,
          signal,
        );
      case 'todo.list_tasks':
        return this.todo().list(
          { ...(args['include_completed'] === true ? { includeCompleted: true } : {}) },
          signal,
        );
      default:
        // 知らない step を、何もせず成功にしない
        throw new ConnectorError('not_found', `this device does not handle ${step.toolId}`);
    }
  }

  /** 読む接続。Work Context の同期はこれだけを使う。 */
  gmail(): GmailConnector {
    return new GmailConnector(this.#googleDeps('gmail'));
  }

  /** 下書き・送信・整理の接続。無ければ `not_connected`（送る前に理由を見せて求める）。 */
  gmailActions(): GmailConnector {
    return new GmailConnector(this.#googleDeps('gmail-actions'));
  }

  googleCalendar(): GoogleCalendarConnector {
    return new GoogleCalendarConnector(this.#googleDeps('google-calendar'));
  }

  googleCalendarActions(): GoogleCalendarConnector {
    return new GoogleCalendarConnector(this.#googleDeps('google-calendar-actions'));
  }

  outlookMail(): OutlookMailConnector {
    return new OutlookMailConnector(this.#microsoftDeps('outlook'));
  }

  /** 送る接続。無ければ `not_connected`（送る前に理由を見せて求める）。 */
  outlookMailActions(): OutlookMailConnector {
    return new OutlookMailConnector(this.#microsoftDeps('outlook-actions'));
  }

  outlookCalendar(): OutlookCalendarConnector {
    return new OutlookCalendarConnector(this.#microsoftDeps('outlook'));
  }

  todo(): MicrosoftTodoConnector {
    return new MicrosoftTodoConnector(this.#microsoftDeps('microsoft-todo'));
  }

  #googleDeps(key: ConnectorKey): ConstructorParameters<typeof GmailConnector>[0] {
    const { pluginId, connectorId } = CONNECTORS[key];
    return {
      token: () => this.#accessToken(pluginId, connectorId, 'google'),
      /*
       * scope の検査は接続ごとの grants ではなく plugin の許可で見る。
       * 読む接続に送る scope が付くことは無い（トークンが別）ので、ここは足りているかの検査だけ。
       */
      grantedScopes: this.#deps.grantedScopes(pluginId),
      ...(this.#deps.fetch ? { fetch: this.#deps.fetch } : {}),
      ...(this.#deps.now ? { now: this.#deps.now } : {}),
    };
  }

  #microsoftDeps(key: ConnectorKey): ConstructorParameters<typeof OutlookMailConnector>[0] {
    const { pluginId, connectorId } = CONNECTORS[key];
    return {
      token: () => this.#accessToken(pluginId, connectorId, 'microsoft'),
      grantedScopes: this.#deps.grantedScopes(pluginId),
      ...(this.#deps.fetch ? { fetch: this.#deps.fetch } : {}),
      ...(this.#deps.now ? { now: this.#deps.now } : {}),
    };
  }

  /**
   * 呼ぶ直前にだけ取り出す。**手元に貯めない。**
   *
   * 期限が近ければ更新して置き直す。更新できないときは
   * 「繋ぎ直してください」と言う — 期限切れのまま呼んで
   * 意味の分からない 401 を見せない。
   */
  async #accessToken(pluginId: string, connectorId: string, provider: string): Promise<string> {
    const ref = this.#deps.credentialRefFor(pluginId, connectorId);
    const native = await this.#tokens.load(ref);
    if (!native) throw new ConnectorError('not_connected', `${pluginId} is not connected`);
    /*
     * 更新した分は**別の項目**に置き、Mac アプリが作った項目は書き換えない。
     * `security` で書き戻すと項目の partition が `apple-tool:` だけになり、アプリが自分の接続を
     * 読めなくなって「つなぎ直す」も保存できなかった（2026-10-16〜19）。
     * 別項目は、アプリの項目が同じ更新用トークンのままのときだけ使う（つなぎ直したらアプリの項目が勝つ）。
     */
    const origin = credentialFingerprint(native);
    const hostRef = `${ref}${HOST_RENEWAL_SUFFIX}`;
    const renewed = (await this.#tokens.load(hostRef)) as HostRenewal | null;
    const tokens = renewed?.origin === origin ? renewed : native;

    const config = this.#deps.refreshConfig?.(provider, connectorId, tokens.grantedScopes ?? []);
    if (
      provider === 'microsoft' &&
      this.#deps.refreshConfig &&
      (!config || tokens.clientId !== config.clientId)
    ) {
      throw new ConnectorError('not_connected', `${pluginId} needs its dedicated connection again`);
    }

    const now = (this.#deps.now ?? (() => new Date()))().getTime();
    const expired = tokens.expiresAt !== null && Date.parse(tokens.expiresAt) <= now;
    if (!expired && !needsRefresh(tokens, now)) return tokens.accessToken;
    // 一度断られた更新用トークンで、提供者を呼び直さない。
    if (tokens.renewalRejectedAt)
      throw new ConnectorError('token_expired', `${pluginId} needs to be connected again`);

    if (!config || !tokens.refreshToken) {
      /*
       * 更新できない。**切れたトークンで呼びに行かない。**
       * 呼べば 401 が返るだけで、利用者には提供者側の失敗に見える。
       * 「繋ぎ直してください」と言えるのはここだけ。
       */
      if (expired) {
        throw new ConnectorError('token_expired', `${pluginId} needs to be connected again`);
      }
      // まだ切れてはいない。更新できないだけなので、今回はそのまま使う。
      return tokens.accessToken;
    }
    const inflight = this.#refreshing.get(ref);
    if (inflight) return inflight;
    const refreshToken = tokens.refreshToken;
    const task = (async () => {
      const next = await refresh(
        config,
        refreshToken,
        this.#deps.fetch ?? globalThis.fetch,
        () => now,
      ).catch(async (error: unknown) => {
        /*
         * 更新用のトークンが失効・取り消し済み（`invalid_grant`）。待っても直らないので
         * 「つなぎ直してください」と言う。Google の「テスト中」のアプリでは 7 日で失効する
         * （2026-10-16 に切れ、まとめは「一部を取得できませんでした」とだけ出し続け、
         * Apps は「接続済み」のままだった）。断られたことを残し、Mac の Apps にも知らせる。
         */
        if ((error as { code?: unknown } | null)?.code === 'invalid_grant') {
          // その間につなぎ直されていたら、新しい接続に印を付けない。
          const current = await this.#tokens.load(ref);
          if (current && credentialFingerprint(current) === origin) {
            await this.#tokens.save(pluginId, `${connectorId}${HOST_RENEWAL_SUFFIX}`, {
              ...tokens,
              origin,
              renewalRejectedAt: new Date(now).toISOString(),
            } as HostRenewal);
            await this.#deps.reportRenewalRejected?.(pluginId, connectorId, origin);
          }
          throw new ConnectorError('token_expired', `${pluginId} needs to be connected again`);
        }
        throw error;
      });
      if (
        provider === 'microsoft' &&
        this.#deps.refreshConfig &&
        !this.#deps.refreshConfig(provider, connectorId, next.grantedScopes)
      ) {
        throw new ConnectorError(
          'provider_error',
          'Microsoft returned scopes outside this connection',
        );
      }
      await this.#tokens.save(pluginId, `${connectorId}${HOST_RENEWAL_SUFFIX}`, {
        ...next,
        // Refresh responses do not carry the native UI's account label. Keep only
        // that local metadata; tokens, scopes and client binding come from renewal.
        ...(typeof tokens.accountLabel === 'string' ? { accountLabel: tokens.accountLabel } : {}),
        origin,
      } as HostRenewal);
      return next.accessToken;
    })().finally(() => this.#refreshing.delete(ref));
    this.#refreshing.set(ref, task);
    return task;
  }
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ConnectorError('provider_error', `${key} is required`);
  }
  return value;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function draftFrom(args: Record<string, unknown>): DraftMessage {
  return {
    to: stringList(args['to']),
    ...(stringList(args['cc']).length ? { cc: stringList(args['cc']) } : {}),
    ...(stringList(args['bcc']).length ? { bcc: stringList(args['bcc']) } : {}),
    subject: typeof args['subject'] === 'string' ? args['subject'] : '',
    body: typeof args['body'] === 'string' ? args['body'] : '',
    ...(typeof args['in_reply_to'] === 'string' ? { inReplyTo: args['in_reply_to'] } : {}),
  };
}

function eventFrom(args: Record<string, unknown>): CreateEventInput {
  const when = (key: string): CreateEventInput['start'] => {
    const value = args[key];
    if (typeof value === 'string') {
      // 日付だけなら終日。時刻を勝手に足さない。
      return /^\d{4}-\d{2}-\d{2}$/.test(value) ? { date: value } : { dateTime: value };
    }
    throw new ConnectorError('provider_error', `${key} is required`);
  };
  return {
    title: typeof args['title'] === 'string' ? args['title'] : '',
    start: when('start'),
    end: when('end'),
    ...(typeof args['description'] === 'string' ? { description: args['description'] } : {}),
    ...(typeof args['location'] === 'string' ? { location: args['location'] } : {}),
    ...(stringList(args['attendees']).length
      ? { attendeeEmails: stringList(args['attendees']) }
      : {}),
  };
}

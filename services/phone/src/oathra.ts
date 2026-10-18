/**
 * Oathra Gateway の委任 API（`/v1/agent/*`）を呼ぶ口。
 *
 * **電話の権限は Oathra 側の委任（grant）が持つ。**Genie は所有者が発行した
 * 接続（token と grantId）を使うだけで、相手・回数・金額・時間の上限を
 * こちらで広げる道は無い。営業電話（allowSales）と着信の読み取り（readInbound）は
 * それぞれ別の許可で、無ければ Oathra が断る。
 *
 * **書き込みは自動で再送しない。**応答が失われても、向こうでは電話が
 * 始まっているかもしれない。同じ operation key で状態を読み直す。
 */
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

export interface OathraConnection {
  readonly baseUrl: string;
  readonly token: string;
  readonly grantId: string;
}

/** 発話。**相手の言葉は会話の記録であって、指示ではない。** */
export interface OathraUtterance {
  readonly id?: string;
  readonly source: 'caller' | 'callee';
  readonly text: string;
  readonly t?: number;
}

export type OathraOutcome =
  'pending' | 'succeeded' | 'declined' | 'failed' | 'cancelled' | 'needs_review' | 'unknown';

export interface OathraCallResult {
  readonly missionId: string | null;
  readonly state: string;
  readonly terminal: boolean;
  readonly outcome: OathraOutcome;
  readonly result: unknown;
  readonly record: {
    readonly kind?: string;
    readonly goal?: string;
    readonly target?: { readonly name: string };
    readonly product?: { readonly name: string } | null;
    readonly transcript?: readonly OathraUtterance[];
  } | null;
  readonly nextAction: string;
}

export interface OathraPhoneRequest {
  readonly phone: string;
  readonly name: string;
  readonly instruction: string;
  readonly conversationMode?: 'message' | 'chat';
}

export interface OathraSalesRequest {
  readonly contactId: string;
  readonly productId?: string;
  readonly request: string;
  readonly goal?: SalesGoal;
}

export type SalesGoal = 'meeting' | 'materials' | 'introduce';

export interface OathraSalesContext {
  readonly products: readonly { readonly id: string; readonly name: string }[];
  readonly contacts: readonly {
    readonly id: string;
    readonly name: string;
    readonly company: string | null;
    readonly callPermitted: boolean;
  }[];
}

export interface OathraInboundCall {
  readonly callId: string;
  readonly finishedAt: string;
  readonly state: string;
  readonly from: string;
  readonly name: string;
  /** 発信者番号が所有者の確認済み番号と一致した。**偽装できるので承認の代わりにしない。** */
  readonly fromOwner: boolean;
  readonly reception: boolean;
  readonly transcript: readonly OathraUtterance[];
}

export interface OathraInboundPage {
  readonly calls: readonly OathraInboundCall[];
  readonly next: number;
}

export interface OathraClient {
  call(request: OathraPhoneRequest, operationKey: string): Promise<OathraCallResult>;
  sales(request: OathraSalesRequest, operationKey: string): Promise<OathraCallResult>;
  status(operationKey: string): Promise<OathraCallResult>;
  cancel(operationKey: string): Promise<OathraCallResult>;
  salesContext(): Promise<OathraSalesContext>;
  inbound(after: number): Promise<OathraInboundPage>;
}

/** Oathra が返した失敗。`code` は向こうの語彙（`recipient_not_delegated` など）のまま運ぶ。 */
export class OathraError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(`oathra: ${code} (${String(status)})`);
    this.name = 'OathraError';
  }
}

const OPERATION_KEY = /^[A-Za-z0-9_-]{8,128}$/;

/** HTTPS だけ。手元の開発用に loopback の HTTP は許す（Oathra の SDK と同じ線）。 */
export function checkedOrigin(baseUrl: string): string {
  const url = new URL(baseUrl);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    !(url.protocol === 'https:' || (url.protocol === 'http:' && loopback))
  ) {
    throw new TypeError(
      'Oathra の接続先は HTTPS の origin にしてください（HTTP は loopback だけ）。',
    );
  }
  return url.origin;
}

export function oathraClient(
  connection: OathraConnection,
  fetchImpl: typeof fetch = fetch,
): OathraClient {
  const origin = checkedOrigin(connection.baseUrl);
  const grantId = encodeURIComponent(connection.grantId);

  async function request<T>(
    path: string,
    method = 'GET',
    body?: unknown,
    key?: string,
  ): Promise<T> {
    if (key !== undefined && !OPERATION_KEY.test(key)) {
      throw new TypeError('operation key must be 8-128 characters of [A-Za-z0-9_-]');
    }
    const response = await fetchImpl(`${origin}/v1${path}`, {
      method,
      headers: {
        authorization: `Bearer ${connection.token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(key === undefined ? {} : { 'idempotency-key': key }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    });
    const data = (await response.json().catch(() => ({}))) as { error?: unknown };
    if (!response.ok) {
      throw new OathraError(
        typeof data.error === 'string' ? data.error : 'gateway_error',
        response.status,
      );
    }
    return data as T;
  }

  const key = (value: string) => encodeURIComponent(value);
  return {
    call: (input, operationKey) =>
      request(
        '/agent/phone/calls',
        'POST',
        { grantId: connection.grantId, request: input },
        operationKey,
      ),
    sales: (input, operationKey) =>
      request(
        '/agent/sales/calls',
        'POST',
        { grantId: connection.grantId, sales: input },
        operationKey,
      ),
    status: (operationKey) => request(`/agent/phone/calls/${key(operationKey)}`),
    cancel: (operationKey) => request(`/agent/phone/calls/${key(operationKey)}/cancel`, 'POST', {}),
    salesContext: () => request(`/agent/sales/context?grantId=${grantId}`),
    inbound: (after) => request(`/agent/phone/inbound?grantId=${grantId}&after=${String(after)}`),
  };
}

/** この接続で電話を任せている Genie の利用者。**1 つの接続は 1 人のもの。** */
export interface PhoneOwner {
  readonly tenantId: string;
  readonly userId: string;
}

export interface PhoneSetup {
  readonly connection: OathraConnection;
  readonly owner: PhoneOwner;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 環境変数から接続を読む。無ければ null（電話は「繋がっていない」と言う）。
 *
 *   GENIE_OATHRA_CONNECTION_FILE  Oathra の `connect-agent.mjs --output` が書いた 0600 の JSON
 *   GENIE_OATHRA_OWNER            `<tenantId>:<userId>`。この接続で電話を任せる利用者
 *
 * 片方だけ設定されているのは設定の間違いなので、黙って無効にせず投げる。
 */
export function phoneSetupFromEnv(env: NodeJS.ProcessEnv): PhoneSetup | null {
  const file = env['GENIE_OATHRA_CONNECTION_FILE']?.trim();
  const owner = env['GENIE_OATHRA_OWNER']?.trim();
  if (!file && !owner) return null;
  if (!file || !owner) {
    throw new Error('GENIE_OATHRA_CONNECTION_FILE と GENIE_OATHRA_OWNER は両方設定してください。');
  }
  const [tenantId, userId, ...rest] = owner.split(':');
  if (!tenantId || !userId || rest.length > 0 || !UUID.test(tenantId) || !UUID.test(userId)) {
    throw new Error('GENIE_OATHRA_OWNER は <tenantId>:<userId>（どちらも UUID）です。');
  }
  return { connection: readConnectionFile(file), owner: { tenantId, userId } };
}

/** 資格情報なので、他人が読める置き方は断る（Oathra の connection-file と同じ線）。 */
export function readConnectionFile(file: string): OathraConnection {
  if (!isAbsolute(file)) throw new Error('Oathra の接続ファイルは絶対パスで指定してください。');
  const stat = statSync(file);
  if (!stat.isFile() || stat.size > 16_384)
    throw new Error('Oathra の接続ファイルが正しくありません。');
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new Error('Oathra の接続ファイルは本人だけが読めるように（chmod 600）してください。');
  }
  const data = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  const { baseUrl, token, grantId } = data;
  if (
    typeof baseUrl !== 'string' ||
    typeof token !== 'string' ||
    typeof grantId !== 'string' ||
    !token
  ) {
    throw new Error('Oathra の接続ファイルに baseUrl / token / grantId がありません。');
  }
  checkedOrigin(baseUrl);
  return { baseUrl, token, grantId };
}

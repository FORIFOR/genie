/**
 * Gmail。正本 §2.4・§15、UI/UX §22。
 *
 * 許可を割る。ひとつの `mail` 権限にすると、
 * 「メールを読ませたい」だけの人が、送信まで許すことになる。
 *
 *   読む     `email.read`   … 承認なし
 *   下書き   `email.draft`  … 承認なし。**送られない**ので取り返しがつく
 *   捨てる   `email.modify` … 人の承認が要る
 *   送る     `email.send`   … 人の承認が要る
 */
import { callJson, ConnectorError, type CallConfig } from './http.js';
import {
  requireApproval,
  requireScope,
  type ApprovalProof,
  type OperationDecl,
} from './approval.js';
import {
  buildMime,
  encodeHeaderValue,
  fromBase64Url,
  extractBody,
  listAttachments,
  toBase64Url,
  type DraftMessage,
} from './mime.js';

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

function draftSubject(value: string): string {
  const encoded = /^=\?UTF-8\?B\?([A-Za-z0-9+/]*={0,2})\?=$/i.exec(value);
  if (!encoded) return value;
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(fromBase64Url(encoded[1]!));
    return encodeHeaderValue(decoded).toLowerCase() === value.toLowerCase() ? decoded : value;
  } catch {
    return value;
  }
}

export const GMAIL_OPERATIONS = {
  list: { id: 'gmail.list', scope: 'email.read', risk: 'READ', requiresApproval: false },
  get: { id: 'gmail.get', scope: 'email.read', risk: 'READ', requiresApproval: false },
  draft: {
    id: 'gmail.draft',
    scope: 'email.draft',
    // 下書きは自分の受信箱に置かれるだけ。消せる。
    risk: 'REVERSIBLE_WRITE',
    requiresApproval: false,
  },
  send: {
    id: 'gmail.send',
    scope: 'email.send',
    risk: 'EXTERNAL_COMMIT',
    requiresApproval: true,
  },
  trash: {
    id: 'gmail.trash',
    // 下書きの許可では捨てられない。受信箱を動かすのは別の許可。
    scope: 'email.modify',
    risk: 'DESTRUCTIVE',
    requiresApproval: true,
  },
} as const satisfies Record<string, OperationDecl>;

export interface MailSummary {
  readonly id: string;
  readonly threadId: string;
  readonly from: string;
  readonly to: readonly string[];
  readonly subject: string;
  readonly snippet: string;
  readonly receivedAt: string | null;
  readonly unread: boolean;
  readonly hasAttachments: boolean;
}

export interface MailMessage extends MailSummary {
  readonly body: string;
  readonly bodyIsHtml: boolean;
  readonly cc: readonly string[];
  readonly attachments: readonly { filename: string; mimeType: string; sizeBytes: number }[];
  readonly messageIdHeader: string | null;
}

interface RawMessage {
  id?: string;
  threadId?: string;
  snippet?: string;
  internalDate?: string;
  labelIds?: string[];
  payload?: {
    headers?: { name?: string; value?: string }[];
    mimeType?: string;
    filename?: string;
    body?: { data?: string; size?: number };
    parts?: unknown[];
  };
}

function header(raw: RawMessage, name: string): string {
  const found = (raw.payload?.headers ?? []).find(
    (h) => h.name?.toLowerCase() === name.toLowerCase(),
  );
  return found?.value ?? '';
}

function addresses(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function toSummary(raw: RawMessage): MailSummary {
  const labels = raw.labelIds ?? [];
  return {
    id: raw.id ?? '',
    threadId: raw.threadId ?? '',
    from: header(raw, 'From'),
    to: addresses(header(raw, 'To')),
    subject: header(raw, 'Subject'),
    snippet: raw.snippet ?? '',
    // internalDate はミリ秒の文字列。数字でなければ時刻を作らない。
    receivedAt: toIso(raw.internalDate),
    unread: labels.includes('UNREAD'),
    hasAttachments: listAttachments(raw.payload as never).length > 0,
  };
}

function toIso(internalDate: string | undefined): string | null {
  if (!internalDate) return null;
  const ms = Number(internalDate);
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
}

export interface GmailDeps extends CallConfig {
  readonly grantedScopes: readonly string[];
  readonly now?: () => Date;
}

export class GmailConnector {
  readonly #deps: GmailDeps;

  constructor(deps: GmailDeps) {
    this.#deps = deps;
  }

  async list(
    input: { query?: string; maxResults?: number; labelIds?: readonly string[] } = {},
    signal?: AbortSignal,
  ): Promise<MailSummary[]> {
    requireScope(GMAIL_OPERATIONS.list, this.#deps.grantedScopes);
    const params = new URLSearchParams({
      maxResults: String(Math.min(input.maxResults ?? 20, 100)),
    });
    if (input.query) params.set('q', input.query);
    for (const label of input.labelIds ?? []) params.append('labelIds', label);

    const listing = await callJson<{ messages?: { id: string }[] }>(
      `${BASE}/messages?${params.toString()}`,
      { method: 'GET' },
      this.#deps,
      signal,
    );
    const ids = (listing.messages ?? []).map((m) => m.id);
    if (ids.length === 0) return [];

    /*
     * 一覧は id しか返さない。件名も差出人も別の呼び出しが要る。
     * `metadata` だけ取って本文は取りに行かない — 一覧のために
     * 全文を落とすと、読む必要のない本文まで手元に集まる。
     */
    const details = await Promise.all(
      ids.map((id) =>
        callJson<RawMessage>(
          `${BASE}/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject`,
          { method: 'GET' },
          this.#deps,
          signal,
        ),
      ),
    );
    return details.map(toSummary);
  }

  async get(messageId: string, signal?: AbortSignal): Promise<MailMessage> {
    requireScope(GMAIL_OPERATIONS.get, this.#deps.grantedScopes);
    const raw = await callJson<RawMessage>(
      `${BASE}/messages/${encodeURIComponent(messageId)}?format=full`,
      { method: 'GET' },
      this.#deps,
      signal,
    );
    const body = extractBody(raw.payload as never);
    return {
      ...toSummary(raw),
      body: body.text,
      bodyIsHtml: body.isHtml,
      cc: addresses(header(raw, 'Cc')),
      attachments: listAttachments(raw.payload as never),
      messageIdHeader: header(raw, 'Message-ID') || null,
    };
  }

  /** Check the compose connection with a minimal GET. No body content is retained. */
  async probeDrafts(signal?: AbortSignal): Promise<void> {
    requireScope(GMAIL_OPERATIONS.draft, this.#deps.grantedScopes);
    await callJson(
      `${BASE}/drafts?maxResults=1&fields=drafts(id)`,
      { method: 'GET' },
      this.#deps,
      signal,
    );
  }

  /** Independent readback using the SAME compose connection/account as the write. */
  async getDraft(
    draftId: string,
    signal?: AbortSignal,
  ): Promise<{
    id: string;
    to: readonly string[];
    subject: string;
    body: string;
    draft: boolean;
  }> {
    requireScope(GMAIL_OPERATIONS.draft, this.#deps.grantedScopes);
    if (!draftId) throw new ConnectorError('not_found', 'Missing draft ID');
    const raw = await callJson<{ id?: string; message?: RawMessage }>(
      `${BASE}/drafts/${encodeURIComponent(draftId)}?format=full`,
      { method: 'GET' },
      this.#deps,
      signal,
    );
    const message = raw.message ?? {};
    const body = extractBody(message.payload as never);
    return {
      id: raw.id ?? '',
      to: addresses(header(message, 'To')),
      subject: draftSubject(header(message, 'Subject')),
      body: body.text,
      draft:
        !body.isHtml &&
        message.labelIds?.includes('DRAFT') === true &&
        !message.labelIds?.includes('SENT'),
    };
  }

  /** 下書きを作る。**送らない。** */
  async draft(
    message: DraftMessage,
    signal?: AbortSignal,
  ): Promise<{ draftId: string; messageId: string }> {
    requireScope(GMAIL_OPERATIONS.draft, this.#deps.grantedScopes);
    assertSendable(message);
    const result = await callJson<{ id?: string; message?: { id?: string } }>(
      `${BASE}/drafts`,
      { method: 'POST', body: { message: { raw: encodeMessage(message) } } },
      this.#deps,
      signal,
    );
    return { draftId: result.id ?? '', messageId: result.message?.id ?? '' };
  }

  /**
   * 送る。**人の承認が要る。**
   *
   * 承認は `proof` で示す。無ければ `ApprovalRequired` を投げて、何も送らない。
   */
  async send(
    message: DraftMessage & { readonly threadId?: string },
    proof: ApprovalProof | undefined,
    signal?: AbortSignal,
  ): Promise<{ messageId: string; threadId: string }> {
    requireScope(GMAIL_OPERATIONS.send, this.#deps.grantedScopes);
    requireApproval(GMAIL_OPERATIONS.send, proof, (this.#deps.now ?? (() => new Date()))());
    assertSendable(message);
    const result = await callJson<{ id?: string; threadId?: string }>(
      `${BASE}/messages/send`,
      {
        method: 'POST',
        body: {
          raw: encodeMessage(message),
          ...(message.threadId ? { threadId: message.threadId } : {}),
        },
      },
      this.#deps,
      signal,
    );
    return { messageId: result.id ?? '', threadId: result.threadId ?? '' };
  }

  /** Resolve the provider message ID to its RFC Message-ID before replying. */
  async reply(
    originalId: string,
    message: DraftMessage,
    proof: ApprovalProof | undefined,
    expectedThread: string | undefined,
    signal?: AbortSignal,
  ): Promise<{ messageId: string; threadId: string }> {
    requireScope(GMAIL_OPERATIONS.send, this.#deps.grantedScopes);
    requireApproval(GMAIL_OPERATIONS.send, proof, (this.#deps.now ?? (() => new Date()))());
    const original = await this.get(originalId, signal);
    if (
      !original.messageIdHeader ||
      !original.threadId ||
      (expectedThread && original.threadId !== expectedThread)
    ) {
      throw new ConnectorError('provider_error', 'the original reply thread could not be verified');
    }
    return this.send(
      {
        ...message,
        inReplyTo: original.messageIdHeader,
        references: [original.messageIdHeader],
        threadId: original.threadId,
      },
      proof,
      signal,
    );
  }

  /**
   * 捨てる。**人の承認が要る。**
   *
   * ゴミ箱へ移すだけで、消しはしない（`messages.delete` は使わない）。
   * 完全な削除は取り返しがつかず、Genie が代わりに決めてよいことではない。
   */
  async trash(
    messageId: string,
    proof: ApprovalProof | undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    requireScope(GMAIL_OPERATIONS.trash, this.#deps.grantedScopes);
    requireApproval(GMAIL_OPERATIONS.trash, proof, (this.#deps.now ?? (() => new Date()))());
    await callJson<unknown>(
      `${BASE}/messages/${encodeURIComponent(messageId)}/trash`,
      { method: 'POST' },
      this.#deps,
      signal,
    );
  }
}

function encodeMessage(message: DraftMessage): string {
  return toBase64Url(new TextEncoder().encode(buildMime(message)));
}

/** 送れない下書きを、送れるふりで作らない。 */
function assertSendable(message: DraftMessage): void {
  if (message.to.length === 0) {
    throw new ConnectorError('provider_error', 'an email needs at least one recipient');
  }
  for (const address of [...message.to, ...(message.cc ?? []), ...(message.bcc ?? [])]) {
    if (!address.includes('@')) {
      throw new ConnectorError('provider_error', `"${address}" is not an email address`);
    }
  }
}

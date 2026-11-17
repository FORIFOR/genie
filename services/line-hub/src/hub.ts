/**
 * LINE の中継（公式アカウント 1 つで、すべての Genie に届ける）。
 *
 *   LINE ──Webhook──▶ 中継 ──（Genie が自分から張った WebSocket）──▶ 各利用者の Mac の Genie
 *   Genie ──返信・写真の取得──▶ 中継（LINE の鍵はここにだけある）──▶ LINE
 *
 * 利用者は友だち追加して、Mac の Genie で出した「連携 XXXXXXXX」を送るだけ。LINE Developers も鍵も触らない。
 *
 * 届け先の決め方:
 *   1:1     利用者 → その人が連携した Genie（連携コードを送ったときに覚える）。知らない人には連携の促しだけ返す
 *   グループ グループ → 使い始めた Genie。使う前は、Genie へのメンションを送った人の Genie へ届ける
 *           （その Genie が「このグループで使う」を判断する）。招かれたときは始め方だけ返す
 * Genie に許す LINE の操作は、その Genie に届けたもの（返信の token・写真・宛先）と、その Genie の道に限る。
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import {
  channelMessages,
  hashLinkCode,
  linkCodeIn,
  verifyLineSignature,
} from '@genie/service-channels';
import { WebSocketServer, type WebSocket } from 'ws';
import type { HubStore } from './store.js';

export interface HubConfig {
  readonly channelSecret: string;
  readonly accessToken: string;
  readonly store: HubStore;
  /** Genie の登録に要る合言葉（運営者が配る）。無ければ誰でも登録できる（手元の試験用）。 */
  readonly registrationToken?: string | null;
  readonly fetchImpl?: typeof fetch;
  readonly log?: (event: string, detail: Record<string, unknown>) => void;
}

/** Genie → 中継の頼み。 */
type Request =
  | {
      t: 'req';
      id: string;
      op: 'line';
      method: 'GET' | 'POST';
      path: string;
      body?: unknown;
      retryKey?: string;
    }
  | { t: 'req'; id: string; op: 'claim-code'; codeHash: string; expiresAt: number }
  | { t: 'req'; id: string; op: 'claim-group'; groupId: string }
  | { t: 'req'; id: string; op: 'release-user'; userId: string }
  | { t: 'req'; id: string; op: 'release-group'; groupId: string };

const LINE_API = 'https://api.line.me/v2/bot/';
const LINE_DATA = 'https://api-data.line.me/v2/bot/';
const ID = /^[A-Za-z0-9]{1,64}$/;

export interface Hub {
  readonly server: Server;
  /** つながっている Genie の数（状態の確認用）。 */
  connected(): number;
  close(): Promise<void>;
}

export function createHub(config: HubConfig): Hub {
  const { store } = config;
  const fetchImpl = config.fetchImpl ?? fetch;
  const log = config.log ?? (() => {});
  const sockets = new Map<string, WebSocket>();
  /** この接続で送ったもの（受け取りの返事を待っている）。つなぎ直したら空にして、全部を送り直す。 */
  const inFlight = new Map<WebSocket, Set<number>>();
  const registrations = new Map<string, number[]>();

  const lineCall = (url: string, init: RequestInit) =>
    fetchImpl(url, {
      ...init,
      headers: { authorization: `Bearer ${config.accessToken}`, ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(20_000),
    });

  /** 中継が自分で返す（まだ届け先の無い人・グループへ、始め方だけ）。 */
  const replyText = async (replyToken: unknown, text: string) => {
    if (typeof replyToken !== 'string') return;
    await lineCall(`${LINE_API}message/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ replyToken, messages: [{ type: 'text', text }] }),
    }).catch(() => undefined);
  };

  const deliver = (installId: string) => {
    const socket = sockets.get(installId);
    if (!socket || socket.readyState !== socket.OPEN) return;
    const sent = inFlight.get(socket) ?? new Set<number>();
    inFlight.set(socket, sent);
    for (const item of store.pending(installId)) {
      if (sent.has(item.id)) continue;
      sent.add(item.id);
      socket.send(JSON.stringify({ t: 'event', id: item.id, ...JSON.parse(item.payload) }));
    }
  };

  /** 1 つのイベントを、届ける Genie に積む。届け先が無ければ中継が始め方を返す。 */
  const routeEvent = async (destination: string, event: Record<string, unknown>) => {
    const source = (event['source'] ?? {}) as Record<string, unknown>;
    const userId = typeof source['userId'] === 'string' ? source['userId'] : null;
    const groupId =
      source['type'] === 'group' && typeof source['groupId'] === 'string'
        ? source['groupId']
        : source['type'] === 'room' && typeof source['roomId'] === 'string'
          ? source['roomId']
          : null;
    const message = (event['message'] ?? {}) as Record<string, unknown>;
    const text = typeof message['text'] === 'string' ? message['text'] : '';

    let installId: string | null = null;
    if (groupId) {
      installId = store.route('group', groupId);
      if (!installId) {
        // 招かれた時点では、誰の Genie か中継には分からない。挨拶だけ返し、
        // 連携している人がこのグループで話したら、その人の Genie に届ける（Genie がそこで使い始める）
        if (event['type'] === 'join') {
          await replyText(event['replyToken'], channelMessages.groupWelcome(false).text);
          return;
        }
        if (userId) installId = store.route('user', userId);
        if (!installId) {
          const mentioned = JSON.stringify(message['mention'] ?? '').includes('"isSelf":true');
          if (mentioned) await replyText(event['replyToken'], channelMessages.groupPending().text);
          return;
        }
      }
    } else if (userId) {
      installId = store.route('user', userId);
      if (!installId && event['type'] === 'message') {
        // 連携コード: コードを出した Genie へ届け、この人の届け先として覚える
        const code = linkCodeIn(text);
        const owner = code ? store.takeCode(hashLinkCode(code)) : null;
        if (owner) {
          store.setRoute('user', userId, owner);
          installId = owner;
        } else {
          await replyText(
            event['replyToken'],
            code ? channelMessages.linkFailed('invalid').text : channelMessages.linkPrompt().text,
          );
          return;
        }
      }
      if (!installId && event['type'] === 'follow') {
        await replyText(event['replyToken'], channelMessages.linkPrompt().text);
        return;
      }
    }
    if (!installId) return;

    // その Genie に許す操作（返信・写真の取得・宛先）を覚えてから積む
    if (typeof event['replyToken'] === 'string')
      store.markDelivered(installId, 'reply_token', event['replyToken']);
    if (typeof message['id'] === 'string') store.markDelivered(installId, 'message', message['id']);
    if (userId) store.markDelivered(installId, 'target', userId);
    if (groupId) store.markDelivered(installId, 'target', groupId);
    store.enqueue(installId, JSON.stringify({ destination, event }));
    deliver(installId);
  };

  const readBody = (req: IncomingMessage, limit: number) =>
    new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > limit) {
          reject(new Error('too large'));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });

  const server = createServer((req, res) => {
    const send = (status: number, body: unknown = {}) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const path = (req.url ?? '').split('?')[0];
    if (req.method === 'GET' && path === '/healthz')
      return send(200, { ok: true, connected: sockets.size });

    if (req.method === 'POST' && path === '/line/webhook') {
      readBody(req, 1024 * 1024)
        .then(async (raw) => {
          const signature = req.headers['x-line-signature'];
          if (
            !verifyLineSignature({
              channelSecret: config.channelSecret,
              signature: typeof signature === 'string' ? signature : undefined,
              rawBody: raw,
            })
          )
            return send(403, { error: 'bad signature' });
          const payload = JSON.parse(raw.toString('utf8')) as {
            destination?: string;
            events?: unknown[];
          };
          for (const event of payload.events ?? []) {
            if (event && typeof event === 'object')
              await routeEvent(payload.destination ?? '', event as Record<string, unknown>);
          }
          return send(200);
        })
        .catch(() => send(400, { error: 'bad request' }));
      return undefined;
    }

    if (req.method === 'POST' && path === '/installs') {
      // 登録は合言葉で守る（無ければ 1 つの IP から 1 時間に 5 回まで）
      const auth = req.headers['authorization'];
      if (config.registrationToken && auth !== `Bearer ${config.registrationToken}`)
        return send(401, { error: 'registration token required' });
      const ip = req.socket.remoteAddress ?? '?';
      const now = Date.now();
      const recent = (registrations.get(ip) ?? []).filter((t) => now - t < 3600_000);
      if (!config.registrationToken && recent.length >= 5) return send(429, { error: 'slow down' });
      registrations.set(ip, [...recent, now]);
      const { installId, secret } = store.register();
      log('hub.registered', { installId });
      return send(201, { install_id: installId, secret });
    }
    return send(404, { error: 'not found' });
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 12 * 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    if ((req.url ?? '').split('?')[0] !== '/connect') {
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
      return;
    }
    const auth = /^Bearer ([A-Za-z0-9_-]+):([A-Za-z0-9_-]+)$/.exec(
      req.headers['authorization'] ?? '',
    );
    if (!auth || !store.authenticate(auth[1]!, auth[2]!)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return;
    }
    const installId = auth[1]!;
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.get(installId)?.close(4000, 'replaced');
      sockets.set(installId, ws);
      log('hub.connected', { installId });
      ws.send(JSON.stringify({ t: 'hello', installId }));
      deliver(installId);
      ws.on('close', () => {
        inFlight.delete(ws);
        if (sockets.get(installId) === ws) sockets.delete(installId);
      });
      ws.on('message', (data) => {
        let message: { t?: string; id?: unknown };
        try {
          message = JSON.parse(String(data)) as typeof message;
        } catch {
          return;
        }
        if (message.t === 'ack' && typeof message.id === 'number') {
          store.ack(installId, message.id);
          inFlight.get(ws)?.delete(message.id);
          return;
        }
        if (message.t === 'req' && typeof message.id === 'string') {
          handle(installId, message as Request)
            .then((res) => ws.send(JSON.stringify({ t: 'res', id: message.id, ...res })))
            .catch(() => ws.send(JSON.stringify({ t: 'res', id: message.id, status: 502 })));
        }
      });
    });
  });

  /** Genie の頼み。**その Genie に届けたもの・その Genie の道だけ**を許す。 */
  const handle = async (
    installId: string,
    req: Request,
  ): Promise<{ status: number; headers?: Record<string, string>; body?: string }> => {
    const owns = (target: string) =>
      store.route('user', target) === installId ||
      store.route('group', target) === installId ||
      store.wasDelivered(installId, 'target', target);
    switch (req.op) {
      case 'claim-code':
        if (!/^[0-9a-f]{64}$/.test(req.codeHash)) return { status: 400 };
        store.claimCode(req.codeHash, installId, req.expiresAt);
        return { status: 204 };
      case 'claim-group':
        // その Genie に、そのグループの知らせを届けたことがあるときだけ
        if (!ID.test(req.groupId) || !store.wasDelivered(installId, 'target', req.groupId))
          return { status: 403 };
        store.setRoute('group', req.groupId, installId);
        return { status: 204 };
      case 'release-user':
        store.releaseRoute('user', req.userId, installId);
        return { status: 204 };
      case 'release-group':
        store.releaseRoute('group', req.groupId, installId);
        return { status: 204 };
      case 'line': {
        const body = (req.body ?? {}) as Record<string, unknown>;
        let url: string | null = null;
        if (req.method === 'POST' && req.path === 'message/reply') {
          if (
            typeof body['replyToken'] === 'string' &&
            store.wasDelivered(installId, 'reply_token', body['replyToken'])
          )
            url = `${LINE_API}message/reply`;
        } else if (req.method === 'POST' && req.path === 'message/push') {
          if (typeof body['to'] === 'string' && owns(body['to'])) url = `${LINE_API}message/push`;
        } else if (req.method === 'POST' && req.path === 'chat/loading/start') {
          if (
            typeof body['chatId'] === 'string' &&
            store.route('user', body['chatId']) === installId
          )
            url = `${LINE_API}chat/loading/start`;
        } else if (req.method === 'GET') {
          const content = /^message\/([0-9]+)\/content$/.exec(req.path);
          const member = /^(group|room)\/([A-Za-z0-9]+)\/member\/([A-Za-z0-9]+)$/.exec(req.path);
          if (content && store.wasDelivered(installId, 'message', content[1]!))
            url = `${LINE_DATA}${req.path}`;
          if (member && owns(member[2]!)) url = `${LINE_API}${req.path}`;
        }
        if (!url) return { status: 403 };
        const response = await lineCall(url, {
          method: req.method,
          ...(req.method === 'POST'
            ? {
                headers: {
                  'content-type': 'application/json',
                  ...(req.retryKey ? { 'X-Line-Retry-Key': req.retryKey } : {}),
                },
                body: JSON.stringify(body),
              }
            : {}),
        });
        const data = Buffer.from(await response.arrayBuffer());
        const headers: Record<string, string> = {};
        for (const key of ['content-type', 'retry-after']) {
          const v = response.headers.get(key);
          if (v) headers[key] = v;
        }
        return { status: response.status, headers, body: data.toString('base64') };
      }
    }
  };

  const prune = setInterval(() => store.prune(), 10 * 60 * 1000);
  prune.unref();

  return {
    server,
    connected: () => sockets.size,
    close: async () => {
      clearInterval(prune);
      for (const ws of sockets.values()) ws.close(1001, 'hub closing');
      wss.close();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

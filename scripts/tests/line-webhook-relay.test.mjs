import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRelay, MAX_BODY, WEBHOOK_PATH } from '../line-webhook-relay.mjs';
import { channelEnvironment, parseOptions } from '../local-preview/config.mjs';
import { SECRET_ENV, secretEnvironment } from '../local-preview/secrets.mjs';

async function withRelay(fn) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response('{}', { status: 200 });
  };
  const server = createRelay({ gateway: 'http://127.0.0.1:43123', fetchImpl });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base, calls);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('passes only the LINE webhook, with the raw body and signature', async () => {
  await withRelay(async (base, calls) => {
    const body = '{"destination":"U","events":[]}';
    const ok = await fetch(base + WEBHOOK_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-line-signature': 'sig', cookie: 'x' },
      body,
    });
    assert.equal(ok.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://127.0.0.1:43123' + WEBHOOK_PATH);
    assert.equal(Buffer.from(calls[0].init.body).toString(), body);
    assert.deepEqual(calls[0].init.headers, {
      'content-type': 'application/json',
      'x-line-signature': 'sig',
    });

    for (const [method, path] of [
      ['POST', '/v1/auth/dev/token'],
      ['GET', WEBHOOK_PATH],
      ['POST', WEBHOOK_PATH + '?x=1'],
      ['POST', '/v1/channels/slack/events'],
      ['GET', '/healthz'],
    ]) {
      const res = await fetch(base + path, {
        method,
        ...(method === 'POST' ? { body: '{}' } : {}),
      });
      assert.equal(res.status, 404, `${method} ${path}`);
    }
    assert.equal(calls.length, 1);
  });
});

test('refuses a body over the limit without forwarding it', async () => {
  await withRelay(async (base, calls) => {
    const res = await fetch(base + WEBHOOK_PATH, {
      method: 'POST',
      body: 'x'.repeat(MAX_BODY + 10),
    }).catch(() => null);
    assert.ok(res === null || res.status === 413);
    assert.equal(calls.length, 0);
  });
});

test('refuses a gateway that is not on this Mac', () => {
  assert.throws(() => createRelay({ gateway: 'https://example.com' }));
});

test('--channels-env takes settings only, and names secrets so they move to the Keychain', () => {
  const { env, ignored, secrets } = channelEnvironment(
    [
      '# comment',
      'LINE_CHANNEL_SECRET="s"',
      'GENIE_CALL_GEMINI_API_KEY=',
      'GENIE_CALL_MONTHLY_MINUTES=60',
      'export GENIE_TIMEZONE=Asia/Tokyo',
      "GENIE_PUBLIC_URL='https://x.trycloudflare.com'",
      'GENIE_LINE_LIFF_ID=1234567890-AbCdEfGh',
      'OPENAI_API_KEY=x',
      '',
    ].join('\n'),
    Object.keys(SECRET_ENV),
  );
  assert.deepEqual(env, {
    GENIE_CALL_MONTHLY_MINUTES: '60',
    GENIE_TIMEZONE: 'Asia/Tokyo',
    GENIE_PUBLIC_URL: 'https://x.trycloudflare.com',
    GENIE_LINE_LIFF_ID: '1234567890-AbCdEfGh',
  });
  // 値の入った鍵だけを挙げる（空の行は鍵として扱わない）
  assert.deepEqual(secrets, ['LINE_CHANNEL_SECRET']);
  assert.deepEqual(ignored, ['OPENAI_API_KEY']);
  assert.throws(() => channelEnvironment('not a pair'));
  assert.match(parseOptions(['--channels-env', 'line.env']).channelsEnv, /line\.env$/);
});

test('secrets come from the Keychain by name, and the Gemini key is the one the Mac uses', async () => {
  const asked = [];
  const env = await secretEnvironment(async (name) => {
    asked.push(name);
    return { 'line-access-token': 't', gemini: 'g' }[name] ?? null;
  });
  assert.deepEqual(env, { LINE_CHANNEL_ACCESS_TOKEN: 't', GENIE_CALL_GEMINI_API_KEY: 'g' });
  assert.ok(asked.includes('anthropic'));
  assert.equal(SECRET_ENV.GENIE_CALL_GEMINI_API_KEY, 'gemini');
});

test('passes only the call page and its WebSocket to the gateway', async () => {
  const { createServer } = await import('node:http');
  const { WebSocketServer, WebSocket } = await import('ws');
  const seen = [];
  const gateway = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': 'x=1' });
    res.end('<h1>Genie と話す</h1>');
  });
  const wss = new WebSocketServer({ noServer: true });
  gateway.on('upgrade', (req, socket, head) => {
    seen.push(`UPGRADE ${req.url}`);
    wss.handleUpgrade(req, socket, head, (ws) => ws.on('message', (m) => ws.send(`echo:${m}`)));
  });
  await new Promise((r) => gateway.listen(0, '127.0.0.1', r));
  const relay = createRelay({ gateway: `http://127.0.0.1:${gateway.address().port}` });
  await new Promise((r) => relay.listen(0, '127.0.0.1', r));
  const base = `127.0.0.1:${relay.address().port}`;
  const token = 'A'.repeat(32);
  try {
    const page = await fetch(`http://${base}/v1/channels/call/${token}?openExternalBrowser=1`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Genie と話す/);
    assert.equal(page.headers.get('set-cookie'), null);
    assert.equal((await fetch(`http://${base}/v1/channels/call/short`)).status, 404);

    const ws = new WebSocket(`ws://${base}/v1/channels/call/${token}/ws`);
    const echoed = await new Promise((resolve, reject) => {
      ws.on('open', () => ws.send('hi'));
      ws.on('message', (m) => resolve(String(m)));
      ws.on('error', reject);
    });
    assert.equal(echoed, 'echo:hi');
    ws.close();

    const refused = await new Promise((resolve) => {
      const bad = new WebSocket(`ws://${base}/v1/auth/dev/token`);
      bad.on('error', () => resolve(true));
      bad.on('open', () => resolve(false));
    });
    assert.equal(refused, true);
    assert.deepEqual(seen, [
      `GET /v1/channels/call/${token}`,
      `UPGRADE /v1/channels/call/${token}/ws`,
    ]);
  } finally {
    await new Promise((r) => relay.close(r));
    wss.close();
    gateway.closeAllConnections?.();
    await new Promise((r) => gateway.close(r));
  }
});

test('passes the reconnect page, status and callback, and nothing else under it', async () => {
  const seen = [];
  const gateway = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push(`${req.method} ${req.url} ${body}`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"result":"ok"}');
    });
  });
  await new Promise((r) => gateway.listen(0, '127.0.0.1', r));
  const relay = createRelay({ gateway: `http://127.0.0.1:${gateway.address().port}` });
  await new Promise((r) => relay.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${relay.address().port}/v1/channels/reconnect`;
  const token = 'R'.repeat(32);
  try {
    assert.equal((await fetch(`${base}/${token}?openExternalBrowser=1`)).status, 200);
    assert.equal((await fetch(`${base}/${token}/status`)).status, 200);
    const posted = await fetch(`${base}/${token}/callback`, {
      method: 'POST',
      body: '{"url":"http://127.0.0.1:1/callback?code=c&state=s"}',
    });
    assert.deepEqual(await posted.json(), { result: 'ok' });
    assert.equal((await fetch(`${base}/short`)).status, 404);
    assert.equal((await fetch(`${base}/${token}/other`)).status, 404);
    assert.equal(
      (await fetch(`http://127.0.0.1:${relay.address().port}/v1/connector-reconnects/pending`)).status,
      404,
    );
    assert.deepEqual(seen, [
      `GET /v1/channels/reconnect/${token} `,
      `GET /v1/channels/reconnect/${token}/status `,
      `POST /v1/channels/reconnect/${token}/callback {"url":"http://127.0.0.1:1/callback?code=c&state=s"}`,
    ]);
  } finally {
    relay.close();
    gateway.close();
  }
});

test('passes the browser handoff page and its WebSocket, and nothing else under it', async () => {
  const { createServer } = await import('node:http');
  const { WebSocketServer, WebSocket } = await import('ws');
  const seen = [];
  const gateway = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<h1>ログインだけお願いします</h1>');
  });
  const wss = new WebSocketServer({ noServer: true });
  gateway.on('upgrade', (req, socket, head) => {
    seen.push(`UPGRADE ${req.url}`);
    wss.handleUpgrade(req, socket, head, (ws) => ws.on('message', (m) => ws.send(`echo:${m}`)));
  });
  await new Promise((r) => gateway.listen(0, '127.0.0.1', r));
  const relay = createRelay({ gateway: `http://127.0.0.1:${gateway.address().port}` });
  await new Promise((r) => relay.listen(0, '127.0.0.1', r));
  const base = `127.0.0.1:${relay.address().port}`;
  const token = 'H'.repeat(32);
  try {
    assert.equal((await fetch(`http://${base}/v1/channels/handoff/${token}`)).status, 200);
    // 端末の道（画面を送る・操作を取る）は外から通さない
    for (const path of [
      `/v1/channels/handoff/${token}/frame`,
      '/v1/browser-handoffs',
      `/v1/channels/handoff/short`,
    ])
      assert.equal((await fetch(`http://${base}${path}`)).status, 404, path);
    const ws = new WebSocket(`ws://${base}/v1/channels/handoff/${token}/ws`);
    const echoed = await new Promise((resolve, reject) => {
      ws.on('open', () => ws.send('tap'));
      ws.on('message', (m) => resolve(String(m)));
      ws.on('error', reject);
    });
    assert.equal(echoed, 'echo:tap');
    ws.close();
    assert.deepEqual(seen, [
      `GET /v1/channels/handoff/${token}`,
      `UPGRADE /v1/channels/handoff/${token}/ws`,
    ]);
  } finally {
    await new Promise((r) => relay.close(r));
    wss.close();
    gateway.closeAllConnections?.();
    await new Promise((r) => gateway.close(r));
  }
});

test('passes the read-only board page and its state, and nothing that writes', async () => {
  const { createServer } = await import('node:http');
  const seen = [];
  const gateway = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'x=1' });
    res.end('{"title":"新宿でお出かけ"}');
  });
  await new Promise((r) => gateway.listen(0, '127.0.0.1', r));
  const relay = createRelay({ gateway: `http://127.0.0.1:${gateway.address().port}` });
  await new Promise((r) => relay.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${relay.address().port}`;
  const token = 'B'.repeat(32);
  try {
    assert.equal((await fetch(`${base}/v1/channels/board/${token}`)).status, 200);
    const state = await fetch(`${base}/v1/channels/board/${token}/state?x=1`);
    assert.equal(state.status, 200);
    assert.match(await state.text(), /新宿でお出かけ/);
    assert.equal(state.headers.get('set-cookie'), null);
    assert.equal((await fetch(`${base}/v1/channels/board/short`)).status, 404);
    assert.equal(
      (await fetch(`${base}/v1/channels/board/${token}/state`, { method: 'POST', body: '{}' }))
        .status,
      404,
    );
    assert.equal((await fetch(`${base}/v1/channels/board/${token}/vote`)).status, 404);
    assert.equal((await fetch(`${base}/v1/channels/media/${token}`)).status, 200);
    assert.equal((await fetch(`${base}/v1/channels/media/${token}/x`)).status, 404);
    // LIFF の入口。liff.state だけ渡し、ほかのクエリは捨てる
    assert.equal(
      (await fetch(`${base}/v1/channels/board?liff.state=%2F${token}&access_token=secret&x=1`))
        .status,
      200,
    );
    assert.equal((await fetch(`${base}/v1/channels/board/`)).status, 404);
    assert.deepEqual(seen, [
      `GET /v1/channels/board/${token}`,
      `GET /v1/channels/board/${token}/state`,
      `GET /v1/channels/media/${token}`,
      `GET /v1/channels/board?liff.state=%2F${token}`,
    ]);
  } finally {
    await new Promise((r) => relay.close(r));
    gateway.closeAllConnections?.();
    await new Promise((r) => gateway.close(r));
  }
});

test('passes the read-only work home, its state and ledgers, and nothing else', async () => {
  const { createServer } = await import('node:http');
  const seen = [];
  const gateway = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise((r) => gateway.listen(0, '127.0.0.1', r));
  const relay = createRelay({ gateway: `http://127.0.0.1:${gateway.address().port}` });
  await new Promise((r) => relay.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${relay.address().port}`;
  const token = 'W'.repeat(32);
  const id = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
  try {
    assert.equal((await fetch(`${base}/v1/channels/work/${token}`)).status, 200);
    assert.equal((await fetch(`${base}/v1/channels/work/${token}/state?x=1`)).status, 200);
    assert.equal((await fetch(`${base}/v1/channels/work/${token}/item/s/${id}`)).status, 200);
    assert.equal((await fetch(`${base}/v1/channels/work/${token}/item/t/${id}`)).status, 200);
    // ほかの種類・形の違う id・書き込み・LIFF の入口以外のクエリ付きの道は通さない
    assert.equal((await fetch(`${base}/v1/channels/work/${token}/item/x/${id}`)).status, 404);
    assert.equal((await fetch(`${base}/v1/channels/work/${token}/item/s/../../x`)).status, 404);
    assert.equal(
      (await fetch(`${base}/v1/channels/work/${token}/state`, { method: 'POST', body: '{}' })).status,
      404,
    );
    assert.equal((await fetch(`${base}/v1/work/overview`)).status, 404);
    assert.equal(
      (await fetch(`${base}/v1/channels/board?liff.state=%2Fw%2F${token}&access_token=secret`)).status,
      200,
    );
    // 承認ルール: 一覧は読むだけ。変えられるのは取り消しだけ（本文は渡さない）
    assert.equal((await fetch(`${base}/v1/channels/work/${token}/rules`)).status, 200);
    assert.equal(
      (
        await fetch(`${base}/v1/channels/work/${token}/rules/${id}/revoke`, {
          method: 'POST',
          body: '{"all":true}',
        })
      ).status,
      200,
    );
    for (const path of [`/rules`, `/rules/${id}`, `/rules/all/revoke`, `/rules/${id}/revoke/x`])
      assert.equal(
        (await fetch(`${base}/v1/channels/work/${token}${path}`, { method: 'POST' })).status,
        404,
        path,
      );
    assert.deepEqual(seen, [
      `GET /v1/channels/work/${token}`,
      `GET /v1/channels/work/${token}/state`,
      `GET /v1/channels/work/${token}/item/s/${id}`,
      `GET /v1/channels/work/${token}/item/t/${id}`,
      `GET /v1/channels/board?liff.state=%2Fw%2F${token}`,
      `GET /v1/channels/work/${token}/rules`,
      `POST /v1/channels/work/${token}/rules/${id}/revoke`,
    ]);
  } finally {
    await new Promise((r) => relay.close(r));
    gateway.closeAllConnections?.();
    await new Promise((r) => gateway.close(r));
  }
});

test('passes /line/webhook to a local hub only when one is given', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    return new Response('{}', { status: 200 });
  };
  for (const hub of [null, 'http://127.0.0.1:8790']) {
    const server = createRelay({ gateway: 'http://127.0.0.1:43123', hub, fetchImpl });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const res = await fetch(`http://127.0.0.1:${server.address().port}/line/webhook`, {
      method: 'POST',
      body: '{}',
    });
    assert.equal(res.status, hub ? 200 : 404);
    await new Promise((r) => server.close(r));
  }
  assert.deepEqual(calls, ['http://127.0.0.1:8790/line/webhook']);
  assert.throws(() => createRelay({ gateway: 'http://127.0.0.1:1', hub: 'https://example.com' }));
});

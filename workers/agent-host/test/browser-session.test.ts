/**
 * Genie 専用のブラウザの一回分（本物の画面なしの Chromium。この Mac にあるときだけ）。
 *
 * 見ること（本人がスマホから引き継いで操作するときに使う道）:
 *   - スマホの大きさで開き、画面の 1 枚と、画面の流れ（スクリーンキャスト）が届く
 *   - パスワードの欄があること・選ばれていることが分かる
 *   - 押す・文字を入れる・Enter で、本当にフォームが送られる
 */
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserSession, browserExecutable, type Frame } from '../src/browser-session.js';

const executable = browserExecutable();

describe.skipIf(!executable)('a Genie browser session a person can take over', () => {
  let server: Server;
  let base = '';
  let profile = '';
  const posted: string[] = [];

  beforeAll(async () => {
    profile = await mkdtemp(join(tmpdir(), 'genie-session-'));
    server = createServer((req, res) => {
      if (req.method === 'POST') {
        let body = '';
        req.on('data', (c: Buffer) => (body += c.toString()));
        req.on('end', () => {
          posted.push(body);
          res.setHeader('content-type', 'text/html; charset=utf-8');
          res.end(
            '<title>ようこそ</title><main>ログインしました。会員ページの本文です。'.padEnd(
              300,
              '。',
            ) + '</main>',
          );
        });
        return;
      }
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(`<!doctype html><title>ログイン</title>
<form method="post" action="/login" style="margin:0">
  <input id="u" name="user" style="position:absolute;left:10px;top:10px;width:200px;height:40px">
  <input id="p" name="pass" type="password" style="position:absolute;left:10px;top:70px;width:200px;height:40px">
  <button style="position:absolute;left:10px;top:130px">ログイン</button>
</form>`);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${String((server.address() as { port: number }).port)}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(profile, { recursive: true, force: true });
  });

  it('shows the screen, knows the password field, and lets taps and typing submit the form', async () => {
    const stop = AbortSignal.timeout(30_000);
    const session = await BrowserSession.open(
      { executable, profileDir: profile, allow: () => true, mobile: { width: 390, height: 700 } },
      stop,
    );
    try {
      await session.goto(`${base}/`, stop);
      expect(await session.hasPasswordField()).toBe(true);
      const shot = await session.screenshot();
      expect(shot.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));

      const frames: Frame[] = [];
      await session.startScreencast((f) => frames.push(f));
      await session.tap(100, 30);
      await session.insertText('taro');
      expect(await session.passwordFocused()).toBe(false);
      await session.tap(100, 90);
      expect(await session.passwordFocused()).toBe(true);
      await session.insertText('secret-pass');
      await session.key('Enter');
      await session.settle(stop, 500);
      for (let i = 0; i < 20 && frames.length === 0; i++)
        await new Promise((r) => setTimeout(r, 100));
      await session.stopScreencast();

      expect(posted).toEqual(['user=taro&pass=secret-pass']);
      const page = await session.extract();
      expect(page.title).toBe('ようこそ');
      expect(await session.hasPasswordField()).toBe(false);
      expect(frames.length).toBeGreaterThan(0);
      expect(frames[0]!.width).toBe(390);
    } finally {
      await session.close();
    }
  }, 40_000);
});

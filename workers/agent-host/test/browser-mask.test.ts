/**
 * LINE へ送る画面の隠し方（本物の画面なしの Chromium。この Mac にあるときだけ）。
 *
 * 見ること:
 *   - パスワード・カード番号の欄、カード会社の入力枠、画面の文のカード番号（Luhn が合うもの）を隠す
 *   - カード番号に似ているだけの数字（Luhn が合わない）は隠さない
 *   - 撮ったあと、隠す層は外れている（ページはそのまま）
 */
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserSession, browserExecutable } from '../src/browser-session.js';

const executable = browserExecutable();

describe.skipIf(!executable)('masking what must not be sent to LINE', () => {
  let server: Server;
  let base = '';
  let profile = '';

  beforeAll(async () => {
    profile = await mkdtemp(join(tmpdir(), 'genie-mask-'));
    server = createServer((_req, res) => {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      // 隠す層があるかを題名に写す（撮ったあとに外れているかを、ページの外から確かめる）
      res.end(`<!doctype html><title>clear</title>
<script>setInterval(() => { document.title = document.getElementById('__genie_mask_layer') ? 'masked' : 'clear'; }, 5);</script>
<body style="margin:0;font:16px sans-serif">
  <input type="password" style="position:absolute;left:10px;top:10px;width:200px;height:30px">
  <input name="cardnumber" style="position:absolute;left:10px;top:50px;width:200px;height:30px">
  <iframe title="カード情報" style="position:absolute;left:10px;top:90px;width:200px;height:40px;border:0"></iframe>
  <p style="position:absolute;left:10px;top:140px;margin:0">お支払い: 4242 4242 4242 4242</p>
  <p style="position:absolute;left:10px;top:180px;margin:0">注文番号: 1234 5678 9012 3456</p>
  <input name="nickname" value="たろう" style="position:absolute;left:10px;top:220px;width:200px;height:30px">
</body>`);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${String((server.address() as { port: number }).port)}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(profile, { recursive: true, force: true });
  });

  it('hides passwords, card fields, card frames and card numbers, and leaves the page as it was', async () => {
    const stop = AbortSignal.timeout(30_000);
    const session = await BrowserSession.open(
      { executable, profileDir: profile, allow: () => true, mobile: { width: 390, height: 700 } },
      stop,
    );
    try {
      await session.goto(`${base}/`, stop);
      const shot = await session.maskedScreenshot();
      expect(shot).not.toBeNull();
      expect(shot!.jpeg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
      // パスワード・カード番号の欄・カードの枠・文のカード番号の 4 か所。注文番号と名前は隠さない
      expect(shot!.masked).toBe(4);
      await new Promise((r) => setTimeout(r, 50));
      expect((await session.extract()).title).toBe('clear');
    } finally {
      await session.close();
    }
  });
});

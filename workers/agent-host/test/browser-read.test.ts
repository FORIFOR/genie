/**
 * `browser.read_page`（Genie 専用のブラウザで読む）。
 *
 * 見ること:
 *   - 公開でないアドレス（Mac の中・家の中）は開かない。転送された先が公開でなければ読まない
 *   - 本文が無いページでは答えを作らせない。答えからリンクを外す
 *   - 本物の画面なしの Chromium で開き、本文を取り出す。ページの中から公開でない先へは読みに行かせない
 *     （この Mac に Playwright の Chromium か Chrome があるときだけ）
 */
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BrowserReadRuntime,
  browserExecutable,
  readWithBrowser,
  withoutLinks,
  type PageText,
} from '../src/browser-read.js';

const step = (args: Record<string, unknown>) => ({
  id: 's-1',
  toolId: 'browser.read_page',
  args,
  approval: null,
});

const runtime = (page: PageText | Error, answer: unknown = { answer: '要点です。' }) => {
  const asked: Record<string, unknown>[] = [];
  const opened: string[] = [];
  const r = new BrowserReadRuntime({
    ask: async (_tool, args) => {
      asked.push(args);
      return answer;
    },
    readPage: async (url) => {
      opened.push(url);
      if (page instanceof Error) throw page;
      return page;
    },
  });
  return { r, asked, opened };
};

const ARTICLE = {
  finalUrl: 'https://example.com/post',
  title: '新しい料金のお知らせ',
  text: '2027 年 1 月から、基本料金を月 980 円に改めます。既存の利用者は 3 月まで据え置きです。',
};

describe('reading a page in the Genie browser', () => {
  it('refuses addresses inside the Mac or the home network without opening anything', async () => {
    for (const url of [
      'http://localhost:3000/',
      'http://127.0.0.1/',
      'http://192.168.1.10/admin',
      'http://10.0.0.1/',
      'http://printer.local/',
      'file:///etc/passwd',
      'http://user:pass@example.com/',
    ]) {
      const { r, opened } = runtime(ARTICLE);
      const out = await r.run(step({ url, question: 'このページを要約して' }));
      expect(out, url).toMatchObject({ ok: true, result: { read: false, answer: null } });
      expect(opened, url).toEqual([]);
    }
  });

  it('answers from the page text only, and strips links from the answer', async () => {
    const { r, asked } = runtime(ARTICLE, {
      answer:
        '料金は月 980 円になります。[詳しくはこちら](https://evil.example) https://evil.example/x',
    });
    const out = await r.run(
      step({ url: 'https://example.com/post', question: 'このページを要約して' }),
    );
    expect(out).toEqual({
      ok: true,
      result: {
        url: 'https://example.com/post',
        finalUrl: 'https://example.com/post',
        title: '新しい料金のお知らせ',
        read: true,
        chars: ARTICLE.text.length,
        answer: '料金は月 980 円になります。詳しくはこちら',
      },
    });
    expect(asked[0]).toMatchObject({ question: 'このページを要約して', text: ARTICLE.text });
  });

  it('does not answer when the redirect leaves the public web or the page has no text', async () => {
    const redirected = runtime({ ...ARTICLE, finalUrl: 'http://192.168.0.1/' });
    expect(
      await redirected.r.run(step({ url: 'https://example.com/', question: '要約して' })),
    ).toMatchObject({
      ok: true,
      result: { read: false, problem: expect.stringContaining('転送') },
    });
    expect(redirected.asked).toEqual([]);

    const empty = runtime({ ...ARTICLE, text: 'ログイン' });
    expect(
      await empty.r.run(step({ url: 'https://example.com/', question: '要約して' })),
    ).toMatchObject({
      ok: true,
      result: { read: false, problem: expect.stringContaining('本文') },
    });
    expect(empty.asked).toEqual([]);

    const broken = runtime(new Error('no_browser'));
    expect(
      await broken.r.run(step({ url: 'https://example.com/', question: '要約して' })),
    ).toMatchObject({
      ok: true,
      result: { read: false, problem: expect.stringContaining('専用のブラウザが見つかりません') },
    });
  });

  it('takes links out of a model answer', () => {
    expect(
      withoutLinks('見て ![x](https://a/b.png) [ここ](javascript:alert(1)) data:text/html,hi'),
    ).toBe('見て x ここ');
  });

  it('prefers a named executable, then the newest headless Chromium, then Chrome', () => {
    const have = new Set([
      '/opt/x/chrome',
      join(
        process.env['HOME'] ?? '',
        'Library/Caches/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell',
      ),
      join(
        process.env['HOME'] ?? '',
        'Library/Caches/ms-playwright/chromium_headless_shell-1200/chrome-headless-shell-mac-arm64/chrome-headless-shell',
      ),
    ]);
    const list = () => [
      'chromium-1248',
      'chromium_headless_shell-1200',
      'chromium_headless_shell-1248',
    ];
    expect(
      browserExecutable({ GENIE_BROWSER_EXECUTABLE: '/opt/x/chrome' }, (p) => have.has(p), list),
    ).toBe('/opt/x/chrome');
    expect(browserExecutable({}, (p) => have.has(p), list)).toContain(
      'chromium_headless_shell-1248',
    );
    expect(
      browserExecutable(
        {},
        () => false,
        () => [],
      ),
    ).toBeNull();
  });
});

const executable = browserExecutable();

describe.skipIf(!executable)('the real headless browser', () => {
  let server: Server;
  let base = '';
  let profile = '';
  const hits: string[] = [];

  beforeAll(async () => {
    profile = await mkdtemp(join(tmpdir(), 'genie-browser-'));
    server = createServer((req, res) => {
      hits.push(req.url ?? '');
      if (req.url === '/page') {
        res.setHeader('content-type', 'text/html; charset=utf-8');
        // 本文はスクリプトで出す。ページの中から /secret（公開でない先の代わり）へ読みに行こうとする
        res.end(`<!doctype html><title>お知らせ</title><body><main id="m"></main>
<script>
  document.getElementById('m').innerText = '本文: 来月から営業時間を 10 時から 19 時に変えます。'.repeat(8);
  fetch('/secret').catch(() => {});
  new Image().src = '/secret.png';
  alert('閉じてください');
</script></body>`);
        return;
      }
      res.end('secret');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    base = `http://127.0.0.1:${String(address.port)}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(profile, { recursive: true, force: true });
  });

  it('opens the page out of sight, reads the rendered text, and blocks what the page reaches for', async () => {
    const page = await readWithBrowser(`${base}/page`, undefined, {
      executable,
      profileDir: profile,
      // このテストの先（127.0.0.1）は通し、/secret だけを公開でない先の代わりに止める
      allow: (url) => !url.includes('/secret'),
      timeoutMs: 30_000,
    });
    expect(page.title).toBe('お知らせ');
    expect(page.finalUrl).toBe(`${base}/page`);
    expect(page.text).toContain('来月から営業時間を 10 時から 19 時に変えます。');
    expect(hits).toContain('/page');
    expect(hits.filter((h) => h.startsWith('/secret'))).toEqual([]);
  }, 40_000);
});

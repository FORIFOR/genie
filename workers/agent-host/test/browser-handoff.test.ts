/**
 * ブラウザの引き継ぎ（端末の側）。gateway とブラウザは代役。
 *
 * 見ること:
 *   - 当てるのは本人の操作だけ（Genie は自分では押さない・入力しない）
 *   - パスワードの欄が消えたら（ログインが済んだら）続ける。「Genie に戻す」でも続ける。「やめる」・時間切れは止める
 *   - 画面にはパスワードの欄が選ばれているかを添える。終わったら画面の流れを止め、スマホの大きさを戻し、終わりを伝える
 *   - ログインの壁のページだけ引き継ぎ、済んだら頼まれたページを読み直して答える
 */
import { describe, expect, it } from 'vitest';
import { handOff, type HandoffApi, type HandoffInput } from '../src/browser-handoff.js';
import { BrowserReadRuntime, readOrHandOff, type ReadingSession } from '../src/browser-read.js';
import type { Frame } from '../src/browser-session.js';

const fakeSession = (opts: { loginAfter?: number } = {}) => {
  const calls: string[] = [];
  let password = true;
  let typed = 0;
  let listener: ((f: Frame) => void) | null = null;
  const session: ReadingSession = {
    async goto(url) {
      calls.push(`goto ${url}`);
    },
    async extract() {
      return password
        ? {
            finalUrl: 'https://members.example.com/login',
            title: 'ログイン',
            text: 'ログインしてください',
          }
        : {
            finalUrl: 'https://members.example.com/news/1',
            title: '会員のお知らせ',
            text: '会員だけが読める本文です。'.repeat(10),
          };
    },
    async close() {
      calls.push('close');
    },
    async startScreencast(l) {
      listener = l;
      calls.push('screencast');
      l({ jpeg: Buffer.from([0xff, 0xd8, 1]), width: 390, height: 760 });
    },
    async stopScreencast() {
      calls.push('stop screencast');
      listener = null;
    },
    async setMobile(on) {
      calls.push(`mobile ${String(on)}`);
    },
    async passwordFocused() {
      return true;
    },
    async hasPasswordField() {
      return password;
    },
    async tap(x, y) {
      calls.push(`tap ${String(x)},${String(y)}`);
    },
    async scroll() {
      calls.push('scroll');
    },
    async insertText(text) {
      calls.push(`text ${'*'.repeat(text.length)}`);
      typed += 1;
      if (opts.loginAfter !== undefined && typed >= opts.loginAfter) password = false;
    },
    async key(name) {
      calls.push(`key ${name}`);
    },
    async settle() {},
  };
  return { session, calls, frame: () => listener };
};

const fakeApi = (
  batches: (HandoffInput[] | 'ended')[],
  start: { id: string } | { problem: string } = { id: 'h1' },
) => {
  const sent: { password: boolean }[] = [];
  const ends: string[] = [];
  const api: HandoffApi = {
    async start() {
      return start;
    },
    async frame(_id, f) {
      sent.push({ password: f.password });
    },
    async take() {
      const next = batches.shift();
      if (next === 'ended') return { inputs: [], ended: 'timed_out' };
      return { inputs: next ?? [], ended: null };
    },
    async end(_id, state) {
      ends.push(state);
    },
  };
  return { api, sent, ends };
};

const signal = new AbortController().signal;

describe('handing the browser to the person', () => {
  it('applies only their actions, and resumes when the password field is gone', async () => {
    const { session, calls } = fakeSession({ loginAfter: 2 });
    const { api, sent, ends } = fakeApi([
      [],
      [
        { type: 'tap', x: 100, y: 30 },
        { type: 'text', text: 'taro' },
      ],
      [
        { type: 'tap', x: 100, y: 90 },
        { type: 'text', text: 'secret' },
        { type: 'key', name: 'Enter' },
      ],
    ]);
    expect(
      await handOff(session, api, { requestId: 'r1', site: 'members.example.com', signal }),
    ).toEqual({
      end: 'resumed',
    });
    expect(calls).toEqual([
      'mobile true',
      'screencast',
      'tap 100,30',
      'text ****',
      'tap 100,90',
      'text ******',
      'key Enter',
      'stop screencast',
      'mobile false',
    ]);
    expect(sent[0]).toEqual({ password: true });
    expect(ends).toEqual(['resumed']);
  });

  it('resumes on 「Genie に戻す」, stops on 「やめる」 and on time out', async () => {
    const back = fakeApi([[{ type: 'done' }]]);
    expect(
      (
        await handOff(fakeSession().session, back.api, {
          requestId: 'r',
          site: 's.example',
          signal,
        })
      ).valueOf(),
    ).toEqual({ end: 'resumed' });
    const cancel = fakeApi([[{ type: 'cancel' }, { type: 'tap', x: 1, y: 1 }]]);
    const c = fakeSession();
    expect(
      await handOff(c.session, cancel.api, { requestId: 'r', site: 's.example', signal }),
    ).toEqual({ end: 'cancelled' });
    expect(c.calls).not.toContain('tap 1,1');
    expect(cancel.ends).toEqual(['cancelled']);
    const ended = fakeApi(['ended']);
    expect(
      await handOff(fakeSession().session, ended.api, {
        requestId: 'r',
        site: 's.example',
        signal,
      }),
    ).toEqual({ end: 'timed_out' });
    // 時計が先に尽きたら、取りに行かずに終える
    let t = 0;
    const late = fakeApi([[], [], []]);
    expect(
      await handOff(fakeSession().session, late.api, {
        requestId: 'r',
        site: 's.example',
        signal,
        limitMs: 10,
        now: () => (t += 20),
      }),
    ).toEqual({ end: 'timed_out' });
    expect(late.ends).toEqual(['timed_out']);
  });

  it('says why it could not ask, without opening anything to the person', async () => {
    const { api } = fakeApi([], { problem: 'LINE にログインのお願いを届けられませんでした。' });
    const { session, calls } = fakeSession();
    expect(await handOff(session, api, { requestId: 'r', site: 's.example', signal })).toEqual({
      problem: 'LINE にログインのお願いを届けられませんでした。',
    });
    expect(calls).toEqual([]);
  });
});

describe('reading a page behind a login', () => {
  it('hands over at the login wall, then reads the asked page again and answers', async () => {
    const { session, calls } = fakeSession({ loginAfter: 1 });
    const { api } = fakeApi([[{ type: 'text', text: 'pw' }]]);
    const asked: Record<string, unknown>[] = [];
    const runtime = new BrowserReadRuntime({
      ask: async (_tool, args) => {
        asked.push(args);
        return { answer: '会員向けのお知らせは 1 件です。' };
      },
      handoff: { api, open: async () => session },
    });
    const out = await runtime.run({
      id: 'req-1',
      toolId: 'browser.read_page',
      args: { url: 'https://members.example.com/news/1', question: 'このページを要約して' },
      approval: null,
    });
    expect(out).toMatchObject({
      ok: true,
      result: { read: true, title: '会員のお知らせ', answer: '会員向けのお知らせは 1 件です。' },
    });
    expect(calls.filter((c) => c.startsWith('goto'))).toEqual([
      'goto https://members.example.com/news/1',
      'goto https://members.example.com/news/1',
    ]);
    expect(calls.at(-1)).toBe('close');
    expect(asked[0]).toMatchObject({ title: '会員のお知らせ' });
  });

  it('leaves a masked screen at the login wall before asking, and again after reading', async () => {
    const { session } = fakeSession({ loginAfter: 1 });
    let shots = 0;
    session.maskedScreenshot = async () => {
      shots += 1;
      return { jpeg: Buffer.from([0xff, 0xd8, shots]), masked: 1 };
    };
    const { api } = fakeApi([[{ type: 'text', text: 'pw' }]]);
    const order: string[] = [];
    const snaps: { stage: string; site: string; masked: number }[] = [];
    const start = api.start.bind(api);
    api.start = async (id, site) => {
      order.push('start');
      return start(id, site);
    };
    api.snapshot = async (_req, snap) => {
      order.push(`snapshot ${snap.stage}`);
      snaps.push({ stage: snap.stage, site: snap.site, masked: snap.masked });
    };
    const runtime = new BrowserReadRuntime({
      ask: async () => ({ answer: '1 件です。' }),
      handoff: { api, open: async () => session },
    });
    await runtime.run({
      id: 'req-3',
      toolId: 'browser.read_page',
      args: { url: 'https://members.example.com/news/1', question: '要約して' },
      approval: null,
    });
    // ログインの画面はお願いより先に置く（お願いにその画面を添える）
    expect(order).toEqual(['snapshot login', 'start', 'snapshot read']);
    expect(snaps[0]).toEqual({ stage: 'login', site: 'members.example.com', masked: 1 });
  });

  it('sends no screen it could not mask, and keeps reading when the screen cannot be left', async () => {
    const { session } = fakeSession({ loginAfter: 0 });
    session.maskedScreenshot = async () => null;
    const { api } = fakeApi([]);
    const snaps: string[] = [];
    api.snapshot = async (_req, snap) => {
      snaps.push(snap.stage);
    };
    const runtime = new BrowserReadRuntime({
      ask: async () => ({ answer: 'x' }),
      handoff: { api, open: async () => session },
    });
    // 最初の読みでパスワード欄が無いページにする
    await session.insertText('x');
    const out = await runtime.run({
      id: 'req-4',
      toolId: 'browser.read_page',
      args: { url: 'https://members.example.com/news/1', question: '要約して' },
      approval: null,
    });
    expect(out).toMatchObject({ ok: true, result: { read: true } });
    expect(snaps).toEqual([]);
    // 置く口が落ちても、読むのは止めない
    session.maskedScreenshot = async () => ({ jpeg: Buffer.from([0xff, 0xd8]), masked: 0 });
    api.snapshot = async () => {
      throw new Error('gateway down');
    };
    const again = await runtime.run({
      id: 'req-5',
      toolId: 'browser.read_page',
      args: { url: 'https://members.example.com/news/1', question: '要約して' },
      approval: null,
    });
    expect(again).toMatchObject({ ok: true, result: { read: true } });
  });

  it('tells the person why when the login was not finished', async () => {
    const { session } = fakeSession();
    const { api } = fakeApi([[{ type: 'cancel' }]]);
    const runtime = new BrowserReadRuntime({
      ask: async () => ({ answer: 'x' }),
      handoff: { api, open: async () => session },
    });
    const out = await runtime.run({
      id: 'req-2',
      toolId: 'browser.read_page',
      args: { url: 'https://members.example.com/news/1', question: '要約して' },
      approval: null,
    });
    expect(out).toMatchObject({
      ok: true,
      result: { read: false, problem: 'ログインのお願いをやめました。' },
    });
  });
});

const executable = (await import('../src/browser-session.js')).browserExecutable();

describe.skipIf(!executable)('a real login through the handover', () => {
  it('lets the person log in on the real browser, then reads the members page', async () => {
    const { createServer } = await import('node:http');
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { BrowserSession } = await import('../src/browser-session.js');
    const profile = await mkdtemp(join(tmpdir(), 'genie-handoff-'));
    const posts: string[] = [];
    const server = createServer((req, res) => {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      if (req.method === 'POST') {
        let body = '';
        req.on('data', (c: Buffer) => (body += c.toString()));
        req.on('end', () => {
          posts.push(body);
          res.writeHead(303, { location: '/home', 'set-cookie': 'member=1; Path=/' });
          res.end();
        });
        return;
      }
      if (!(req.headers.cookie ?? '').includes('member=1')) {
        res.end(`<title>ログイン</title><form method="post" action="/login">
<input name="user" style="position:absolute;left:10px;top:10px;width:200px;height:40px">
<input name="pass" type="password" style="position:absolute;left:10px;top:70px;width:200px;height:40px">
<button style="position:absolute;left:10px;top:130px">ログイン</button></form>`);
        return;
      }
      res.end(
        `<title>会員のお知らせ</title><main>${'会員だけが読める本文です。'.repeat(20)}</main>`,
      );
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${String((server.address() as { port: number }).port)}`;
    const { api, sent, ends } = fakeApi([
      [
        { type: 'tap', x: 100, y: 30 },
        { type: 'text', text: 'taro' },
      ],
      [
        { type: 'tap', x: 100, y: 90 },
        { type: 'text', text: 'secret-pass' },
        { type: 'key', name: 'Enter' },
      ],
    ]);
    try {
      // 公開のアドレスだけを読む決まりは run の入口で見る。ここではテストの先（127.0.0.1）を直に開く
      const page = await readOrHandOff(
        {
          api,
          open: (s) =>
            BrowserSession.open({ executable, profileDir: profile, allow: () => true }, s),
        },
        `${base}/news`,
        'req-real',
        AbortSignal.timeout(60_000),
      );
      expect(page).toMatchObject({ title: '会員のお知らせ' });
      expect(posts).toEqual(['user=taro&pass=secret-pass']);
      expect(sent.length).toBeGreaterThan(0);
      expect(ends).toEqual(['resumed']);
    } finally {
      await new Promise((r) => server.close(r));
      await rm(profile, { recursive: true, force: true });
    }
  }, 90_000);
});

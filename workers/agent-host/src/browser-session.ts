/**
 * Genie 専用のブラウザの一回分（セッション）。読む（browser-read.ts）と、つまずいたときの引き継ぎ
 * （本人がスマホで画面を見て操作する。browser-handoff.ts）で同じものを使う。
 *
 *   - 本人の Chrome とは別のプロファイル（~/Library/Application Support/Genie/browser-profile）。画面に出さない
 *   - この Mac に入っているものを使う（Playwright が入れた画面なしの Chromium → Google Chrome の順）。新しく入れない
 *   - 動かすのは DevTools の口（Node の WebSocket）。外の部品は使わない
 *   - ページの中から読みに行く先は、許された先（既定は公開のアドレス）だけ。ダウンロードはさせない。ダイアログは閉じる
 *
 * 押す・入力するのは、本人が引き継いで操作しているときだけ（tap・scroll・insertText・key）。Genie は自分では押さない。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isPublicWebUrl } from '@genie/contracts';

export interface PageText {
  readonly finalUrl: string;
  readonly title: string;
  readonly text: string;
}

export const PROFILE_DIR = join(
  homedir(),
  'Library',
  'Application Support',
  'Genie',
  'browser-profile',
);

/**
 * 使うブラウザ。GENIE_BROWSER_EXECUTABLE → Playwright が入れた画面なしの Chromium（新しい版から）→ Google Chrome。
 * どれも無ければ null（新しく入れない）。
 */
export function browserExecutable(
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
  list: (dir: string) => string[] = (dir) => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  },
): string | null {
  const named = env['GENIE_BROWSER_EXECUTABLE']?.trim();
  if (named && exists(named)) return named;
  const cache = join(homedir(), 'Library', 'Caches', 'ms-playwright');
  const shells = list(cache)
    .map((d) => /^chromium_headless_shell-(\d+)$/.exec(d))
    .filter((m): m is RegExpExecArray => m !== null)
    .sort((a, b) => Number(b[1]) - Number(a[1]));
  for (const m of shells)
    for (const arch of ['chrome-headless-shell-mac-arm64', 'chrome-headless-shell-mac-x64']) {
      const path = join(cache, m[0], arch, 'chrome-headless-shell');
      if (exists(path)) return path;
    }
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  return exists(chrome) ? chrome : null;
}

export interface SessionOptions {
  readonly executable?: string | null;
  readonly profileDir?: string;
  /** ページの中から読みに行ってよい先（既定は公開のアドレスだけ）。 */
  readonly allow?: (url: string) => boolean;
  /** スマホで操作するときの画面の大きさ（無ければ既定の大きさ）。 */
  readonly mobile?: { readonly width: number; readonly height: number };
}

/** 画面の 1 枚（スクリーンキャスト）。 */
export interface Frame {
  readonly jpeg: Buffer;
  readonly width: number;
  readonly height: number;
}

const KEYS: Record<string, { key: string; code: string; keyCode: number }> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
};
export type SessionKey = keyof typeof KEYS;
export const SESSION_KEYS = Object.keys(KEYS) as SessionKey[];

export class BrowserSession {
  #frameListener: ((frame: Frame) => void) | null = null;

  private constructor(
    private readonly child: ChildProcess,
    private readonly cdp: Cdp,
    private readonly sessionId: string,
  ) {}

  /** ブラウザを起動し、空のページに付く。 */
  static async open(options: SessionOptions = {}, signal?: AbortSignal): Promise<BrowserSession> {
    const executable = options.executable === undefined ? browserExecutable() : options.executable;
    if (!executable) throw new Error('no_browser');
    const profile = options.profileDir ?? PROFILE_DIR;
    await mkdir(profile, { recursive: true, mode: 0o700 });
    const allow = options.allow ?? isPublicWebUrl;
    const stop = signal ?? new AbortController().signal;
    const child = spawn(
      executable,
      [
        '--headless=new',
        '--remote-debugging-port=0',
        `--user-data-dir=${profile}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--disable-sync',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-features=Translate,MediaRouter,OptimizationHints',
        '--deny-permission-prompts',
        '--mute-audio',
        '--hide-scrollbars',
        'about:blank',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let cdp: Cdp | null = null;
    try {
      const endpoint = await devtoolsEndpoint(child, stop);
      cdp = await Cdp.open(endpoint, stop);
      // ダウンロードはさせない
      await cdp.send('Browser.setDownloadBehavior', { behavior: 'deny' }).catch(() => undefined);
      const { targetId } = (await cdp.send('Target.createTarget', { url: 'about:blank' })) as {
        targetId: string;
      };
      const { sessionId } = (await cdp.send('Target.attachToTarget', {
        targetId,
        flatten: true,
      })) as { sessionId: string };
      const session = new BrowserSession(child, cdp, sessionId);
      const send = (method: string, params: Record<string, unknown> = {}) =>
        cdp!.send(method, params, sessionId);
      // ページの中から読みに行く先を 1 つずつ見る。公開でない先（Mac の中・家の中）は止める
      cdp.on((message) => {
        if (message.sessionId !== sessionId) return;
        if (message.method === 'Fetch.requestPaused') {
          const p = message.params as { requestId: string; request: { url: string } };
          const ok = /^(?:data|blob):/i.test(p.request.url) || allow(p.request.url);
          void send(
            ok ? 'Fetch.continueRequest' : 'Fetch.failRequest',
            ok
              ? { requestId: p.requestId }
              : { requestId: p.requestId, errorReason: 'BlockedByClient' },
          ).catch(() => undefined);
        } else if (message.method === 'Page.javascriptDialogOpening') {
          void send('Page.handleJavaScriptDialog', { accept: false }).catch(() => undefined);
        } else if (message.method === 'Page.screencastFrame') {
          const p = message.params as {
            data: string;
            sessionId: number;
            metadata: { deviceWidth: number; deviceHeight: number };
          };
          // 受け取ったと返さないと、次の 1 枚が来ない
          void send('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => undefined);
          session.#frameListener?.({
            jpeg: Buffer.from(p.data, 'base64'),
            width: p.metadata.deviceWidth,
            height: p.metadata.deviceHeight,
          });
        }
      });
      await send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
      await send('Page.enable');
      if (options.mobile)
        await send('Emulation.setDeviceMetricsOverride', {
          width: options.mobile.width,
          height: options.mobile.height,
          deviceScaleFactor: 2,
          mobile: true,
        });
      return session;
    } catch (error) {
      await cdp?.send('Browser.close').catch(() => undefined);
      cdp?.close();
      await exited(child);
      throw error;
    }
  }

  #send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return this.cdp.send(method, params, this.sessionId);
  }

  /** 開いて、読み込みが終わるまで待つ（描画のあと少しだけ待つ。スクリプトで本文を出すページがある）。 */
  async goto(url: string, signal: AbortSignal): Promise<void> {
    const navigated = (await this.#send('Page.navigate', { url })) as { errorText?: string };
    if (navigated.errorText) throw new Error(`navigate:${navigated.errorText}`);
    await this.settle(signal);
  }

  async settle(signal: AbortSignal, extraMs = 1200): Promise<void> {
    for (;;) {
      signal.throwIfAborted();
      const state = await evaluate((m, p) => this.#send(m, p), 'document.readyState');
      if (state === 'complete') break;
      await delay(250, signal);
    }
    await delay(extraMs, signal);
  }

  /** スマホの大きさにする・戻す（本人がスマホで操作するあいだだけ）。 */
  async setMobile(on: boolean): Promise<void> {
    if (on)
      await this.#send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 760,
        deviceScaleFactor: 2,
        mobile: true,
      });
    else await this.#send('Emulation.clearDeviceMetricsOverride');
  }

  /** 題名・表示されたアドレス・本文。 */
  async extract(): Promise<PageText> {
    const raw = await evaluate((m, p) => this.#send(m, p), EXTRACT);
    const page = JSON.parse(String(raw)) as { url: string; title: string; text: string };
    return { finalUrl: page.url, title: page.title, text: page.text };
  }

  /** いまの画面の 1 枚（JPEG）。 */
  async screenshot(): Promise<Buffer> {
    const out = (await this.#send('Page.captureScreenshot', { format: 'jpeg', quality: 70 })) as {
      data: string;
    };
    return Buffer.from(out.data, 'base64');
  }

  /** パスワードの欄が選ばれているか（このあいだは画面を残さない・知らせない）。 */
  async passwordFocused(): Promise<boolean> {
    return (
      (await evaluate(
        (m, p) => this.#send(m, p),
        "(() => { const a = document.activeElement; return !!a && a.tagName === 'INPUT' && (a.type || '').toLowerCase() === 'password'; })()",
      )) === true
    );
  }

  /** ページにパスワードの欄があるか（ログインの壁の目印）。 */
  async hasPasswordField(): Promise<boolean> {
    return (
      (await evaluate(
        (m, p) => this.#send(m, p),
        "!!document.querySelector('input[type=password]')",
      )) === true
    );
  }

  /** 画面の流れを始める。1 枚ごとに listener を呼ぶ。 */
  async startScreencast(listener: (frame: Frame) => void): Promise<void> {
    this.#frameListener = listener;
    await this.#send('Page.startScreencast', { format: 'jpeg', quality: 60, everyNthFrame: 1 });
  }

  async stopScreencast(): Promise<void> {
    this.#frameListener = null;
    await this.#send('Page.stopScreencast').catch(() => undefined);
  }

  /** 画面の (x, y)（CSS の画素）を押す。 */
  async tap(x: number, y: number): Promise<void> {
    for (const type of ['mousePressed', 'mouseReleased'])
      await this.#send('Input.dispatchMouseEvent', {
        type,
        x,
        y,
        button: 'left',
        clickCount: 1,
      });
  }

  async scroll(x: number, y: number, deltaX: number, deltaY: number): Promise<void> {
    await this.#send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY });
  }

  /** 選ばれている欄に文字を入れる（中身はどこにも残さない）。 */
  async insertText(text: string): Promise<void> {
    await this.#send('Input.insertText', { text });
  }

  async key(name: SessionKey): Promise<void> {
    const k = KEYS[name];
    if (!k) return;
    await this.#send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: k.key,
      code: k.code,
      windowsVirtualKeyCode: k.keyCode,
      ...(name === 'Enter' ? { text: '\r' } : {}),
    });
    await this.#send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: k.key,
      code: k.code,
      windowsVirtualKeyCode: k.keyCode,
    });
  }

  async close(): Promise<void> {
    this.#frameListener = null;
    await this.cdp.send('Browser.close').catch(() => undefined);
    this.cdp.close();
    await exited(this.child);
  }
}

/** 本文: article → main → body の順に、長さのあるものの文字だけ（見えている文）。 */
const EXTRACT = `(() => {
  const textOf = (el) => (el && el.innerText ? el.innerText : '');
  const pick = [document.querySelector('article'), document.querySelector('main')].find((el) => textOf(el).length > 200);
  return JSON.stringify({ url: location.href, title: document.title || '', text: textOf(pick || document.body) });
})()`;

async function evaluate(
  session: (method: string, params?: Record<string, unknown>) => Promise<unknown>,
  expression: string,
): Promise<unknown> {
  const out = (await session('Runtime.evaluate', { expression, returnByValue: true })) as {
    result?: { value?: unknown };
  };
  return out.result?.value;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason as Error);
      },
      { once: true },
    );
  });
}

/** 起動したブラウザが出す DevTools の口（標準エラーの「DevTools listening on ws://…」）。 */
function devtoolsEndpoint(child: ChildProcess, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    let seen = '';
    const done = (fn: () => void) => {
      child.stderr?.off('data', onData);
      child.off('exit', onExit);
      signal.removeEventListener('abort', onAbort);
      fn();
    };
    const onData = (chunk: Buffer) => {
      seen = (seen + chunk.toString('utf8')).slice(-4000);
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(seen);
      if (m) done(() => resolve(m[1]!));
    };
    const onExit = () => done(() => reject(new Error('browser_exited')));
    const onAbort = () => done(() => reject(signal.reason as Error));
    child.stderr?.on('data', onData);
    child.once('exit', onExit);
    child.once('error', onExit);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** 閉じるのを待つ（2 秒で閉じなければ強く止める）。 */
async function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const kill = setTimeout(() => child.kill('SIGKILL'), 2000);
    child.once('exit', () => {
      clearTimeout(kill);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

interface CdpMessage {
  readonly id?: number;
  readonly method?: string;
  readonly params?: unknown;
  readonly sessionId?: string;
  readonly result?: unknown;
  readonly error?: { message?: string };
}

/** DevTools の口の最小の相手（送って返事を待つ・知らせを受ける）。 */
class Cdp {
  readonly #ws: WebSocket;
  #id = 0;
  readonly #pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  readonly #listeners: ((message: CdpMessage) => void)[] = [];

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as CdpMessage;
      if (message.id !== undefined) {
        const waiting = this.#pending.get(message.id);
        this.#pending.delete(message.id);
        if (message.error) waiting?.reject(new Error(message.error.message ?? 'cdp_error'));
        else waiting?.resolve(message.result);
        return;
      }
      for (const listener of this.#listeners) listener(message);
    });
    ws.addEventListener('close', () => {
      for (const waiting of this.#pending.values()) waiting.reject(new Error('cdp_closed'));
      this.#pending.clear();
    });
  }

  static open(endpoint: string, signal: AbortSignal): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(endpoint);
      const onAbort = () => {
        ws.close();
        reject(signal.reason as Error);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      ws.addEventListener('open', () => {
        signal.removeEventListener('abort', onAbort);
        resolve(new Cdp(ws));
      });
      ws.addEventListener('error', () => reject(new Error('cdp_unreachable')));
    });
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> {
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  on(listener: (message: CdpMessage) => void): void {
    this.#listeners.push(listener);
  }

  close(): void {
    this.#ws.close();
  }
}

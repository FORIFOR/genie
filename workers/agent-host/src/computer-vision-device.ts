import { execFile } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, lstat, realpath, open, rm, chmod } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { visualContextDir, locateImages, readVisualImages } from './visual-context.js';
import {
  VisionFailure,
  frameOf,
  record,
  type VisionFrame,
  type GroundedAction,
} from './computer-vision-policy.js';
import type { VisionDevice } from './computer-vision.js';

/** A separate production helper, not ux-lab's unrestricted test-input executable. */
export class NativeVisionDevice implements VisionDevice {
  readonly #owned = new Set<string>();
  #root = '';
  #backgroundScope?: VisionFrame;
  constructor(readonly helper: string) {
    if (!isAbsolute(helper)) throw new VisionFailure('helper_path_required');
  }
  async claim(requestId: string): Promise<void> {
    this.#root = resolve(visualContextDir());
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    const rootStat = await lstat(this.#root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory() || rootStat.uid !== process.getuid?.())
      throw new VisionFailure('invalid_cache');
    this.#root = await realpath(this.#root);
    await chmod(this.#root, 0o700);
    const journal = join(this.#root, 'ComputerRuns');
    await mkdir(journal, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
    if ((await lstat(journal)).isSymbolicLink()) throw new VisionFailure('invalid_cache');
    const id = createHash('sha256').update(requestId).digest('hex');
    // Older managed previews used the ordinary shared cache. Moving screenshots to
    // isolated storage must not make an already-claimed request executable again.
    const legacy = join(homedir(), 'Library', 'Caches', 'Astra', 'VisualContext', 'ComputerRuns', `${id}.json`);
    if (legacy !== join(journal, `${id}.json`)) {
      try {
        await lstat(legacy);
        throw new VisionFailure('replay_blocked');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    let file;
    try {
      file = await open(join(journal, `${id}.json`), 'wx', 0o600);
    } catch {
      throw new VisionFailure('replay_blocked');
    }
    try {
      await file.writeFile(JSON.stringify({ status: 'started', at: Date.now() }) + '\n');
      await file.sync();
    } finally {
      await file.close();
    }
  }
  /*
   * 止まった理由を、その依頼の記録に 1 行足す。**記録そのものは置き換えない。**
   * この控えは再実行を阻む錠でもあるので、消したり作り直したりしてはいけない。
   */
  async stopped(requestId: string, code: string, audit: unknown[]): Promise<void> {
    if (!this.#root) return;
    const id = createHash('sha256').update(requestId).digest('hex');
    const file = await open(join(this.#root, 'ComputerRuns', `${id}.json`), 'a', 0o600);
    try {
      await file.writeFile(
        JSON.stringify({ status: 'stopped', at: Date.now(), code, audit: audit.slice(-12) }) + '\n',
      );
      await file.sync();
    } finally {
      await file.close();
    }
  }
  async begin(goal: string, recipient: string, signal: AbortSignal): Promise<VisionFrame> {
    return this.#capture({ op: 'begin', goal, recipient }, signal);
  }
  async capture(scope: VisionFrame, signal: AbortSignal): Promise<VisionFrame> {
    return this.#capture({ op: 'capture', scope }, signal);
  }
  /*
   * 人の手が止まったかを helper に訊く。**人には何もしない。**
   * 通れば helper 側で実行世代が 1 つ進んでいて、それ以前の写真は失効している。
   * まだ触っているときは `human_active` が返り、呼び出し側が待ち直す。
   */
  async resume(scope: VisionFrame, signal: AbortSignal): Promise<void> {
    if (!this.#root) throw new VisionFailure('session_not_claimed');
    const result = await this.#invoke(
      { op: 'resume', scope, referencePath: join(this.#root, `${scope.id}.png`) },
      signal,
    );
    if (result['status'] !== 'resumed') throw new VisionFailure('human_active');
  }
  async apply(
    frame: VisionFrame,
    action: GroundedAction,
    signal: AbortSignal,
    expiresAt: number,
  ): Promise<{ route?: string; effect?: string }> {
    const result = await this.#invoke(
      {
        op: 'apply',
        scope: frame,
        action,
        authorizationExpiresAt: expiresAt,
        referencePath: join(this.#root, `${frame.id}.png`),
      },
      signal,
    );
    if (result['status'] !== 'applied') throw new VisionFailure('input_unconfirmed');
    /*
     * helper が自分で確かめた分だけを持ち帰る。`confirmed` は、操作した対象そのものを
     * 読み直して変化を見たという意味で、画面を眺めた推測ではない。
     */
    const route = typeof result['route'] === 'string' ? result['route'] : undefined;
    const effect = result['effect'] === 'confirmed' ? 'confirmed' : 'unconfirmed';
    return { ...(route ? { route } : {}), effect };
  }
  async close(): Promise<void> {
    if (this.#backgroundScope) {
      await this.#invoke({ op: 'end', scope: this.#backgroundScope,
        referencePath: join(this.#root, `${this.#backgroundScope.id}.png`) }, AbortSignal.timeout(2000)).catch(() => undefined);
    }
    await Promise.all([...this.#owned].map((path) => rm(path, { force: true })));
  }
  async #capture(input: Record<string, unknown>, signal: AbortSignal): Promise<VisionFrame> {
    if (!this.#root) throw new VisionFailure('session_not_claimed');
    const id = `cv-${randomUUID()}`;
    const path = join(this.#root, `${id}.png`);
    this.#owned.add(path);
    this.#owned.add(path + '.snapshot.json');
    this.#owned.add(path + '.used');
    const result = await this.#invoke({ ...input, id, outputPath: path }, signal);
    const frame = frameOf(result, Date.now());
    if (frame.deliveryMode === 'background') this.#backgroundScope = frame;
    if (frame.id !== id) throw new VisionFailure('invalid_frame');
    const images = readVisualImages(locateImages([{ id, kind: 'screenshot', label: 'Computer' }]));
    const data = images[0]?.data;
    if (
      !data ||
      data.length < 24 ||
      data.readUInt32BE(16) !== frame.width ||
      data.readUInt32BE(20) !== frame.height ||
      createHash('sha256').update(data).digest('hex') !== frame.sha256
    )
      throw new VisionFailure('image_mismatch');
    return frame;
  }
  #invoke(input: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> {
    return new Promise((accept, reject) => {
      if (signal.aborted) {
        reject(new VisionFailure('cancelled'));
        return;
      }
      // Do not put typed text in argv, a shell, environment variables, or logs.
      const child = execFile(
        this.helper,
        [],
        {
          signal,
          /*
           * 対象を選ぶ 1 回だけは人の判断を待つ。120s では、画面の前にいない間に
           * 切れて `helper_unavailable` になる。実行全体の上限（既定 5 分）に合わせ、
           * それ以外の呼び出しは従来どおり短いまま——人を待たないので長くする理由がない。
           */
          timeout: input['op'] === 'begin' ? 300_000 : 120_000,
          maxBuffer: 256 * 1024,
          env: { HOME: process.env['HOME'] ?? '', PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' },
        },
        (error, stdout, stderr) => {
          /*
           * helper の `STAGE` 行だけを、頼まれたときに限って前へ流す。
           * 何をどの経路で送ったか・何に阻まれたかが分からないと直せない。
           * 行そのものに画面の中身も入力した文字も入らない（helper 側の約束）。
           */
          if (process.env['ASTRA_COMPUTER_STAGE_LOG'] === 'on')
            for (const line of String(stderr).split('\n'))
              if (line.startsWith('STAGE ')) process.stderr.write(line + '\n');
          let result: Record<string, unknown>;
          try {
            result = record(JSON.parse(stdout));
          } catch {
            reject(new VisionFailure('helper_unavailable'));
            return;
          }
          if (error || result['error']) {
            const code = String(result['error'] ?? 'helper_failed');
            /*
             * helper が返した符号を、そのまま持ち上げてよいかの検査。
             * **数字を弾いてはいけない。**`macos_14_4_required` のような正規の符号まで
             * `helper_failed` に潰れ、止まった理由が分からなくなっていた
             * （実測 2026-09-22: 数字付きの符号で止まった走行が、原因不明として残った）。
             * 任意の文字を通さないための検査なので、小文字・数字・下線だけを許す。
             */
            reject(new VisionFailure(/^[a-z0-9_]{1,50}$/.test(code) ? code : 'helper_failed'));
          } else {
            accept(result);
          }
        },
      );
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(JSON.stringify(input));
    });
  }
}

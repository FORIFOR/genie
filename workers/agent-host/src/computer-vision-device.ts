import { execFile } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, lstat, realpath, open, rm, chmod } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
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
  async begin(goal: string, recipient: string, signal: AbortSignal): Promise<VisionFrame> {
    return this.#capture({ op: 'begin', goal, recipient }, signal);
  }
  async capture(scope: VisionFrame, signal: AbortSignal): Promise<VisionFrame> {
    return this.#capture({ op: 'capture', scope }, signal);
  }
  async apply(
    frame: VisionFrame,
    action: GroundedAction,
    signal: AbortSignal,
    expiresAt: number,
  ): Promise<void> {
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
  }
  async close(): Promise<void> {
    await Promise.all([...this.#owned].map((path) => rm(path, { force: true })));
  }
  async #capture(input: Record<string, unknown>, signal: AbortSignal): Promise<VisionFrame> {
    if (!this.#root) throw new VisionFailure('session_not_claimed');
    const id = `cv-${randomUUID()}`;
    const path = join(this.#root, `${id}.png`);
    this.#owned.add(path);
    const result = await this.#invoke({ ...input, id, outputPath: path }, signal);
    const frame = frameOf(result, Date.now());
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
          timeout: 120_000,
          maxBuffer: 256 * 1024,
          env: { HOME: process.env['HOME'] ?? '', PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' },
        },
        (error, stdout) => {
          let result: Record<string, unknown>;
          try {
            result = record(JSON.parse(stdout));
          } catch {
            reject(new VisionFailure('helper_unavailable'));
            return;
          }
          if (error || result['error']) {
            const code = String(result['error'] ?? 'helper_failed');
            reject(new VisionFailure(/^[a-z_]{1,50}$/.test(code) ? code : 'helper_failed'));
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

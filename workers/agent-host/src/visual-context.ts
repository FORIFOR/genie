/**
 * 端末内の画像の受け渡し場所（キャッシュ）。スクショ自動コンテキスト（SCREENSHOT_CONTEXT_GATE）。
 *
 * 利用者が「これ何？」と尋ねた turn に添えたスクショは、Genie.app が `VisualContext/<id>.png` へ写す。
 * cloud を通るのは id とラベルだけで、**画素はこのフォルダから、端末で走るモデル呼び出しが読む。**
 * （そのモデルが cloud のもの — Claude Code = 利用者の Claude — なら、その瞬間にその画像だけがそこへ送られる。
 *   「画像は端末から出ない」とは言わない。開示は app 側の `VisualEgressPolicy`。）
 *
 * 置き場所は Genie.app（`VisualContextStore.handoverDirectory`）と同じ規約:
 *   `$ASTRA_VISUAL_CONTEXT_DIR` → `$ASTRA_DATA_ROOT/VisualContext` → `~/Library/Caches/Astra/VisualContext (compatibility path)`
 * ここが食い違うと、画像は在るのに「見つからない」になる。
 *
 * id は**そのままパスにしない**: 形を検査し、組み立てた正規パスが受け渡し場所の中にあることを確かめる
 * （`../`、絶対パス、外へ抜ける symlink はすべて「無い」扱い）。
 */
import {
  existsSync,
  realpathSync,
  openSync,
  closeSync,
  fstatSync,
  readSync,
  constants,
} from 'node:fs';
import { HttpLlmError, type HttpLlmImage } from './http-llm.js';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { assertRegistrationScreenshotPrivacy } from './registration-privacy.js';

/** cloud から来る 1 枚ぶん。形が違えば捨てる（id はファイル名になる）。 */
export interface ImageRef {
  readonly id: string;
  readonly kind: 'screenshot' | 'clipboard_image';
  readonly label: string;
}

const ID = /^[A-Za-z0-9-]{1,64}$/;

export function visualContextDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env['ASTRA_VISUAL_CONTEXT_DIR'];
  if (explicit && explicit.length > 0) return explicit;
  const root = env['ASTRA_DATA_ROOT'];
  if (root && root.length > 0) return join(root, 'VisualContext');
  return join(homedir(), 'Library', 'Caches', 'Astra', 'VisualContext');
}

/** args.images を読む。形が違うものは黙って落とす（id をパスに混ぜない）。 */
export function imageRefsOf(value: unknown): ImageRef[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): ImageRef[] => {
    const row = item as Record<string, unknown> | null;
    const id = row?.['id'];
    const kind = row?.['kind'];
    const label = row?.['label'];
    if (typeof id !== 'string' || !ID.test(id)) return [];
    if (kind !== 'screenshot' && kind !== 'clipboard_image') return [];
    return [{ id, kind, label: typeof label === 'string' && label.length > 0 ? label : id }];
  });
}

export interface LocatedImage extends ImageRef {
  readonly path: string;
  /** 端末に実体があり、正規パスが受け渡し場所の中にあるか。無ければモデルに「見た」と言わせない。 */
  readonly present: boolean;
}

export interface Fs {
  exists(path: string): boolean;
  /** symlink を解いた実パス。無ければ throw。 */
  realpath(path: string): string;
}

const realFs: Fs = { exists: existsSync, realpath: (p) => realpathSync(p) };

/**
 * id → 受け渡し場所の中の正規パス。中を指さなければ null。
 * `resolve` で `..` や絶対パスを潰し、実体があれば symlink も解いて外へ抜けていないことを見る。
 */
export function canonicalImagePath(id: string, dir: string, fs: Fs = realFs): string | null {
  if (!ID.test(id)) return null;
  const base = resolve(dir);
  const candidate = resolve(base, `${id}.png`);
  if (!candidate.startsWith(base + sep)) return null;
  if (fs.exists(candidate)) {
    try {
      const realBase = fs.realpath(base);
      const real = fs.realpath(candidate);
      if (!real.startsWith(realBase + sep)) return null;
    } catch {
      return null;
    }
  }
  return candidate;
}

/** id → 端末内のパス。存在しない / 外を指すものは present=false のまま返す（落とさない: 無いことを伝える）。 */
export function locateImages(
  refs: readonly ImageRef[],
  dir: string = visualContextDir(),
  fs: Fs = realFs,
): LocatedImage[] {
  return refs.map((ref) => {
    const path = canonicalImagePath(ref.id, dir, fs);
    if (path === null) return { ...ref, path: join(resolve(dir), `${ref.id}.png`), present: false };
    return { ...ref, path, present: fs.exists(path) };
  });
}

/** Recheck the handover boundary at read time; never silently answer without requested pixels. */
export function readVisualImages(images: readonly LocatedImage[]): HttpLlmImage[] {
  if (images.length > 4) throw new HttpLlmError('image_unavailable', 'Too many images');
  const privacyStamp = images.length ? assertRegistrationScreenshotPrivacy() : '';
  let bytes = 0;
  const loaded: HttpLlmImage[] = images.map((image) => {
    let fd: number | undefined;
    try {
      if (!image.present || canonicalImagePath(image.id, visualContextDir()) !== image.path)
        throw new Error('Image is no longer available');
      fd = openSync(image.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = fstatSync(fd);
      bytes += stat.size;
      if (!stat.isFile() || bytes > 20 * 1024 * 1024) throw new Error('Image exceeds the limit');
      const data = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < data.length) {
        const count = readSync(fd, data, offset, data.length - offset, offset);
        if (!count) throw new Error('Image changed during reading');
        offset += count;
      }
      if (
        readSync(fd, Buffer.alloc(1), 0, 1, data.length) !== 0 ||
        !data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
      )
        throw new Error('Invalid PNG');
      return { mimeType: 'image/png', data };
    } catch {
      throw new HttpLlmError('image_unavailable', 'The selected screenshot could not be loaded');
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  });
  if (images.length && assertRegistrationScreenshotPrivacy() !== privacyStamp)
    throw new HttpLlmError(
      'image_unavailable',
      '登録情報の保護状態が変わったため、画像の読み取りを中止しました。',
    );
  return loaded;
}

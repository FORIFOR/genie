/**
 * サーバに置く秘密（Oathra の接続トークン）の封。AES-256-GCM。
 *
 * 鍵は `GENIE_SECRET_KEY`（32 バイトを hex か base64 で）。**鍵が無ければ保存しない。**
 * 平文で置くくらいなら、繋げない方がよい。
 *
 * 封筒は版つき: `v1:<鍵 id>:<iv>:<tag>:<暗号文>`（base64url）。
 * 鍵を替えるときは新しい鍵を `GENIE_SECRET_KEY` に、古い鍵を `GENIE_SECRET_KEYS_OLD`
 * （カンマ区切り）に置く。読むときは鍵 id で選ぶので、古い封も開けられる。
 *
 * `aad` は「どの行の秘密か」。別の行へ封を写しても開かない。
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export interface SecretBox {
  /** 今の鍵の id。封筒に書かれ、ログに出してよい（鍵そのものではない）。 */
  readonly keyId: string;
  seal(plain: string, aad: string): string;
  open(sealed: string, aad: string): string;
}

/** 鍵が無い・壊れている。**黙って平文に落とさない。** */
export class SecretKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretKeyError';
  }
}

const VERSION = 'v1';

function parseKey(raw: string): Buffer {
  const text = raw.trim();
  const key = /^[0-9a-f]{64}$/i.test(text) ? Buffer.from(text, 'hex') : Buffer.from(text, 'base64');
  if (key.length !== 32) {
    throw new SecretKeyError(
      'GENIE_SECRET_KEY は 32 バイト（hex 64 文字か base64）にしてください。',
    );
  }
  return key;
}

/** 鍵の id は鍵から決める。設定を増やさずに、どの鍵で封じたかが分かる。 */
const keyIdOf = (key: Buffer) => createHash('sha256').update(key).digest('hex').slice(0, 12);

export function secretBox(current: string, old: readonly string[] = []): SecretBox {
  const key = parseKey(current);
  const keyId = keyIdOf(key);
  const keys = new Map<string, Buffer>([[keyId, key]]);
  for (const raw of old) {
    const k = parseKey(raw);
    keys.set(keyIdOf(k), k);
  }
  return {
    keyId,
    seal(plain, aad) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(aad, 'utf8'));
      const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return [
        VERSION,
        keyId,
        iv.toString('base64url'),
        tag.toString('base64url'),
        body.toString('base64url'),
      ].join(':');
    },
    open(sealed, aad) {
      const [version, id, iv, tag, body, ...rest] = sealed.split(':');
      if (version !== VERSION || !id || !iv || !tag || body === undefined || rest.length > 0) {
        throw new SecretKeyError('封の形が正しくありません。');
      }
      const k = keys.get(id);
      if (!k)
        throw new SecretKeyError(
          `鍵 ${id} が見つかりません（GENIE_SECRET_KEYS_OLD を確かめてください）。`,
        );
      const decipher = createDecipheriv('aes-256-gcm', k, Buffer.from(iv, 'base64url'));
      decipher.setAAD(Buffer.from(aad, 'utf8'));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      try {
        return Buffer.concat([
          decipher.update(Buffer.from(body, 'base64url')),
          decipher.final(),
        ]).toString('utf8');
      } catch {
        // 中身は出さない。壊れたのか、別の行の封なのかも区別しない
        throw new SecretKeyError('封を開けられませんでした。');
      }
    },
  };
}

/** 環境変数から。鍵が無ければ null（保存する経路は「使えない」と言う）。 */
export function secretBoxFromEnv(env: NodeJS.ProcessEnv): SecretBox | null {
  const current = env['GENIE_SECRET_KEY']?.trim();
  if (!current) return null;
  const old = (env['GENIE_SECRET_KEYS_OLD'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return secretBox(current, old);
}

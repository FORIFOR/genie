/**
 * OS の資格情報ストア。正本 §21。
 *
 * **トークンはこの端末から出ない。**サーバへ行くのは参照だけで、
 * 値を読むのはこのプロセスだけ。
 *
 * macOS では `security` を使う。ライブラリを足さないのは依存を惜しむからではなく、
 * **鍵を扱う経路を、外から読める短いコードにしておきたい**から。
 */
import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import type { SecretStore } from '@genie/oauth';

const run = promisify(execFile);

/** login keychain の中でこのアプリの項目を見分ける名前。 */
export const KEYCHAIN_SERVICE_PREFIX = 'com.astra.connector';

export class KeychainUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeychainUnavailable';
  }
}

function serviceFor(key: string): string {
  return `${KEYCHAIN_SERVICE_PREFIX}.${key}`;
}

/**
 * macOS の login keychain。
 *
 * `-w` で値だけを取る。項目が無ければ `security` は 44 で終わるので、
 * **それを「無い」として扱い、他の失敗と混ぜない。**
 * 混ぜると、keychain が開けないだけの状態が「未接続」に見え、
 * 利用者は繋ぎ直しを何度も試すことになる。
 */
export class MacKeychain implements SecretStore {
  readonly #account: string;
  /** 同じ項目への書き込みは 1 本ずつ（`security` の更新が並ぶと片方が「既に存在」で落ちる）。 */
  static readonly #writes = new Map<string, Promise<void>>();

  constructor(account: string) {
    this.#account = account;
  }

  async get(key: string): Promise<string | null> {
    try {
      const { stdout } = await run(
        'security',
        ['find-generic-password', '-a', this.#account, '-s', serviceFor(key), '-w'],
        { timeout: 30_000 },
      );
      return stdout.trimEnd();
    } catch (error) {
      if (isNotFound(error)) return null;
      throw new KeychainUnavailable(
        '接続情報を読めませんでした。macOSのキーチェーン確認を許可してから、もう一度試してください。',
      );
    }
  }

  async set(key: string, value: string): Promise<void> {
    /*
     * **値をコマンドの引数に置かない。**引数は他のプロセスから見え（ps）、失敗すると
     * エラー文に丸ごと入ってログへ出る（2026-10-07: 更新したトークンが host.log に出た）。
     * `security -i` へ標準入力で渡し、値は 16 進（-X）にして引用の崩れも避ける。
     * `-U` で既存を更新する。付けないと、繋ぎ直すたびに項目が増える。
     */
    const hex = Buffer.from(value, 'utf8').toString('hex');
    const line = `add-generic-password -U -a ${quoted(this.#account)} -s ${quoted(serviceFor(key))} -X ${hex}\n`;
    const slot = `${this.#account}\u0000${serviceFor(key)}`;
    const previous = MacKeychain.#writes.get(slot) ?? Promise.resolve();
    const write = previous
      .catch(() => undefined)
      .then(() => runWithInput('security', ['-i'], line, 30_000));
    MacKeychain.#writes.set(slot, write);
    try {
      await write;
    } catch (error) {
      // 失敗の詳細（コマンド行）には値が入りうるので、文に含めない。原因を追えるよう、
      // 16 進の連なりと引用部分を伏せた終了コードと stderr だけを 1 行残す（2026-10-12）。
      process.stderr.write(
        `${JSON.stringify({ level: 'warn', time: new Date().toISOString(), service: 'agent-host', msg: 'keychain write failed', detail: error instanceof Error ? error.message : 'unknown' })}\n`,
      );
      throw new KeychainUnavailable(
        '接続情報を保存できませんでした。macOSのキーチェーン確認を許可してから、もう一度試してください。',
      );
    } finally {
      if (MacKeychain.#writes.get(slot) === write) MacKeychain.#writes.delete(slot);
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await run('security', [
        'delete-generic-password',
        '-a',
        this.#account,
        '-s',
        serviceFor(key),
      ]);
    } catch (error) {
      // 無いものを消せなくても、結果は同じ
      if (!isNotFound(error)) throw error;
    }
  }
}

/** `security -i` の 1 語。空白や引用符を含む名前でも崩れないように二重引用で囲む。 */
function quoted(text: string): string {
  if (/["\\\n]/.test(text))
    throw new KeychainUnavailable('キーチェーンの項目名に使えない文字があります。');
  return `"${text}"`;
}

/** 標準入力に `input` を渡して実行する。失敗の理由には入力を含めない。 */
function runWithInput(
  command: string,
  args: string[],
  input: string,
  timeout: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { timeout }, (error, _stdout, stderr) => {
      const said = redactSecurityOutput(stderr);
      if (error)
        reject(
          new Error(
            `exit ${String((error as { code?: unknown }).code ?? '?')}${said ? `; ${said}` : ''}`,
          ),
        );
      else if (/error|failed|could not/i.test(stderr))
        reject(new Error(`security reported an error; ${said}`));
      else resolve();
    });
    child.stdin?.end(input);
  });
}

/**
 * `security` の出力から値になりうる部分を伏せる: 引用された語、数字や記号を含む 4 字以上の連なり。
 * 残るのは「何が起きたか」の語と終了コードだけ（200 字まで）。
 */
export function redactSecurityOutput(text: string): string {
  return text
    .replace(/"[^"]*"/g, '"…"')
    .replace(/'[^']*'/g, "'…'")
    .replace(/[A-Za-z0-9+/=_.-]{4,}/g, (word) => {
      const plain = word.replace(/\.$/, '');
      return /^[A-Za-z]+$/.test(plain) && plain.length <= 40 ? word : '…';
    })
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

function isNotFound(error: unknown): boolean {
  return (error as { code?: number }).code === 44;
}

/**
 * 資格情報ストアが無い環境。
 *
 * **黙って動くふりをしない。**読み書きしようとしたら断る。
 * ここで空を返すと、「繋いだのに毎回サインインを求められる」になり、
 * 原因が資格情報ストアだと分からない。
 */
export class NoKeychain implements SecretStore {
  async get(): Promise<string | null> {
    throw new KeychainUnavailable('この環境には資格情報ストアがありません。');
  }
  async set(): Promise<void> {
    throw new KeychainUnavailable('この環境には資格情報ストアがありません。');
  }
  async delete(): Promise<void> {
    throw new KeychainUnavailable('この環境には資格情報ストアがありません。');
  }
}

/**
 * ファイルに置く資格情報ストア。**検査と無人 harness のためだけ。**
 *
 * 専用のテスト identity のトークンを本人の login keychain に混ぜない（`run-work-context-live.sh`）。
 * 0600 で書き、読めなければ無いものとして扱う。既定では選ばれない —
 * `ASTRA_SECRET_STORE_FILE` を明示したときだけ。
 */
export class FileSecretStore implements SecretStore {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  async #read(): Promise<Record<string, string>> {
    try {
      const text = await readFile(this.#path, 'utf8');
      const parsed = JSON.parse(text) as unknown;
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
    } catch {
      return {};
    }
  }

  async #write(values: Record<string, string>): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    await writeFile(this.#path, JSON.stringify(values), { mode: 0o600 });
    await chmod(this.#path, 0o600);
  }

  async get(key: string): Promise<string | null> {
    return (await this.#read())[key] ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    const values = await this.#read();
    values[key] = value;
    await this.#write(values);
  }

  async delete(key: string): Promise<void> {
    const values = await this.#read();
    delete values[key];
    await this.#write(values);
  }
}

/** この端末で使えるものを選ぶ。**無いものを在るふりにしない。** */
export function keychainFor(
  platform: string,
  account: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): SecretStore {
  const file = env['ASTRA_SECRET_STORE_FILE'];
  if (file) return new FileSecretStore(file);
  return platform === 'darwin' ? new MacKeychain(account) : new NoKeychain();
}

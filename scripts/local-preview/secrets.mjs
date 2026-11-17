/**
 * Genie の API キー・鍵の置き場所は macOS のキーチェーン 1 か所（docs/SECRETS.ja.md）。
 * 読み書きは Genie.app 自身（`Genie --secret`）に頼む。`security` で読むと macOS がパスワードを求めるため。
 *
 * ここには「環境変数の名前 ↔ キーチェーンの名前」の表と、Genie.app を呼ぶ口だけを置く。
 */
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const DEFAULT_GENIE_APP = '/Applications/Genie.app/Contents/MacOS/Genie';

/** 環境変数の名前 → キーチェーンの名前（SecretCommand.items と同じ名前）。 */
export const SECRET_ENV = Object.freeze({
  LINE_CHANNEL_SECRET: 'line-channel-secret',
  LINE_CHANNEL_ACCESS_TOKEN: 'line-access-token',
  SLACK_BOT_TOKEN: 'slack-bot-token',
  SLACK_APP_TOKEN: 'slack-app-token',
  GENIE_CHANNEL_ACTION_SECRET: 'channel-action-secret',
  GENIE_SECRET_KEY: 'genie-secret-key',
  GENIE_UNDERSTAND_ANTHROPIC_API_KEY: 'anthropic',
  // Mac の「会話」と同じ Gemini のキー（二重に持たない）
  GENIE_CALL_GEMINI_API_KEY: 'gemini',
  // お店探し（LINE の「新橋でいい店ある？」）。Mac の「近くの店」と同じ Google Maps Platform のキー
  GENIE_PLACES_API_KEY: 'google-maps',
  // LINE の中継（公式アカウント 1 つ）につなぐ、この Genie の鍵（docs/LINE_HUB.ja.md）
  GENIE_LINE_HUB_CREDENTIAL: 'line-hub',
});

export function genieApp(env = process.env) {
  return env.GENIE_APP_EXECUTABLE || DEFAULT_GENIE_APP;
}

/** 名前の値。無ければ null。キーチェーンが開けないなどは投げる（「無い」と混ぜない）。 */
export async function readSecret(name, app = genieApp()) {
  try {
    const { stdout } = await run(app, ['--secret', 'get', name], {
      timeout: 30_000,
      maxBuffer: 65_536,
    });
    return stdout;
  } catch (error) {
    if (error && error.code === 44) return null;
    throw new Error(
      `キーチェーンから ${name} を読めませんでした（${error?.code ?? 'unknown'}）。Genie.app が新しいか確かめてください。`,
    );
  }
}

/** 値を書く（標準入力で渡す。引数に載せない）。 */
export function writeSecret(name, value, app = genieApp()) {
  return new Promise((resolve, reject) => {
    const child = spawn(app, ['--secret', 'set', name], { stdio: ['pipe', 'ignore', 'ignore'] });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`キーチェーンに ${name} を書けませんでした（${String(code)}）。`)),
    );
    child.stdin.end(value);
  });
}

export async function secretStatus(app = genieApp()) {
  const { stdout } = await run(app, ['--secret', 'status'], { timeout: 30_000 });
  return Object.fromEntries(
    stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split('\t')),
  );
}

/** プレビューの gateway に渡す鍵を、キーチェーンから集める（入っているものだけ）。 */
export async function secretEnvironment(read = readSecret) {
  const env = {};
  for (const [envName, name] of Object.entries(SECRET_ENV)) {
    const value = await read(name);
    if (value) env[envName] = value;
  }
  return env;
}

import { lstatSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { HttpLlmError } from './http-llm.js';

/** No secrets or window titles cross this read-only native privacy boundary. */
export function assertRegistrationScreenshotPrivacy(
  directory = join(homedir(), '.genie-computer-privacy'),
  helper = process.env['ASTRA_COMPUTER_VISION_HELPER'],
): string {
  try {
    let stat;
    try {
      stat = lstatSync(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw error;
    }
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0
    )
      throw new Error('Invalid privacy directory');
    const entries = readdirSync(directory).sort();
    if (entries.length === 0) return '';
    if (
      entries.length > 10_000 ||
      entries.some((name) => !/^[a-f0-9]{64}$/.test(name)) ||
      !helper ||
      !isAbsolute(helper)
    )
      throw new Error('Privacy status unavailable');
    const result = JSON.parse(
      execFileSync(helper, ['--privacy-status'], {
        timeout: 3000,
        maxBuffer: 4096,
        encoding: 'utf8',
        env: { HOME: homedir(), PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' },
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    ) as Record<string, unknown>;
    if (Object.keys(result).length !== 1 || result['blocked'] !== false)
      throw new Error('Registration capture is paused');
    if (readdirSync(directory).sort().join('\n') !== entries.join('\n'))
      throw new Error('Registration privacy changed while checking');
    // Markers are never deleted: callers can reject an in-flight read even if
    // a browser exits between creating a marker and the final active-state check.
    return entries.join('\n');
  } catch {
    throw new HttpLlmError(
      'image_unavailable',
      '登録用パスワードを保護するため、画面画像の読み取りを停止しています。登録画面を閉じ、ブラウザを終了・再起動してから再開してください。',
    );
  }
}

import { execFile } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { object } from './execution-policy.js';
/** No shell, no inherited API keys, no typed text in argv, no implicit retries. */
export function runExecutionHelper(
  command: string,
  input: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  if (!isAbsolute(command)) return Promise.reject(new Error('An absolute helper path is required'));
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      [],
      {
        timeout: 120_000,
        maxBuffer: 65536,
        env: {
          PATH: '/usr/bin:/bin',
          ...(process.env['HOME'] ? { HOME: process.env['HOME'] } : {}),
        },
        ...(signal ? { signal } : {}),
      },
      (error, stdout) => {
        if (error) {
          reject(new Error('Native field operation failed'));
          return;
        }
        try {
          const result = object(JSON.parse(stdout));
          if (!result) throw new Error('Invalid native result');
          resolve(result);
        } catch {
          reject(new Error('Native field result could not be read'));
        }
      },
    );
    child.stdin?.on('error', () => {});
    child.stdin?.end(JSON.stringify(input));
  });
}

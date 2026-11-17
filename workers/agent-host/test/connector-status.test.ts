import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { recordRenewalRejected } from '../src/connector-status.js';

describe('connector status for the Mac app', () => {
  it('keeps only fingerprints and times, merges entries, and stays private', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'connector-status-')), 'connector-status.json');
    await writeFile(path, '{broken');
    const now = () => new Date('2026-10-16T16:31:00Z');
    await recordRenewalRejected('com.astra.gmail', 'gmail', 'a'.repeat(32), { path, now });
    await recordRenewalRejected('com.astra.google-calendar', 'google-calendar', 'b'.repeat(32), {
      path,
      now,
    });
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      'com.astra.gmail/gmail': {
        fingerprint: 'a'.repeat(32),
        rejected_at: '2026-10-16T16:31:00.000Z',
      },
      'com.astra.google-calendar/google-calendar': {
        fingerprint: 'b'.repeat(32),
        rejected_at: '2026-10-16T16:31:00.000Z',
      },
    });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});

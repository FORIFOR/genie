import { mkdtemp, readFile, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { clearLiveScreen, liveScreenOf, writeLiveScreen } from '../src/live-screen.js';

const frame = {
  id: 'cv-1234',
  capturedAt: 1_700_000_000_000,
  width: 1280,
  height: 800,
  bundleId: 'com.apple.Safari',
  documentOrigin: 'https://www.mcdonalds.co.jp',
};

describe('the screen Genie is operating, for the app to show', () => {
  it('names only the latest checked image and where it is, readable only by this user', async () => {
    const root = await mkdtemp(join(tmpdir(), 'live-'));
    await writeLiveScreen(root, liveScreenOf(frame));
    const live = JSON.parse(await readFile(join(root, 'live.json'), 'utf8'));
    expect(live).toEqual({
      schema: 1,
      image: 'cv-1234.png',
      at: 1_700_000_000_000,
      width: 1280,
      height: 800,
      origin: 'https://www.mcdonalds.co.jp',
      bundleId: 'com.apple.Safari',
    });
    expect((await stat(join(root, 'live.json'))).mode & 0o777).toBe(0o600);
    // 書きかけの別名を残さない
    expect(await readdir(root)).toEqual(['live.json']);
  });

  it('leaves out the origin when the page did not report one', () => {
    const { documentOrigin: _omit, ...plain } = frame;
    expect(liveScreenOf(plain)).not.toHaveProperty('origin');
  });

  it('is removed when the run ends', async () => {
    const root = await mkdtemp(join(tmpdir(), 'live-'));
    await writeLiveScreen(root, liveScreenOf(frame));
    await clearLiveScreen(root);
    await clearLiveScreen(root); // 2 回目も失敗しない
    expect(await readdir(root)).toEqual([]);
  });
});

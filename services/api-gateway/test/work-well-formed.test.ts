import { describe, expect, it } from 'vitest';
import { wellFormed } from '../src/routes/work.js';

describe('work ingest text', () => {
  it('replaces half of an emoji cut by a truncation, and keeps everything else', () => {
    const cut = 'AI駆動開発ネタ、入ってます 😀'.slice(0, -1); // 片割れの \ud83d で終わる
    const fixed = wellFormed({ items: [{ title: cut, n: 1, tags: ['ok 😀', cut] }] }) as {
      items: { title: string; n: number; tags: string[] }[];
    };
    expect(fixed.items[0]!.title).toBe('AI駆動開発ネタ、入ってます �');
    expect(fixed.items[0]!.tags).toEqual(['ok 😀', 'AI駆動開発ネタ、入ってます �']);
    expect(fixed.items[0]!.n).toBe(1);
    expect(JSON.stringify(fixed)).not.toMatch(/\\ud83d"/);
  });
});

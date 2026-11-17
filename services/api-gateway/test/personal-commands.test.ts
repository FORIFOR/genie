/**
 * 決まった言い方（1:1・通話・Task Dock）。2026-10-26 のログから: 使った量の質問に答える。
 */
import { describe, expect, it } from 'vitest';
import type { DbHandle } from '@genie/db';
import type { UnderstandService } from '@genie/service-understand';
import { personalCommands } from '../src/understand.js';

const principal = { tenantId: 't', userId: 'u' };
const make = (usage: { usedSeconds: number; monthlyMinutes: number } | null) =>
  personalCommands({
    db: {} as DbHandle,
    understand: { handle: async () => null } as unknown as UnderstandService,
    timeZone: 'Asia/Tokyo',
    groups: { current: null },
    callUsage: async () => usage,
  });

describe('personal commands', () => {
  it('answers how much was used this month, without 「承知しました」 for a question', async () => {
    const answer = await make({ usedSeconds: 1250, monthlyMinutes: 60 }).handle(
      principal,
      'c',
      'どのくらいのクレジットを使いましたか？',
    );
    expect(answer?.answer).toContain(
      '今月の LINE の通話は 21 分使いました（上限 60 分、残り 39 分）',
    );
    expect(answer?.answer).toContain('Anthropic Console');
    expect(answer?.answer).not.toMatch(/承知しました|かしこまりました/);
    expect(
      (
        await make({ usedSeconds: 0, monthlyMinutes: 60 }).handle(
          principal,
          'c',
          '通話はあと何分使える？',
        )
      )?.answer,
    ).toContain('残り 60 分');
  });

  it('leaves other words and an unconfigured call alone', async () => {
    expect(
      await make({ usedSeconds: 0, monthlyMinutes: 60 }).handle(principal, 'c', '今日の天気は？'),
    ).toBeNull();
    expect(
      await make(null).handle(principal, 'c', 'どのくらいのクレジットを使いましたか？'),
    ).toBeNull();
  });

  it('explains in 1:1 that a board belongs to a group', async () => {
    for (const text of ['@Genie ボード', 'ボード', 'ボード見せて'])
      expect((await make(null).handle(principal, 'c', text))?.answer).toMatch(
        /^ボード（みんなの計画）はグループごとに作ります。.*「@Genie ボード」/,
      );
    expect(await make(null).handle(principal, 'c', 'ボードゲームのおすすめは？')).toBeNull();
  });
});

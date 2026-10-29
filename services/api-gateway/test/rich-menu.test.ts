/**
 * LINE のリッチメニューと「使い方」の答え。
 *
 * 見ること:
 *   - 4 つのボタンが送る文は、それぞれ受ける側（見通し・通話・予定・使い方）が本当に受ける言い方
 *   - 「使い方」に載せた言い方も、受ける側が受ける（書いてあるのに動かない、を出さない）
 *   - 押せる場所が画像の幅をすき間なく分ける
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { DbHandle } from '@genie/db';
import type { UnderstandService } from '@genie/service-understand';
import {
  CALL_REQUEST,
  RICH_MENU_BUTTONS,
  RICH_MENU_SIZE,
  richMenuBody,
} from '@genie/service-channels';
import {
  browserReadRequest,
  classifyCurrentInfo,
  parseCalendarIntent,
} from '@genie/service-conversation';
import { PERSONAL_HELP, personalCommands } from '../src/understand.js';
import { HOLD, OPEN_HOME, STATUS } from '../src/work-desk.js';

const NOW = new Date('2026-10-29T01:00:00Z');
const TZ = 'Asia/Tokyo';
const help = personalCommands({
  db: {} as DbHandle,
  understand: { handle: async () => null } as unknown as UnderstandService,
  timeZone: TZ,
  groups: { current: null },
});
const text = (label: string) => RICH_MENU_BUTTONS.find((b) => b.label === label)!.text;

describe('the LINE rich menu', () => {
  it('sends words that the right handler really takes', async () => {
    expect(RICH_MENU_BUTTONS.map((b) => b.label)).toEqual(['仕事', '電話', '予定', '使い方']);
    expect(STATUS.test(text('仕事'))).toBe(true);
    expect(CALL_REQUEST.test(text('電話'))).toBe(true);
    expect(parseCalendarIntent(text('予定'), NOW, TZ)).toMatchObject({ kind: 'agenda' });
    expect((await help.handle({ tenantId: 't', userId: 'u' }, 'c', text('使い方')))?.answer).toBe(
      PERSONAL_HELP,
    );
  });

  it('draws the same labels in the same order as the tappable areas', () => {
    const html = readFileSync(
      new URL('../../../scripts/line-rich-menu/menu.html', import.meta.url),
      'utf8',
    );
    const drawn = [
      ...html.matchAll(/<div class="label">([^<]+)<\/div><div class="hint">([^<]+)<\/div>/g),
    ];
    expect(drawn.map((m) => [m[1], m[2]])).toEqual(RICH_MENU_BUTTONS.map((b) => [b.label, b.hint]));
  });

  it('splits the whole width into four tappable areas', () => {
    const body = richMenuBody();
    expect(body.size).toEqual(RICH_MENU_SIZE);
    expect(body.areas.map((a) => a.bounds.x)).toEqual([0, 625, 1250, 1875]);
    expect(body.areas.reduce((sum, a) => sum + a.bounds.width, 0)).toBe(RICH_MENU_SIZE.width);
    expect(body.areas.every((a) => a.bounds.height === RICH_MENU_SIZE.height)).toBe(true);
    expect(body.areas.map((a) => a.action.type)).toEqual([
      'message',
      'message',
      'message',
      'message',
    ]);
  });
});

describe('the help answer', () => {
  it('lists only ways of asking that are taken', () => {
    expect(STATUS.test('今の作業どうなってる？')).toBe(true);
    expect(OPEN_HOME.test('仕事のホームを開いて')).toBe(true);
    expect(HOLD.test('〇〇は来週まで保留')).toBe(true);
    expect(CALL_REQUEST.test('電話して')).toBe(true);
    expect(parseCalendarIntent('今日の予定を教えて', NOW, TZ)).toMatchObject({ kind: 'agenda' });
    expect(parseCalendarIntent('打ち合わせを1時間早めて', NOW, TZ)).toMatchObject({
      kind: 'move',
    });
    expect(classifyCurrentInfo('明日の天気は？')).not.toBeNull();
    expect(browserReadRequest('https://example.com/a を読んで要約して')).not.toBeNull();
    for (const said of [
      '今の作業どうなってる？',
      '仕事のホームを開いて',
      '電話して',
      '今日の予定を教えて',
      '打ち合わせを1時間早めて',
    ])
      expect(PERSONAL_HELP).toContain(said);
  });

  it('answers 使い方 and its variants the same way, and nothing longer', async () => {
    const p = { tenantId: 't', userId: 'u' };
    for (const asked of ['使い方', '使い方？', 'ヘルプ', '何ができるの？', '@Genie 使い方'])
      expect((await help.handle(p, 'c', asked))?.answer, asked).toBe(PERSONAL_HELP);
    expect(await help.handle(p, 'c', 'このアプリの使い方を詳しく教えて')).toBeNull();
  });
});

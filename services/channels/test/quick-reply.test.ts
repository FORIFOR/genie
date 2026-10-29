/**
 * 確かめの「はい / いいえ」を、LINE のタップで送れるボタン（Quick Reply）にする（仕様 v1.0 §6.2）。
 */
import { describe, expect, it } from 'vitest';
import { choicesOf, lineMessages } from '../src/index.js';

describe('quick reply choices', () => {
  it('reads the choices at the end of a confirmation', () => {
    expect(
      choicesOf('家計簿に付けますか？ 食費 ¥2,480（10/22）\nはい / 修正する / いいえ'),
    ).toEqual(['はい', '修正する', 'いいえ']);
    expect(
      choicesOf(
        '10/21（水）12:08 に「動作確認」をお知らせします。\nよろしいですか？（はい / いいえ）',
      ),
    ).toEqual(['はい', 'いいえ']);
    expect(choicesOf('はい、こんにちは。')).toBeNull();
    expect(choicesOf('明日は晴れです。')).toBeNull();
  });

  it('puts them on the last LINE message, but not where approval buttons already answer', () => {
    const [m] = lineMessages({ text: '予定には入れますか？ はい / いいえ' }) as Record<
      string,
      unknown
    >[];
    expect(m).toMatchObject({
      type: 'text',
      quickReply: {
        items: [
          { type: 'action', action: { type: 'message', label: 'はい', text: 'はい' } },
          { type: 'action', action: { type: 'message', label: 'いいえ', text: 'いいえ' } },
        ],
      },
    });
    const withButtons = lineMessages({
      text: '確認してください：送ります はい / いいえ',
      buttons: [{ label: '送る', value: 'a1.x' }],
    }) as Record<string, unknown>[];
    expect(withButtons.some((x) => 'quickReply' in x)).toBe(false);
    expect(
      (lineMessages({ text: 'おはようございます。' })[0] as Record<string, unknown>)['quickReply'],
    ).toBeUndefined();
  });
});

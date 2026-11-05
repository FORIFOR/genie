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

describe('quick replies with their own label', () => {
  it('shows the label and sends the words', () => {
    const [message] = lineMessages({
      text: '承認を待っています',
      quickReplies: [{ label: '許可（今回だけ）', text: 'opencode を許可' }, '拒否'],
    }) as { quickReply: { items: { action: { label: string; text: string } }[] } }[];
    expect(message!.quickReply.items.map((i) => i.action)).toEqual([
      { type: 'message', label: '許可（今回だけ）', text: 'opencode を許可' },
      { type: 'message', label: '拒否', text: '拒否' },
    ]);
  });

  // Genie のブラウザの画面（隠したもの）は、文の前に画像のメッセージで
  it('puts an image before the text, only from https', () => {
    const withImage = lineMessages({
      text: 'Genie のブラウザの画面です。',
      image: { url: 'https://genie.example/v1/channels/snapshot/abc' },
    }) as { type: string; originalContentUrl?: string; previewImageUrl?: string }[];
    expect(withImage[0]).toEqual({
      type: 'image',
      originalContentUrl: 'https://genie.example/v1/channels/snapshot/abc',
      previewImageUrl: 'https://genie.example/v1/channels/snapshot/abc',
    });
    expect(withImage[1]).toMatchObject({ type: 'text', text: 'Genie のブラウザの画面です。' });
    const plain = lineMessages({
      text: '画面です。',
      image: { url: 'http://genie.example/x' },
    }) as { type: string }[];
    expect(plain.map((m) => m.type)).toEqual(['text']);
  });
});

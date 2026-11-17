/**
 * 答えに渡す直前の会話（仕様 v1.0 §5②）。新しいものを優先し、長い会話でも上限に収める。
 */
import { describe, expect, it } from 'vitest';
import { historyOf } from '../src/turn.js';

const t = (role: 'user' | 'assistant' | 'system', text: string, i: number) =>
  ({
    id: String(i),
    conversation_id: 'c',
    role,
    modality: 'text',
    text,
    interrupted: false,
    created_at: '',
  }) as never;

describe('recent conversation for answers', () => {
  it('keeps user and Genie lines in order, skipping system lines and blanks', () => {
    expect(
      historyOf([
        t('user', '明日の天気は？', 1),
        t('system', 'x', 2),
        t('assistant', '晴れです。', 3),
        t('user', ' ', 4),
      ]),
    ).toEqual([
      { role: 'user', text: '明日の天気は？' },
      { role: 'genie', text: '晴れです。' },
    ]);
  });

  it('prefers the newest lines within the limits', () => {
    const long = 'あ'.repeat(500);
    const lines = historyOf(
      Array.from({ length: 8 }, (_, i) =>
        t(i % 2 ? 'assistant' : 'user', `${String(i)}${long}`, i),
      ),
    );
    expect(lines.length).toBe(5);
    expect(lines.every((l) => l.text.length <= 300)).toBe(true);
    expect(lines.at(-1)!.text.startsWith('7')).toBe(true);
  });
});

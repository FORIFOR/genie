/**
 * 答えの Markdown → LINE の Flex Message。
 */
import { describe, expect, it } from 'vitest';
import { answerFlex, lineMessages, parseAnswer } from '../src/index.js';
import { channelMessages } from '../src/index.js';

const FLIGHTS = [
  '# 年末年始の便',
  '',
  '年末年始の熊本〜東京（羽田）間の便を調べました！',
  '',
  '安さを狙うなら、羽田発着では **ソラシドエア**（1日5往復・ANA共同運航）が一番の有力候補です。',
  '',
  '- **航空会社ごとの目安（片道）**',
  '  - **ソラシドエア**: 最安候補（2万〜3万円台後半が目安）',
  '  - **ANA / JAL**: 3万〜4万円台',
  '- 予約・空席確認リンク',
  '  - [ソラシドエア](https://www.solaseedair.jp/) / https://www.ana.co.jp/',
].join('\n');

type Json = Record<string, unknown>;
const all = (node: unknown, out: Json[] = []): Json[] => {
  if (Array.isArray(node)) node.forEach((n) => all(n, out));
  else if (node && typeof node === 'object') {
    out.push(node as Json);
    Object.values(node).forEach((v) => all(v, out));
  }
  return out;
};

describe('answer → Flex Message', () => {
  it('reads headings, bold, nested bullets and links', () => {
    const parsed = parseAnswer(FLIGHTS);
    expect(parsed.structured).toBe(true);
    // 先頭の見出し（答えの題）は落とす
    expect(parsed.blocks[0]).toMatchObject({ kind: 'paragraph' });
    const items = parsed.blocks.filter((b) => b.kind === 'item');
    expect(items.map((b) => [b.depth, b.marker])).toEqual([
      [0, '•'],
      [1, '–'],
      [1, '–'],
      [0, '•'],
      [1, '–'],
    ]);
    expect(parsed.links).toEqual([
      { label: 'ソラシドエア', url: 'https://www.solaseedair.jp/' },
      { label: 'https://www.ana.co.jp/', url: 'https://www.ana.co.jp/' },
    ]);
  });

  it('draws a dark bubble: bold as spans, bullets indented, links as buttons, plain text as altText', () => {
    const flex = answerFlex(FLIGHTS, '年末年始の熊本〜東京（羽田）間の便を調べました！')!;
    expect(flex).toMatchObject({
      type: 'flex',
      altText: '年末年始の熊本〜東京（羽田）間の便を調べました！',
    });
    const nodes = all(flex['contents']);
    expect(nodes.find((n) => n['type'] === 'bubble')).toMatchObject({
      styles: { body: { backgroundColor: '#2C2C2E' } },
    });
    expect(
      nodes.some(
        (n) => n['type'] === 'span' && n['text'] === 'ソラシドエア' && n['weight'] === 'bold',
      ),
    ).toBe(true);
    expect(nodes.some((n) => n['type'] === 'box' && n['paddingStart'] === '16px')).toBe(true);
    const buttons = nodes.filter((n) => n['type'] === 'button').map((n) => n['action']);
    expect(buttons).toEqual([
      { type: 'uri', label: 'ソラシドエア', uri: 'https://www.solaseedair.jp/' },
      { type: 'uri', label: 'www.ana.co.jp/', uri: 'https://www.ana.co.jp/' },
    ]);
    // 記号は本文に残さない
    expect(JSON.stringify(flex)).not.toContain('**');
    // LINE の text は空文字を許さない
    expect(
      nodes
        .filter((n) => n['type'] === 'text' || n['type'] === 'span')
        .every((n) => String(n['text']).length > 0),
    ).toBe(true);
  });

  it('keeps one-line answers as text messages', () => {
    expect(answerFlex('こんにちは。今日もお疲れさまです。', 'こんにちは。')).toBeNull();
    // 題の見出しだけの答え（あいさつ）も文のまま
    expect(
      answerFlex('# こんにちは\n\nこんにちは！今日は何をしましょうか？', 'こんにちは！'),
    ).toBeNull();
    expect(lineMessages(channelMessages.answer('こんにちは。'))).toEqual([
      { type: 'text', text: 'こんにちは。' },
    ]);
  });

  it('sends structured answers as Flex, and splits a long answer into a carousel', () => {
    const [first] = lineMessages(channelMessages.answer(FLIGHTS)) as Json[];
    expect(first).toMatchObject({ type: 'flex' });
    const long = Array.from(
      { length: 60 },
      (_, i) => `- **項目 ${String(i)}**: ${'説明の文。'.repeat(8)}`,
    ).join('\n');
    const flex = answerFlex(long, 'long')!;
    expect(flex['contents']).toMatchObject({ type: 'carousel' });
    const pages = (flex['contents'] as { contents: unknown[] }).contents;
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(10_000);
  });

  it('falls back to text when the answer is too long to read in a few bubbles', () => {
    const huge = Array.from(
      { length: 400 },
      (_, i) => `- **${String(i)}** ${'長い文。'.repeat(10)}`,
    ).join('\n');
    expect(answerFlex(huge, 'huge')).toBeNull();
    expect(lineMessages({ text: 'huge', markdown: huge })).toEqual([
      { type: 'text', text: 'huge' },
    ]);
  });

  it('keeps the link-button template for messages that open something', () => {
    const [m] = lineMessages({
      text: '通話を始めます',
      markdown: '**通話**',
      link: { label: '電話に出る', url: 'https://example.com/call' },
    }) as Json[];
    expect(m).toMatchObject({ type: 'template' });
  });
});

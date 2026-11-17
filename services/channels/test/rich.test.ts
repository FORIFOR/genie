/**
 * 答えの Markdown → LINE の文のメッセージ（部分コピーできる）と、Flex Message。
 */
import { describe, expect, it } from 'vitest';
import { answerFlex, answerText, lineMessages, parseAnswer } from '../src/index.js';
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

  it('keeps the Flex builder: a long answer splits into a carousel', () => {
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

  it('sends structured answers as copyable text (no Flex), with headings, bullets and links written out', () => {
    const messages = lineMessages(channelMessages.answer(FLIGHTS)) as Json[];
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ type: 'text' });
    expect(messages[0]!['text']).toBe(
      [
        '年末年始の熊本〜東京（羽田）間の便を調べました！',
        '',
        '安さを狙うなら、羽田発着では ソラシドエア（1日5往復・ANA共同運航）が一番の有力候補です。',
        '',
        '・ 航空会社ごとの目安（片道）',
        '　・ ソラシドエア: 最安候補（2万〜3万円台後半が目安）',
        '　・ ANA / JAL: 3万〜4万円台',
        '・ 予約・空席確認リンク',
        '　・ ソラシドエア（https://www.solaseedair.jp/） / https://www.ana.co.jp/',
      ].join('\n'),
    );
    expect(answerText('こうします。\n\n## 手順\n\n1. 開く\n2. 押す\n\n---\n\n終わり')).toEqual([
      'こうします。\n\n【手順】\n\n1. 開く\n2. 押す\n\n―――\n\n終わり',
    ]);
  });

  it('splits a long answer into several text messages, and cuts what does not fit', () => {
    const long = Array.from(
      { length: 60 },
      (_, i) => `- **項目 ${String(i)}**: ${'説明の文。'.repeat(20)}`,
    ).join('\n');
    const pages = answerText(long);
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) expect(page.length).toBeLessThanOrEqual(4_800);
    // 項目の途中で切らない
    expect(pages[1]!.startsWith('・ 項目')).toBe(true);
    const huge = Array.from(
      { length: 400 },
      (_, i) => `- **${String(i)}** ${'長い文。'.repeat(20)}`,
    ).join('\n');
    expect(answerFlex(huge, 'huge')).toBeNull();
    const cut = answerText(huge);
    expect(cut).toHaveLength(4);
    expect(cut[3]!.endsWith('…（続きは Genie で）')).toBe(true);
    // 確認のボタンがあるときは、ボタンの分を空けて 4 通まで（LINE は 1 回 5 通まで）
    const withButtons = lineMessages({
      text: 'huge',
      markdown: huge,
      buttons: [{ label: 'はい', value: 'yes' }],
    }) as Json[];
    expect(withButtons.length).toBeLessThanOrEqual(5);
    expect(withButtons.at(-1)).toMatchObject({ type: 'template' });
    expect(lineMessages({ text: 'huge', markdown: huge }).length).toBeLessThanOrEqual(5);
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

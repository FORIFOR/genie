/**
 * 報告の組み立て。正本 §8、UI/UX §15。
 *
 * ここで守るのは 1 点:
 * **結論からその根拠へ辿れること。**辿れない結論を載せると、
 * 「根拠つき」という約束そのものが嘘になる。
 */
import { describe, expect, it } from 'vitest';
import { asksForJudgment, composeReport } from '../src/service.js';

interface Row {
  id: string;
  claim: string;
  source_url: string;
  source_type: string;
  publisher: string | null;
  published_at: Date | null;
  retrieved_at: Date;
  quality_score: number;
  freshness_score: number;
  supports: string[];
  contradicts: string[];
}

const evidence: Row[] = [
  {
    id: 'e1',
    claim: '2025年3月期の売上高は2兆4,316億円',
    source_url: 'https://www.tel.co.jp/ir/a.pdf',
    source_type: 'filing',
    publisher: 'tel.co.jp',
    published_at: null,
    retrieved_at: new Date('2026-08-27T00:00:00Z'),
    quality_score: 0.9,
    freshness_score: 0.8,
    supports: [],
    contradicts: [],
  },
  {
    id: 'e2',
    claim: '前年比 32.8% 増',
    source_url: 'https://www.reuters.com/b',
    source_type: 'news',
    publisher: 'reuters.com',
    published_at: null,
    retrieved_at: new Date('2026-08-27T00:00:00Z'),
    quality_score: 0.7,
    freshness_score: 0.9,
    supports: [],
    contradicts: [],
  },
];

const run = { question: '東京エレクトロンの売上は？', confidence: 'medium' };

describe('the report', () => {
  it('shows, for each conclusion, the source it stands on', () => {
    const markdown = composeReport(
      run,
      [
        { text: '売上高は2兆4,316億円', supports: [0] },
        { text: '前年から伸びている', supports: [0, 1] },
      ],
      evidence as never,
    );

    expect(markdown).toContain('1. 売上高は2兆4,316億円');
    expect(markdown).toContain('根拠: [https://www.tel.co.jp/ir/a.pdf]');
    // 2 つの根拠に立つ結論は、2 つとも出す
    expect(markdown).toContain(
      '根拠: [https://www.tel.co.jp/ir/a.pdf](https://www.tel.co.jp/ir/a.pdf) / [https://www.reuters.com/b](https://www.reuters.com/b)',
    );
  });

  it('says it does not know, rather than writing a conclusion with no evidence', () => {
    const markdown = composeReport(run, [], evidence as never);
    expect(markdown).toContain('確かなことは分かりませんでした。');
    expect(markdown).not.toContain('根拠:');
  });

  it('counts one page once', () => {
    const twice: Row[] = [...evidence, { ...evidence[0]!, id: 'e3' }];
    const markdown = composeReport(run, [{ text: 'x', supports: [0] }], twice as never);
    // 同じページを 2 回引いて「3 sources」にしない
    expect(markdown).toContain('2 sources');
  });

  it('does not hide a contradiction it found', () => {
    const conflicting: Row[] = [
      { ...evidence[0]!, contradicts: ['e2'] },
      { ...evidence[1]!, contradicts: ['e1'] },
    ];
    const markdown = composeReport(run, [{ text: 'x', supports: [0] }], conflicting as never);
    expect(markdown).toContain('## 食い違い');
    // 1 件の食い違いを 2 件と書かない
    expect(markdown).toContain('contradictions: 1');
  });

  it('leaves out a source reference it cannot resolve', () => {
    // 番号が合わないものを、それらしい URL で埋めない
    const markdown = composeReport(run, [{ text: 'x', supports: [9] }], evidence as never);
    expect(markdown).toContain('1. x');
    expect(markdown).toMatch(/根拠: *\n|根拠: *$/m);
  });
});

describe('a judgment asked for alongside the facts', () => {
  it('is kept in its own section, after the facts, with the sources it stands on', () => {
    const markdown = composeReport(
      run,
      [{ text: '売上高は2兆4,316億円', supports: [0] }],
      evidence as never,
      [{ text: '前年比の伸びから、来期も増収が有力', supports: [0, 1] }],
    );
    const facts = markdown.indexOf('## 結論');
    const judgment = markdown.indexOf('## 見立て');
    expect(facts).toBeGreaterThanOrEqual(0);
    expect(judgment).toBeGreaterThan(facts);
    expect(markdown).toContain('結果を保証するものではありません');
    expect(markdown.slice(judgment)).toContain(
      '根拠: [https://www.tel.co.jp/ir/a.pdf](https://www.tel.co.jp/ir/a.pdf) / [https://www.reuters.com/b](https://www.reuters.com/b)',
    );
  });

  it('adds no judgment section when there is no judgment', () => {
    expect(composeReport(run, [], evidence as never)).not.toContain('## 見立て');
  });

  it('is asked for only when the question asks for a forecast, comparison or recommendation', () => {
    for (const question of [
      '次の日曜の重賞の予想をまとめて',
      '毎日王冠の有力馬は？',
      'どちらが良いか比較して',
      '来期の業績見通しは？',
      'おすすめのノートPCを調べて',
    ])
      expect(asksForJudgment(question), question).toBe(true);
    for (const question of ['東京エレクトロンの売上は？', '毎日王冠の距離を調べて', '明日の天気'])
      expect(asksForJudgment(question), question).toBe(false);
  });
});

it('names each source once per conclusion, however many claims came from it', () => {
  const markdown = composeReport(run, [{ text: 'x', supports: [0, 0, 1, 0] }], evidence as never);
  expect(markdown.match(/tel\.co\.jp\/ir\/a\.pdf\]/g)).toHaveLength(1);
});

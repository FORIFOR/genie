/**
 * 通話の議事録（LINE へ送る文）。モデルが書いたものと、モデルが無いときに組み立てるもの。
 */
import { describe, expect, it } from 'vitest';
import { callMinutesText, plainMinutes } from '../src/channels.js';
import { callNow, type CallRecord } from '../src/call.js';

const ENDED = new Date('2026-10-23T06:42:00Z'); // 15:42 JST

const record = (over: Partial<CallRecord> = {}): CallRecord => ({
  seconds: 130,
  reason: 'hangup',
  requests: [
    {
      request: 'メールの内容を整理して教えて。',
      status: 'answered',
      answer:
        'かしこまりました。Genieです。いま手元にはメールの本文や件名が届いていないため、内容は分かりません。整理したいメールの本文を貼っていただくか、対象を教えてください。',
    },
    {
      request: 'メールの内容を整理して教えて',
      status: 'answered',
      answer: '同じ答え',
    },
    { request: '明日の予定を確認して', status: 'accepted' },
    { request: '銀行に振り込んで', status: 'not_accepted' },
  ],
  lines: [],
  ...over,
});

describe('call minutes', () => {
  it('writes the model minutes under a dated heading, with who does what next', () => {
    const text = callMinutesText(
      record(),
      {
        topics: ['本日のメールの整理'],
        outcomes: ['Gmail の許可が無く、メールを読めなかった'],
        next: [
          { who: 'you', what: 'Genie の設定で Google をつなぎ直す' },
          { who: 'genie', what: '明日の予定の確認' },
        ],
      },
      ENDED,
      'Asia/Tokyo',
    )!;
    expect(text.split('\n')[0]).toBe('📞 通話の議事録（10/23 15:39〜・約 2 分）');
    expect(text).toContain('■ 話したこと\n・本日のメールの整理');
    expect(text).toContain('■ 決まったこと・答え\n・Gmail の許可が無く、メールを読めなかった');
    expect(text).toContain('・【あなた】Genie の設定で Google をつなぎ直す');
    expect(text).toContain('・【Genie】明日の予定の確認（終わったらこのトークに届きます）');
  });

  it('without a model, builds minutes from the requests: no duplicates, no preamble, nothing invented', () => {
    const m = plainMinutes(record());
    expect(m.topics).toEqual([
      'メールの内容を整理して教えて。',
      '明日の予定を確認して',
      '銀行に振り込んで',
    ]);
    expect(m.outcomes).toHaveLength(1);
    expect(m.outcomes[0]).toMatch(/^いま手元にはメールの本文や件名が届いていないため/);
    expect(m.outcomes[0]).not.toContain('かしこまりました');
    expect(m.outcomes[0]!.length).toBeLessThanOrEqual(90);
    expect(m.next).toEqual([
      { who: 'genie', what: '「明日の予定を確認して」を進めています' },
      { who: 'you', what: '「銀行に振り込んで」は受け付けられませんでした' },
    ]);
  });

  it('sends nothing for a short call with no requests, and the last words for a longer chat', () => {
    expect(
      callMinutesText(record({ seconds: 10, requests: [] }), null, ENDED, 'Asia/Tokyo'),
    ).toBeNull();
    const chat = callMinutesText(
      record({
        seconds: 60,
        requests: [],
        lines: [
          { role: 'user', text: 'こんにちは' },
          { role: 'genie', text: 'はい。こんにちは、今日もお疲れさまです。' },
        ],
      }),
      null,
      ENDED,
      'Asia/Tokyo',
    )!;
    expect(chat).toContain('最後に Genie が話したこと: こんにちは、今日もお疲れさまです。');
  });

  it('tells the call today’s date in the user’s time zone, not UTC', () => {
    // 2026-10-23 23:44 UTC は東京の 10/24（土）8:44
    expect(callNow(new Date('2026-10-23T23:44:00Z'), 'Asia/Tokyo')).toBe(
      'いまは 2026年10月24日(土) 8:44（Asia/Tokyo）です。今日・明日・曜日・時刻を聞かれたら、これを基準に答えてください。',
    );
  });
});

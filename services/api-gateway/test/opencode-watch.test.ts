/**
 * opencode の見守り: URL の読み方・間隔・次にすることの決め方（純粋関数）。
 */
import { describe, expect, it } from 'vitest';
import {
  DONE_MARK,
  decide,
  intervalFrom,
  isPrivateHost,
  nudgeText,
  parseOpencodeUrl,
  type SessionSnapshot,
} from '../src/opencode-watch.js';

const snap = (over: Partial<SessionSnapshot> = {}): SessionSnapshot => ({
  busy: false,
  waitingForUser: null,
  signature: 'msg_2:1000',
  lastAssistantText: '修正しました。',
  todos: [],
  ...over,
});

describe('opencode watch', () => {
  it('reads the server and session from the web UI URL the user pasted', () => {
    expect(
      parseOpencodeUrl(
        'http://100.98.145.90:4096/server/aHR0cDovLzEwMC45OC4xNDUuOTA6NDA5Ng/session/ses_eb404d33dffes0j002xXXw18a4 を10分ごとに見て',
      ),
    ).toEqual({
      baseUrl: 'http://100.98.145.90:4096',
      sessionId: 'ses_eb404d33dffes0j002xXXw18a4',
    });
    expect(parseOpencodeUrl('http://127.0.0.1:4096/session/ses_abc')).toEqual({
      baseUrl: 'http://127.0.0.1:4096',
      sessionId: 'ses_abc',
    });
  });

  it('only watches local, private and Tailscale addresses', () => {
    expect(parseOpencodeUrl('https://example.com/session/ses_abc')).toBeNull();
    // 画面の URL が外の サーバを指していても、外へは送らない
    const outside = Buffer.from('https://evil.example').toString('base64url');
    expect(parseOpencodeUrl(`http://127.0.0.1:4096/server/${outside}/session/ses_abc`)).toBeNull();
    for (const host of [
      '100.98.145.90',
      '10.0.0.2',
      '192.168.1.5',
      '172.20.0.1',
      'mac.local',
      'box.tail1234.ts.net',
    ])
      expect(isPrivateHost(host)).toBe(true);
    for (const host of ['8.8.8.8', '100.128.0.1', '172.32.0.1', 'example.com'])
      expect(isPrivateHost(host)).toBe(false);
  });

  it('takes the interval from the request, 10 minutes by default, within 5 minutes to 2 hours', () => {
    expect(intervalFrom('10分ごとに見て')).toBe(600);
    expect(intervalFrom('見守って')).toBe(600);
    expect(intervalFrom('1分ごと')).toBe(300);
    expect(intervalFrom('3時間おき')).toBe(7200);
    expect(intervalFrom('30分おきに')).toBe(1800);
  });

  it('leaves a working session alone and does not nudge while it waits for the user', () => {
    expect(decide(snap({ busy: true }), { lastSignature: null, idleNudges: 0 })).toEqual({
      kind: 'working',
    });
    expect(
      decide(snap({ waitingForUser: 'permission' }), { lastSignature: null, idleNudges: 0 }),
    ).toEqual({
      kind: 'waiting_user',
      what: 'permission',
    });
  });

  it('nudges a stopped session, and stops after three nudges without progress', () => {
    expect(decide(snap(), { lastSignature: null, idleNudges: 0 })).toEqual({
      kind: 'nudge',
      idleNudges: 0,
    });
    // 促したあとに新しい返答が来た = 進んだ
    expect(
      decide(snap({ signature: 'msg_3:2000' }), { lastSignature: 'msg_2:1000', idleNudges: 2 }),
    ).toEqual({
      kind: 'nudge',
      idleNudges: 0,
    });
    expect(decide(snap(), { lastSignature: 'msg_2:1000', idleNudges: 1 })).toEqual({
      kind: 'nudge',
      idleNudges: 2,
    });
    expect(decide(snap(), { lastSignature: 'msg_2:1000', idleNudges: 2 })).toEqual({
      kind: 'stalled',
    });
  });

  it('ends when the agent writes the done mark, or all todos are done after a nudge', () => {
    expect(
      decide(snap({ lastAssistantText: `テストも通りました。\n${DONE_MARK}` }), {
        lastSignature: null,
        idleNudges: 0,
      }),
    ).toEqual({ kind: 'done' });
    const todos = [
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'cancelled' },
    ];
    expect(decide(snap({ todos }), { lastSignature: 'msg_1:1', idleNudges: 0 })).toEqual({
      kind: 'done',
    });
    // 説明の中で【完了】に触れただけでは終わりとしない
    expect(
      decide(snap({ lastAssistantText: `終わったら${DONE_MARK}と書きます` }), {
        lastSignature: null,
        idleNudges: 0,
      }).kind,
    ).toBe('nudge');
  });

  it('asks the agent to verify and to mark the end', () => {
    expect(nudgeText(2)).toContain('続けてください');
    expect(nudgeText(2)).toContain(DONE_MARK);
    expect(nudgeText(2)).toContain('2 回目');
  });
});

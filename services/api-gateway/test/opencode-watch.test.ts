/**
 * opencode の見守り: URL の読み方・間隔・次にすることの決め方（純粋関数）。
 */
import { describe, expect, it } from 'vitest';
import {
  DONE_MARK,
  decide,
  lastFailedCheck,
  intervalFrom,
  isPrivateHost,
  nudgeText,
  parseOpencodeUrl,
  OpencodeClient,
  PERMISSION_BUTTONS,
  questionButtons,
  questionText,
  resolveAnswer,
  WATCH_QUESTION_ANSWER,
  type PendingQuestion,
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

const question = (over: Partial<PendingQuestion> = {}): PendingQuestion => ({
  id: 'que_1',
  question: 'Which linter?',
  options: ['flake8', 'mypy', 'ruff'],
  multiple: false,
  custom: true,
  count: 1,
  ...over,
});

describe('opencode questions from LINE', () => {
  const parse = (text: string) => {
    const m = WATCH_QUESTION_ANSWER.exec(text);
    return m ? { numbers: m[2] ?? null, words: m[1] ?? null } : null;
  };

  it('takes only a clear answer, not talk about opencode', () => {
    expect(parse('opencode 2')).toEqual({ numbers: '2', words: null });
    expect(parse('opencode １,３')).toEqual({ numbers: '１,３', words: null });
    expect(parse('opencode に答えて ruff です')).toEqual({ numbers: null, words: 'ruff です' });
    expect(parse('オープンコードの質問に回答 mypy')).toEqual({ numbers: null, words: 'mypy' });
    for (const text of ['opencode はどう？', 'opencode を許可', 'opencode 見守って', '2'])
      expect(parse(text), text).toBeNull();
  });

  it('turns numbers and words into what opencode expects', () => {
    expect(resolveAnswer(question(), '2', null)).toEqual({ labels: ['mypy'] });
    expect(resolveAnswer(question(), '４', null)).toHaveProperty('error');
    expect(resolveAnswer(question(), '0', null)).toHaveProperty('error');
    expect(resolveAnswer(question(), '1,2', null)).toHaveProperty('error');
    expect(resolveAnswer(question({ multiple: true }), '１、3', null)).toEqual({
      labels: ['flake8', 'ruff'],
    });
    expect(resolveAnswer(question(), null, 'RUFF')).toEqual({ labels: ['ruff'] });
    expect(resolveAnswer(question(), null, 'pylint を使う')).toEqual({ labels: ['pylint を使う'] });
    expect(resolveAnswer(question({ custom: false }), null, 'pylint')).toHaveProperty('error');
  });

  it('shows the question and how to answer, and sends several questions to the screen', () => {
    const shown = questionText('opencode', question());
    expect(shown).toContain('Which linter?');
    expect(shown).toContain('3. ruff');
    expect(shown).toContain('opencode 1');
    expect(questionText('opencode', question({ count: 2 }))).toContain('画面で');
  });

  it('offers buttons that send the same words as typing', () => {
    expect(PERMISSION_BUTTONS.map((b) => b.text)).toEqual(['opencode を許可', 'opencode を拒否']);
    expect(questionButtons(question())[2]).toEqual({ label: '3. ruff', text: 'opencode 3' });
    expect(questionButtons(question({ count: 2 }))).toEqual([]);
    // 押した文が、そのまま答えの言い方に合う
    for (const b of questionButtons(question()))
      expect(WATCH_QUESTION_ANSWER.test(b.text), b.text).toBe(true);
  });

  it('reads the waiting question and replies in the form the server takes', async () => {
    const calls: { url: string; body: string | undefined }[] = [];
    const respond = (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body as string | undefined });
      if (url.endsWith('/question'))
        return [
          { id: 'que_other', sessionID: 'ses_other', questions: [{ question: 'x', options: [] }] },
          {
            id: 'que_1',
            sessionID: 'ses_a',
            questions: [{ question: 'Which?', options: [{ label: 'ruff' }], multiple: false }],
          },
        ];
      if (url.endsWith('/session/status')) return { ses_a: { type: 'idle' } };
      return url.endsWith('/reply') ? true : [];
    };
    const client = new OpencodeClient(
      'http://op',
      (async (url: string, init?: RequestInit) =>
        new Response(JSON.stringify(respond(String(url), init)))) as typeof fetch,
    );
    const snapshot = await client.snapshot('ses_a');
    expect(snapshot.waitingForUser).toBe('question');
    expect(snapshot.question).toMatchObject({ id: 'que_1', options: ['ruff'], custom: true });
    await client.answerQuestion('que_1', ['ruff']);
    const reply = calls.at(-1)!;
    expect(reply.url).toBe('http://op/question/que_1/reply');
    expect(JSON.parse(reply.body!)).toEqual({ answers: [['ruff']] });
  });
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

  it('does not call a claimed completion finished while the last test fails', () => {
    const marked = snap({
      lastAssistantText: '【完了】',
      failedCheck: 'pytest tests/test_modes.py',
    });
    expect(decide(marked, { lastSignature: null, idleNudges: 0 })).toEqual({
      kind: 'done_unverified',
      command: 'pytest tests/test_modes.py',
    });
    expect(
      decide(snap({ lastAssistantText: '【完了】' }), { lastSignature: null, idleNudges: 0 }).kind,
    ).toBe('done');
  });

  it('reads the result of the last test run', () => {
    const run = (command: string, exit: number) => ({
      parts: [
        {
          type: 'tool',
          tool: 'bash',
          state: { status: 'completed', input: { command }, metadata: { exit } },
        },
      ],
    });
    // 実機（2026-11-01）: 失敗のあとに編集の失敗だけがあって【完了】
    expect(
      lastFailedCheck([
        run('source venv/bin/activate && pytest tests/test_modes.py', 2),
        {
          parts: [
            { type: 'tool', tool: 'edit', state: { status: 'error' } },
            { type: 'text', text: '【完了】' },
          ],
        },
      ]),
    ).toBe('source venv/bin/activate && pytest tests/test_modes.py');
    expect(lastFailedCheck([run('pytest', 2), run('pytest', 0)])).toBeNull();
    expect(lastFailedCheck([run('ls missing', 1)])).toBeNull();
    expect(lastFailedCheck([])).toBeNull();
  });

  it('承認待ちの間は busy でも本人待ち（固まったと扱わない）', () => {
    expect(
      decide(snap({ busy: true, waitingForUser: 'permission' }), {
        lastSignature: null,
        idleNudges: 0,
      }),
    ).toEqual({ kind: 'waiting_user', what: 'permission' });
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

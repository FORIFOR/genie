/**
 * Claude Code の承認を LINE から（src/agent-approvals.ts・routes/agent-sessions.ts・channels の #actAgent）。
 *
 * 見ること:
 *   - 許可の問いが来たら、本人の LINE にカード（秘密は伏せる）。LINE をつないでいなければ作らない（Mac の問いだけ）
 *   - 承認・拒否・指示を添える の答えが、hooks の待ちにそのまま返る（Claude Code へ渡す JSON）
 *   - ほかの人・改ざん・二度押し・同時押し・期限切れ・Mac で答え済み は通さない
 *   - Mac で答えた（同じ入力の PostToolUse が来た）ら取り下げ、hooks は何も返さずに終わる
 *   ./infra/db/with-test-db.sh pnpm --filter @genie/service-api-gateway test
 */
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type TokenResponse, uuidv7 } from '@genie/contracts';
import { withTenant } from '@genie/db';
import { makeTestApp, makeTokens, testDbConfig, type TestApp } from './support.js';
import { describePermission, redactSecrets, type AgentApprovals } from '../src/agent-approvals.js';
import { registerWorkHomeRoutes } from '../src/routes/work-home.js';
import type { WorkDesk } from '../src/work-desk.js';
import { WorkLinkStore } from '../src/work-home.js';

const url = process.env['TEST_DATABASE_URL'];
const identityUrl = process.env['TEST_IDENTITY_DATABASE_URL'];
const LINE_SECRET = 'line-channel-secret';
const ROOT = '/Users/taro/Projects/genie';
type HookAnswer = {
  hookSpecificOutput: { hookEventName: string; decision: { behavior: string; message?: string } };
};
// ほかの試験の LINE の人（Uline など）と重ならない人
const ME = `Uapproval${uuidv7().replace(/-/g, '')}`;

type Sent = { url: string; body: Record<string, unknown> };

describe('redaction and the card text', () => {
  it('hides keys, passwords and tokens before anything leaves the Mac', () => {
    const said = redactSecrets(
      [
        'export ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnop',
        'curl -H "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJlMTIz"',
        'mysql -u root --password=hunter22 db',
        'git clone https://taro:ghp_abcdefghijklmnopqrstuvwxyz0123@github.com/x/y',
        'AWS_SECRET_ACCESS_KEY="wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"',
        '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n-----END OPENSSH PRIVATE KEY-----',
      ].join('\n'),
    );
    for (const secret of ['sk-ant', 'eyJ', 'hunter22', 'taro:', 'ghp_', 'wJalr', 'b3BlbnNzaC1rZXk'])
      expect(said).not.toContain(secret);
    // 何をしようとしているかは読める
    expect(said).toContain('export ANTHROPIC_API_KEY=');
    expect(said).toContain('mysql -u root --password=');
    expect(said).toContain('github.com/x/y');
    // ふつうのコマンドはそのまま
    expect(redactSecrets('pnpm test -- --run src/app.test.ts')).toBe(
      'pnpm test -- --run src/app.test.ts',
    );
  });

  it('says what each tool is about to do', () => {
    expect(
      describePermission('Bash', { command: 'rm -rf dist', description: 'Remove build output' }),
    ).toEqual({
      summary: 'コマンドを実行: Remove build output',
      details: [{ label: 'コマンド', value: 'rm -rf dist' }],
    });
    expect(
      describePermission('Edit', {
        file_path: '/Users/x/genie/src/app.ts',
        old_string: 'a',
        new_string: 'b',
      }),
    ).toEqual({
      summary: 'ファイルを書き換え: app.ts',
      details: [
        { label: 'ファイル', value: '/Users/x/genie/src/app.ts' },
        { label: '消す', value: 'a' },
        { label: '入れる', value: 'b' },
      ],
    });
    expect(describePermission('mcp__x__y', { token: 'abc' }).summary).toBe('mcp__x__y を使う');
  });
});

describe.skipIf(!url)('Claude Code approvals from LINE', () => {
  let harness: TestApp;
  let clock = Date.now();
  const sent: Sent[] = [];
  /** 次の LINE への送信を 1 回だけ落とす（つながらない）。 */
  let dropNextPush = false;
  const fetchImpl = vi.fn(async (target: string, init?: RequestInit) => {
    if (dropNextPush && target.endsWith('/message/push')) {
      dropNextPush = false;
      throw new TypeError('fetch failed');
    }
    sent.push({
      url: target,
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    });
    return Response.json({});
  });
  let auth: { authorization: string };
  let hookAuth: { authorization: string };
  let tenantId: string;
  let userId: string;
  let serial = 0;

  const texts = (since: number) =>
    sent
      .slice(since)
      .filter((s) => !s.url.endsWith('/chat/loading/start'))
      .map((s) => String((s.body['messages'] as { text?: string }[] | undefined)?.[0]?.text ?? ''));
  const waitFor = async (check: () => boolean, label: string) => {
    for (let i = 0; i < 150; i += 1) {
      if (check()) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`timed out: ${label}`);
  };
  const webhook = (event: Record<string, unknown>, user = ME) => {
    const raw = JSON.stringify({
      destination: 'Ubot',
      events: [
        {
          mode: 'active',
          timestamp: Date.now(),
          webhookEventId: `E${String(++serial)}`,
          replyToken: `rt-${String(serial)}`,
          source: { type: 'user', userId: user },
          ...event,
        },
      ],
    });
    const signature = createHmac('sha256', LINE_SECRET).update(raw).digest('base64');
    return harness.app.inject({
      method: 'POST',
      url: '/v1/channels/line/webhook',
      headers: { 'content-type': 'application/json', 'x-line-signature': signature },
      payload: raw,
    });
  };
  /** ボタンを押して、その押下への返事（同じ replyToken）を待つ。 */
  const press = async (data: string, user = ME) => {
    const token = `rt-${String(serial + 1)}`;
    const reply = () =>
      sent.find((s) => s.body['replyToken'] === token)?.body['messages'] as
        { text?: string }[] | undefined;
    await webhook({ type: 'postback', postback: { data } }, user);
    await waitFor(() => Boolean(reply()), `answer to ${data.slice(0, 6)}`);
    return String(reply()![0]!.text ?? '');
  };
  const say = async (text: string) => {
    const before = sent.length;
    await webhook({ type: 'message', message: { type: 'text', id: `m${String(serial)}`, text } });
    await waitFor(() => texts(before).some(Boolean), `reply to ${text}`);
    return texts(before).filter(Boolean)[0]!;
  };

  /** Claude Code の hooks の代わり。カードを出せたら id とボタンを返す（200 はその場の答え）。 */
  const ask = async (
    toolInput: Record<string, unknown>,
    sessionId = 'sess-1',
    cwd = `${ROOT}/services/api`,
  ) => {
    const before = sent.length;
    const res = await harness.app.inject({
      method: 'POST',
      url: '/v1/agent-approvals/claude-code',
      headers: hookAuth,
      payload: {
        hook_event_name: 'PermissionRequest',
        session_id: sessionId,
        cwd,
        tool_name: 'Bash',
        tool_input: toolInput,
        permission_mode: 'default',
        prompt_id: `p-${sessionId}`,
      },
    });
    if (res.statusCode !== 201)
      return {
        status: res.statusCode,
        id: '',
        card: JSON.stringify(sent.slice(before)),
        buttons: null,
        answer: res.statusCode === 200 ? res.json<HookAnswer>() : null,
      };
    const card = JSON.stringify(sent.slice(before));
    const values = [...card.matchAll(/c1\.[A-Za-z0-9._-]+/g)].map((m) => m[0]);
    const pick = (code: string) => values.find((v) => v.split('.')[3] === code);
    return {
      status: 201,
      id: res.json<{ id: string }>().id,
      card,
      buttons: {
        allow: pick('A')!,
        deny: pick('R')!,
        instruct: pick('I')!,
        session: pick('S'),
        project: pick('P'),
      },
      answer: null,
    };
  };
  /** Claude Code の非同期の hooks の代わり。 */
  const event = (payload: Record<string, unknown>) =>
    harness.app.inject({
      method: 'POST',
      url: '/v1/agent-events/claude-code',
      headers: hookAuth,
      payload,
    });
  const wait = (id: string, waitMs = 0) =>
    harness.app.inject({
      method: 'POST',
      url: `/v1/agent-approvals/${id}/wait`,
      headers: hookAuth,
      payload: { wait_ms: waitMs },
    });
  const stateOf = async (id: string) =>
    withTenant(harness.db, tenantId, (tx) =>
      tx
        .selectFrom('agent_approvals')
        .select(['state', 'with_instruction'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow(),
    );

  beforeAll(async () => {
    harness = await makeTestApp({
      dbConfig: testDbConfig(url!, identityUrl),
      tokens: await makeTokens(),
      channels: {
        env: {
          LINE_CHANNEL_SECRET: LINE_SECRET,
          LINE_CHANNEL_ACCESS_TOKEN: 'line-token',
          GENIE_CHANNEL_ACTION_SECRET: 'a'.repeat(40),
        },
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
      // 仕事のホームの承認ルールのページ（承認は harness ができてから決まるので、呼ばれたときに引く）
      configure: (app) =>
        registerWorkHomeRoutes(app, {
          desk: {} as WorkDesk,
          links: {
            byToken: (t: string) => new WorkLinkStore(harness.db).byToken(t),
          } as WorkLinkStore,
          approvals: new Proxy({} as AgentApprovals, {
            get: (_t, key) => {
              const a = harness.agentApprovals!;
              const v = (a as unknown as Record<string | symbol, unknown>)[key];
              return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(a) : v;
            },
          }),
        }),
      agentApprovals: {
        now: () => new Date(clock),
        // git の代わり: ROOT の下は genie（main）
        projectOf: async (cwd) =>
          cwd.startsWith(ROOT) ? { root: ROOT, name: 'genie', branch: 'main' } : null,
      },
    });
    const issued = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/dev/token',
      payload: { email: `a-${uuidv7()}@example.com`, display_name: 'A' },
    });
    const access = issued.json<TokenResponse>().access_token;
    auth = { authorization: `Bearer ${access}` };
    tenantId = (
      JSON.parse(Buffer.from(access.split('.')[1]!, 'base64url').toString()) as { tid: string }
    ).tid;
    const connection = await harness.app.inject({
      method: 'POST',
      url: '/v1/agent-connections',
      headers: auth,
      payload: { source: 'claude_code' },
    });
    hookAuth = { authorization: `Bearer ${connection.json<{ token: string }>().token}` };
    userId = (await harness.app.inject({ method: 'GET', url: '/v1/me', headers: auth })).json<{
      user: { id: string };
    }>().user.id;
  });

  afterAll(async () => {
    await harness?.close();
  });

  it('leaves the question to the Mac until LINE is linked', async () => {
    expect((await ask({ command: 'ls' })).status).toBe(204);
    // 鍵の無い hooks は受けない
    const stranger = await harness.app.inject({
      method: 'POST',
      url: '/v1/agent-approvals/claude-code',
      headers: { authorization: 'Bearer gac_nope' },
      payload: {},
    });
    expect(stranger.statusCode).toBe(401);

    const code = await harness.app.inject({
      method: 'POST',
      url: '/v1/channels/link-codes',
      headers: auth,
      payload: { provider: 'line' },
    });
    expect(await say(code.json<{ message: string }>().message)).toContain('連携しました');
  });

  it('sends a card without secrets and hands the approval back to Claude Code once', async () => {
    const asked = await ask({
      command: 'ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnop pnpm deploy',
      description: 'Deploy the gateway',
    });
    expect(asked.status).toBe(201);
    expect(asked.card).toContain('Claude Codeが承認を待っています（#');
    expect(asked.card).toContain('pnpm deploy');
    expect(asked.card).not.toContain('sk-ant');
    expect(asked.card).not.toContain('/Users/taro');
    // デプロイは毎回確認（継続許可のボタンは出さない）
    expect(asked.card).toContain('高（毎回確認: 本番・デプロイに触る）');
    expect(asked.buttons!.session).toBeUndefined();
    expect(asked.buttons!.project).toBeUndefined();
    expect((await wait(asked.id)).statusCode).toBe(202);

    // ほかの人・改ざんした印は通らない
    expect(await press(asked.buttons!.allow, 'Ustranger')).toContain('操作できません');
    expect(await press(asked.buttons!.deny.replace(/\.R\./, '.A.'))).toContain('操作できません');
    expect((await stateOf(asked.id)).state).toBe('pending');

    // 待っている hooks に答えが届く
    const waiting = wait(asked.id, 5000);
    // 同時に 2 回押しても、通るのは 1 回だけ
    const answers = await Promise.all([press(asked.buttons!.allow), press(asked.buttons!.allow)]);
    expect(answers.filter((a) => a.includes('承認を受け付けました'))).toHaveLength(1);
    expect(answers.filter((a) => a.includes('もう済んでいます'))).toHaveLength(1);
    const answered = await waiting;
    expect(answered.statusCode).toBe(200);
    expect(answered.json()).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    });
    expect(await press(asked.buttons!.deny)).toContain('もう済んでいます');
    expect((await stateOf(asked.id)).state).toBe('allowed');
  });

  it('passes the next LINE message to Claude Code as the reason when asked to add an instruction', async () => {
    const asked = await ask({ command: 'git push origin main' });
    expect(await press(asked.buttons!.instruct)).toContain('指示を送ってください');
    expect((await wait(asked.id)).statusCode).toBe(202);
    expect(await say('push はまだしないで、テストだけ流して')).toContain(
      '指示を Claude Code に渡しました',
    );
    const answered = (await wait(asked.id)).json<{
      hookSpecificOutput: { decision: { behavior: string; message: string } };
    }>();
    expect(answered.hookSpecificOutput.decision.behavior).toBe('deny');
    expect(answered.hookSpecificOutput.decision.message).toContain(
      'push はまだしないで、テストだけ流して',
    );
    expect(await stateOf(asked.id)).toEqual({ state: 'denied', with_instruction: true });
    // 指示を渡したあとの文は、ふつうの会話に戻る
    expect(await say('ありがとう')).not.toContain('指示を Claude Code に渡しました');
  });

  it('denies with a plain refusal', async () => {
    const asked = await ask({ command: 'rm -rf ~/Downloads' });
    expect(await press(asked.buttons!.deny)).toContain('拒否しました');
    const answered = (await wait(asked.id)).json<{
      hookSpecificOutput: { decision: { behavior: string } };
    }>();
    expect(answered.hookSpecificOutput.decision.behavior).toBe('deny');
  });

  it('withdraws the card when the question was answered on the Mac', async () => {
    const input = { command: 'pnpm test', description: 'Run tests' };
    const asked = await ask(input, 'sess-mac');
    const waiting = wait(asked.id, 5000);
    // Mac で承認して実行された（非同期の hooks が同じ入力の PostToolUse を送ってくる）
    const event = await harness.app.inject({
      method: 'POST',
      url: '/v1/agent-events/claude-code',
      headers: hookAuth,
      payload: {
        hook_event_name: 'PostToolUse',
        session_id: 'sess-mac',
        tool_name: 'Bash',
        tool_input: input,
      },
    });
    expect(event.statusCode).toBe(202);
    // hooks は何も返さずに終わる（Mac の答えのまま）
    expect((await waiting).statusCode).toBe(204);
    expect(await press(asked.buttons!.allow)).toContain('Mac で答え済み');
    expect((await stateOf(asked.id)).state).toBe('answered_on_mac');

    // 別の入力の PostToolUse では取り下げない。次の頼み（UserPromptSubmit）が来たら取り下げる
    const other = await ask({ command: 'pnpm lint' }, 'sess-mac');
    await harness.app.inject({
      method: 'POST',
      url: '/v1/agent-events/claude-code',
      headers: hookAuth,
      payload: {
        hook_event_name: 'PostToolUse',
        session_id: 'sess-mac',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
      },
    });
    expect((await wait(other.id)).statusCode).toBe(202);
    await harness.app.inject({
      method: 'POST',
      url: '/v1/agent-events/claude-code',
      headers: hookAuth,
      payload: { hook_event_name: 'UserPromptSubmit', session_id: 'sess-mac', prompt: '次へ' },
    });
    expect((await wait(other.id)).statusCode).toBe(204);
  });

  it('keeps waiting when the card could not be sent yet, and the resent card still works', async () => {
    dropNextPush = true;
    const asked = await ask({ command: 'pnpm build' });
    // 送れなかったが、outbox が送り直す。待ちは閉じない（Mac の問いでも答えられる）
    expect(asked.status).toBe(201);
    expect(asked.buttons?.allow).toBeUndefined();
    expect((await wait(asked.id)).statusCode).toBe(202);
    // 送り直しの時刻（最初は 5 秒後）を今にして、見回りを回す
    await withTenant(harness.db, tenantId, (tx) =>
      tx
        .updateTable('channel_outbox')
        .set({ next_attempt_at: new Date(0) })
        .where('tenant_id', '=', tenantId)
        .execute(),
    );
    const before = sent.length;
    await harness.channels!.service.pump(tenantId);
    const resent = JSON.stringify(sent.slice(before));
    const allow = [...resent.matchAll(/c1\.[A-Za-z0-9._-]+/g)]
      .map((m) => m[0])
      .find((v) => v.split('.')[3] === 'A')!;
    expect(await press(allow)).toContain('承認を受け付けました');
    expect((await wait(asked.id)).statusCode).toBe(200);
  });

  it('refuses a press after the card expired, and the hook gives the question back to the Mac', async () => {
    const asked = await ask({ command: 'make release' });
    clock += 10 * 60_000;
    try {
      expect(await press(asked.buttons!.allow)).toContain('期限切れ');
      expect((await wait(asked.id)).statusCode).toBe(204);
      expect((await stateOf(asked.id)).state).toBe('expired');
    } finally {
      clock = Date.now();
    }
  });

  it('shows which project and work it is for, and reports back once Claude Code really ran it', async () => {
    await event({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'sess-ctx',
      cwd: `${ROOT}/services/api`,
      prompt: '請求書の PDF を作る機能を直して\n詳細は…',
    });
    const input = { command: 'touch out-line.txt', description: 'Create marker file' };
    const asked = await ask(input, 'sess-ctx');
    expect(asked.status).toBe(201);
    // カードの行（見出しと値）
    for (const [label, value] of [
      ['プロジェクト', 'genie（main）'],
      ['作業', '請求書の PDF を作る機能を直して'],
      ['タスク', 'タスク未紐付け'],
      ['実行する場所', 'services/api'],
      ['操作の種類', 'プロジェクト内にファイルを作成（既にあれば時刻だけ更新）'],
      ['リスク', '低'],
    ])
      expect(asked.card).toContain(
        `"text":"${label}","wrap":false,"color":"#AEAEB2","flex":0,"size":"sm"},{"type":"text","text":"${value}"`,
      );
    expect(asked.buttons!.session).toBeDefined();
    expect(asked.buttons!.project).toBeDefined();

    const before = sent.length;
    expect(await press(asked.buttons!.allow)).toContain('実行を確かめたら知らせます');
    // 押しただけでは「実行した」とは言わない
    expect(texts(before).join('\n')).not.toContain('実行しました');
    expect((await wait(asked.id)).statusCode).toBe(200);
    expect(
      await event({
        hook_event_name: 'PostToolUse',
        session_id: 'sess-ctx',
        tool_name: 'Bash',
        tool_input: input,
      }).then((r) => r.statusCode),
    ).toBe(202);
    await waitFor(
      () => texts(before).some((t) => t.includes('✓ Claude Code が実行しました')),
      'result',
    );
    const row = await withTenant(harness.db, tenantId, (tx) =>
      tx
        .selectFrom('agent_approvals')
        .select(['state', 'decided_at', 'delivered_at', 'result', 'prompt_id', 'operation', 'risk'])
        .where('id', '=', asked.id)
        .executeTakeFirstOrThrow(),
    );
    expect(row).toMatchObject({
      state: 'allowed',
      result: 'executed',
      prompt_id: 'p-sess-ctx',
      operation: 'create_file',
      risk: 'low',
    });
    expect(row.decided_at).not.toBeNull();
    expect(row.delivered_at).not.toBeNull();
  });

  it('lets the person allow the same kind of safe operation in this project from now on, and take it back', async () => {
    const first = await ask({ command: 'touch a.txt' }, 'sess-r1');
    expect(await press(first.buttons!.project!)).toContain('このプロジェクトでは');
    expect((await wait(first.id)).statusCode).toBe(200);

    // 別のセッションでも、同じプロジェクトの同じ種類はカードを出さずにその場で許可
    const before = sent.length;
    const again = await ask({ command: 'touch b.txt' }, 'sess-r2', `${ROOT}/web`);
    expect(again.status).toBe(200);
    expect(again.answer!.hookSpecificOutput.decision.behavior).toBe('allow');
    expect(sent.length).toBe(before);
    const audit = await withTenant(harness.db, tenantId, (tx) =>
      tx
        .selectFrom('agent_approvals')
        .select(['state', 'rule_id'])
        .where('external_session_id', '=', 'sess-r2')
        .executeTakeFirstOrThrow(),
    );
    expect(audit.state).toBe('auto_allowed');
    expect(audit.rule_id).not.toBeNull();

    // 同じ「作る」でもプロジェクトの外・別の種類・毎回確認の操作は聞く
    expect((await ask({ command: 'touch /tmp/x' }, 'sess-r3')).status).toBe(201);
    expect(
      (await ask({ command: 'touch c.txt' }, 'sess-r4', '/Users/taro/Projects/other')).status,
    ).toBe(201);
    expect((await ask({ command: 'git push' }, 'sess-r5')).status).toBe(201);

    const listed = await say('承認ルール');
    expect(listed).toContain('1. プロジェクト genie：プロジェクト内にファイルを作成');
    expect(listed).toContain('自動で許可 1 回');
    expect(await say('承認ルール 1 を取り消して')).toContain('取り消しました');
    expect((await ask({ command: 'touch d.txt' }, 'sess-r6')).status).toBe(201);
    expect(await say('承認ルール')).toContain('承認ルールはありません');
  });

  it('shows the rules and the approval history on the work home, where a rule can be taken back', async () => {
    const first = await ask({ command: 'pnpm lint' }, 'sess-h1');
    expect(await press(first.buttons!.project!)).toContain('このプロジェクトでは');
    expect((await ask({ command: 'pnpm lint' }, 'sess-h2')).status).toBe(200);

    const token = /\/v1\/channels\/work\/([A-Za-z0-9_-]{32})$/.exec(
      `/v1/channels/work/${await new WorkLinkStore(harness.db).issue(tenantId, userId, new Date())}`,
    )?.[1];
    const page = (path: string, method: 'GET' | 'POST' = 'GET') =>
      harness.app.inject({ method, url: `/v1/channels/work/${token!}${path}` });
    const listed = (await page('/rules')).json<{
      rules: { id: string; label: string; scope: string; useCount: number }[];
      history: { operation: string; answer: string; auto: boolean; result: string | null }[];
    }>();
    expect(listed.rules).toEqual([
      expect.objectContaining({ label: 'テスト・ビルド・型の確認', scope: 'project', useCount: 1 }),
    ]);
    expect(listed.history.slice(0, 2)).toEqual([
      expect.objectContaining({
        operation: 'テスト・ビルド・確認',
        answer: '自動で許可（承認ルール）',
        auto: true,
      }),
      expect.objectContaining({ answer: 'LINE で承認', auto: false }),
    ]);
    // 中身（コマンド）は返さない
    expect(JSON.stringify(listed)).not.toContain('pnpm lint');

    expect((await page(`/rules/${listed.rules[0]!.id}/revoke`, 'POST')).statusCode).toBe(204);
    expect((await page(`/rules/${listed.rules[0]!.id}/revoke`, 'POST')).statusCode).toBe(404);
    expect((await page('/rules')).json<{ rules: unknown[] }>().rules).toEqual([]);
    expect((await ask({ command: 'pnpm lint' }, 'sess-h3')).status).toBe(201);
    // 知らないリンクでは見せない
    expect(
      (
        await harness.app.inject({
          method: 'GET',
          url: `/v1/channels/work/${'x'.repeat(32)}/rules`,
        })
      ).statusCode,
    ).toBe(410);
  });

  it('keeps a session permission to that session and ends it with the session', async () => {
    const first = await ask({ command: 'pnpm test' }, 'sess-s1');
    expect(await press(first.buttons!.session!)).toContain('このセッションの間');
    expect((await ask({ command: 'pnpm test' }, 'sess-s1')).status).toBe(200);
    expect((await ask({ command: 'pnpm test' }, 'sess-s2')).status).toBe(201);
    await event({ hook_event_name: 'SessionEnd', session_id: 'sess-s1', reason: 'exit' });
    expect((await ask({ command: 'pnpm test' }, 'sess-s1')).status).toBe(201);
  });

  it('never makes a standing permission for an operation that must always be asked', async () => {
    const asked = await ask({ command: 'git push origin main' }, 'sess-n1');
    expect(await harness.agentApprovals!.decide(tenantId, userId, asked.id, 'allow_project')).toBe(
      'not_ruleable',
    );
    expect((await stateOf(asked.id)).state).toBe('pending');
    expect(await say('承認ルール')).toContain('承認ルールはありません');
  });
});

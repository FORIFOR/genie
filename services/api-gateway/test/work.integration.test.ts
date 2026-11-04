/**
 * Work Context の HTTP 契約（WORK_CONTEXT_GATE の cloud 側）。
 *   ./infra/db/with-test-db.sh pnpm --filter @genie/service-api-gateway test
 *
 * 見るのは:
 *   - 端末の worker が push した artifact から、案件・待ち・返すもの・週の負荷が組まれ、全部に出所がある
 *   - 訂正は 1 操作、推測の停止も 1 操作
 *   - chat lane の問いに `<work_context>` が添えられる（仕事の問いだけ、上限つき）。無関係な問いには添えない
 *   - メール全文は受け取らない（抜粋の上限 500 字）
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TokenResponse, uuidv7 } from '@genie/contracts';
import { makeTestApp, makeTokens, testDbConfig, type TestApp } from './support.js';
import type { App } from '../src/fastify.js';

const url = process.env['TEST_DATABASE_URL'];
const identityUrl = process.env['TEST_IDENTITY_DATABASE_URL'];
const DAY = 86_400_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

const batch = {
  source: 'gmail',
  cursor: 'history-42',
  // メールの日付は今からの相対（固定の日付だと、取り込みの期間（60 日）を過ぎて試験が古びる）
  artifacts: [
    {
      id: 'c1',
      source: 'google_calendar',
      kind: 'calendar_event',
      title: 'MOPITA 定例',
      body_excerpt: null,
      people: [{ name: 'MTI 田中', email: 'tanaka@mti.example', role: 'attendee' }],
      direction: 'self',
      occurred_at: new Date(Date.now() + 5 * 3_600_000).toISOString(),
      ends_at: new Date(Date.now() + 6 * 3_600_000).toISOString(),
      due_at: null,
      thread_id: null,
      project_hint: 'MOPITA連携',
      responded: null,
      completed: null,
      provenance: {
        source: 'google_calendar',
        external_id: 'c1',
        label: 'MOPITA 定例',
        observed_at: new Date().toISOString(),
        url: null,
        excerpt: null,
      },
      semantic: null,
    },
    {
      id: 'g1',
      source: 'gmail',
      kind: 'email',
      title: 'Re: MOPITA SITE_ID の件',
      body_excerpt: 'SITE_ID は明日までにお送りします',
      people: [{ name: 'MTI 田中', email: 'tanaka@mti.example', role: 'from' }],
      direction: 'inbound',
      occurred_at: ago(2 * DAY),
      thread_id: 'th-mopita',
      project_hint: 'MOPITA連携',
      provenance: {
        source: 'gmail',
        external_id: 'g1',
        label: 'MTI からの返信',
        observed_at: ago(2 * DAY),
      },
      semantic: {
        category: 'info',
        project: 'MOPITA連携',
        waiting_on: 'MTI',
        request: 'SITE_ID を受領する',
        confidence: 0.9,
        extracted_by: 'llm',
      },
    },
    {
      id: 'g2',
      source: 'gmail',
      kind: 'email',
      title: '【○○社】見積のご確認',
      body_excerpt: '9/9 までにご返信ください',
      people: [{ name: '佐藤', email: 'sato@example.com', role: 'from' }],
      direction: 'inbound',
      occurred_at: ago(3 * DAY),
      thread_id: 'th-quote',
      provenance: {
        source: 'gmail',
        external_id: 'g2',
        label: '見積のご確認',
        observed_at: ago(3 * DAY),
      },
      semantic: {
        category: 'request_to_me',
        project: '○○社 提案',
        request: '見積に返信する',
        due: ago(-1.5 * DAY),
        confidence: 0.9,
        extracted_by: 'llm',
      },
    },
  ],
};

describe.skipIf(!url)('work context over HTTP', () => {
  let harness: TestApp;
  let app: App;
  let auth: { authorization: string };

  beforeAll(async () => {
    const tokens = await makeTokens();
    harness = await makeTestApp({
      dbConfig: testDbConfig(url!, identityUrl),
      tokens,
      seedPlugins: true,
    });
    app = harness.app;
    const issued = await app.inject({
      method: 'POST',
      url: '/v1/auth/dev/token',
      payload: { email: `w-${uuidv7()}@example.com`, display_name: 'W' },
    });
    auth = { authorization: `Bearer ${issued.json<TokenResponse>().access_token}` };
    // chat lane は General Assistant の仕事になる。この tenant に入れておく（入っていないと task が始まらない）。
    await app.inject({
      method: 'POST',
      url: '/v1/plugins/com.astra.general/install',
      headers: auth,
      payload: { version: '0.1.0', granted_scopes: ['artifacts.read', 'artifacts.write'] },
    });
  });
  afterAll(async () => {
    await harness?.close();
  });

  it('accepts a normalized batch from the device and refuses a full mail body', async () => {
    const ok = await app.inject({
      method: 'POST',
      url: '/v1/work/artifacts',
      headers: auth,
      payload: batch,
    });
    expect(ok.statusCode).toBe(202);
    expect(ok.json<{ accepted: number }>().accepted).toBe(3);
    const tooLong = {
      ...batch,
      artifacts: [{ ...batch.artifacts[1], id: 'g3', body_excerpt: 'x'.repeat(501) }],
    };
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/work/artifacts',
          headers: auth,
          payload: tooLong,
        })
      ).statusCode,
    ).toBe(400);
    const sync = await app.inject({ method: 'GET', url: '/v1/work/sync', headers: auth });
    expect(sync.json<{ items: { source: string; cursor: string }[] }>().items[0]).toMatchObject({
      source: 'gmail',
      cursor: 'history-42',
      last_error: null,
      schema_version: 1,
    });

    // 失敗の記録: 理由は残るが cursor は動かない（端末は同じ続きから読み直す）
    const failed = await app.inject({
      method: 'POST',
      url: '/v1/work/sync/gmail/attempt',
      headers: auth,
      payload: { ok: false, error: 'token_expired' },
    });
    expect(failed.statusCode).toBe(204);
    const after = await app.inject({ method: 'GET', url: '/v1/work/sync', headers: auth });
    expect(after.json<{ items: unknown[] }>().items[0]).toMatchObject({
      source: 'gmail',
      cursor: 'history-42',
      last_error: 'token_expired',
    });
    // 知らない source は受けない
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/work/sync/nonsense/attempt',
          headers: auth,
          payload: { ok: false, error: 'x' },
        })
      ).statusCode,
    ).toBe(400);
  });

  it('builds the context with a source behind every inference, and opens the evidence', async () => {
    // first useful Work Context: 取り込み済みの状態から Home が読めるまで（DAILY WORK GATE: <= 60 s）
    const started = Date.now();
    const res = await app.inject({ method: 'GET', url: '/v1/work/context', headers: auth });
    const firstValueMs = Date.now() - started;
    console.log(`FIRST_VALUE_MS=${String(firstValueMs)}`);
    expect(firstValueMs).toBeLessThan(60_000);
    expect(res.statusCode).toBe(200);
    const ctx = res.json<{
      priorities: { id: string; project: string; sources: unknown[]; factors: unknown[] }[];
      waiting_on: { who: string }[];
      owed: { to: string }[];
      week: { deadlines: number };
    }>();
    expect(ctx.priorities.map((p) => p.project)).toEqual(
      expect.arrayContaining(['MOPITA連携', '○○社 提案']),
    );
    for (const p of ctx.priorities) {
      expect(p.sources.length).toBeGreaterThan(0);
      expect(p.factors).toHaveLength(7);
    }
    expect(ctx.waiting_on.map((w) => w.who)).toEqual(['MTI']);
    expect(ctx.owed.map((o) => o.to)).toEqual(['佐藤']);
    const ev = await app.inject({
      method: 'GET',
      url: `/v1/work/evidence/${encodeURIComponent(ctx.priorities[0]!.id)}`,
      headers: auth,
    });
    expect(ev.json<{ items: { id: string }[] }>().items.length).toBeGreaterThan(0);
  });

  it('adds the work context to a work question only, bounded, and never to an unrelated one', async () => {
    const conv = (
      await app.inject({ method: 'POST', url: '/v1/conversations', headers: auth, payload: {} })
    ).json<{ id: string }>().id;
    const ask = async (text: string) => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/conversations/${conv}/turns`,
        headers: auth,
        payload: { text },
      });
      const taskId = res.json<{ task_id: string | null }>().task_id;
      if (!taskId)
        return {
          statusCode: res.statusCode,
          context: null,
          notice: res.json<{ notice: string | null }>().notice,
        };
      const task = await harness.tasks.get(
        (await app.inject({ method: 'GET', url: '/v1/me', headers: auth })).json<{
          tenant: { id: string };
        }>().tenant.id,
        taskId,
      );
      const input = task.input as {
        context?: string;
        context_meta?: { intent: string; selected_artifacts: number; available_artifacts: number };
      };
      return {
        statusCode: res.statusCode,
        context: input.context ?? null,
        meta: input.context_meta ?? null,
        notice: null,
      };
    };
    const work = await ask('今日何を優先すべき？');
    expect(work.statusCode).toBe(202);
    expect(work.context).toContain('<work_context>');
    expect(work.context).toContain('MOPITA連携');
    expect(work.context!.length).toBeLessThanOrEqual(1_200);
    // 渡した量の事実が turn（task）に残る
    expect(work.meta).toMatchObject({ intent: 'priorities' });
    expect(work.meta!.selected_artifacts).toBeGreaterThan(0);
    expect(work.meta!.selected_artifacts).toBeLessThanOrEqual(work.meta!.available_artifacts);

    // CONTEXT_MINIMIZATION: 関係の無い問いには 0 件（知っていても渡さない）
    const unrelated = await ask('社内報の文章を書いて');
    expect(unrelated.statusCode).toBe(202);
    expect(unrelated.context).toBeNull();
    expect(unrelated.meta).toMatchObject({ intent: 'none', selected_artifacts: 0 });
    expect(unrelated.meta!.available_artifacts).toBeGreaterThan(0);
    const coding = await ask('この TypeScript の型エラーを直して');
    expect(coding.context).toBeNull();
    expect(coding.meta!.selected_artifacts).toBe(0);

    // 返信: 名指しの相手の案件だけ
    // 返信は REPLY_IN_CONTEXT の経路（相手の名指し → そのスレッドだけ）。別案件は添えない
    const reply = await ask('MTI に返信を書いて');
    expect(reply.context).toContain('MOPITA');
    expect(reply.context).not.toContain('○○社');
  });

  it('applies writing corrections and OFF controls to the very next reply task', async () => {
    const update = async (payload: unknown) => {
      const response = await app.inject({
        method: 'PUT',
        url: '/v1/personalization',
        headers: auth,
        payload: payload as object,
      });
      expect(response.statusCode).toBe(200);
      return response.json<{ working_style: { label: string }[] }>();
    };
    const nextContext = async () => {
      const conv = (
        await app.inject({ method: 'POST', url: '/v1/conversations', headers: auth, payload: {} })
      ).json<{ id: string }>().id;
      const turn = await app.inject({
        method: 'POST',
        url: `/v1/conversations/${conv}/turns`,
        headers: auth,
        payload: { text: 'MTI に返信を書いて' },
      });
      expect(turn.statusCode).toBe(202);
      const task = await app.inject({
        method: 'GET',
        url: `/v1/tasks/${turn.json<{ task_id: string }>().task_id}`,
        headers: auth,
      });
      expect(task.statusCode).toBe(200);
      return task.json<{ input: { context?: string } }>().input.context ?? '';
    };
    const key = 'style.prefersConcise';
    const corrected = '詳しく、出所と一緒に説明する';
    const profile = await update({
      inference_enabled: true,
      traits: [{ key, value: corrected, status: 'confirmed', enabled: true }],
    });
    expect(profile.working_style.some((trait) => trait.label === corrected)).toBe(true);
    expect(await nextContext()).toContain(corrected);
    await update({ traits: [{ key, enabled: false }] });
    expect(await nextContext()).not.toContain(corrected);
    await update({ inference_enabled: false, traits: [{ key, enabled: true }] });
    expect(await nextContext()).not.toContain(corrected);
    await update({ inference_enabled: true, traits: [{ key, enabled: false }] });
  });

  it('takes a correction in one call, and stops all inference in one call', async () => {
    const before = (
      await app.inject({ method: 'GET', url: '/v1/work/context', headers: auth })
    ).json<{ priorities: { id: string; project: string }[] }>();
    const mopita = before.priorities.find((p) => p.project === 'MOPITA連携')!;
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/work/corrections',
          headers: auth,
          payload: { item_id: mopita.id, action: 'not_priority' },
        })
      ).statusCode,
    ).toBe(204);
    const after = (
      await app.inject({ method: 'GET', url: '/v1/work/context', headers: auth })
    ).json<{ priorities: { project: string }[] }>();
    expect(after.priorities.map((p) => p.project)).not.toContain('MOPITA連携');

    const profile = (
      await app.inject({ method: 'GET', url: '/v1/personalization', headers: auth })
    ).json<{
      inference_enabled: boolean;
      frequent_entities: { label: string; status: string }[];
    }>();
    expect(profile.inference_enabled).toBe(true);
    expect(profile.frequent_entities.every((t) => t.status === 'observed')).toBe(true);
    const off = await app.inject({
      method: 'PUT',
      url: '/v1/personalization',
      headers: auth,
      payload: { inference_enabled: false },
    });
    expect(off.json<{ inference_enabled: boolean }>().inference_enabled).toBe(false);
    const silent = (
      await app.inject({ method: 'GET', url: '/v1/work/context', headers: auth })
    ).json<{ priorities: unknown[]; inference_enabled: boolean }>();
    expect(silent).toMatchObject({ inference_enabled: false, priorities: [] });
  });
});

describe.skipIf(!url)('reply in context and meeting brief', () => {
  let harness: TestApp;
  let app: App;
  let auth: { authorization: string };
  beforeAll(async () => {
    const tokens = await makeTokens();
    harness = await makeTestApp({
      dbConfig: testDbConfig(url!, identityUrl),
      tokens,
      seedPlugins: true,
    });
    app = harness.app;
    const issued = await app.inject({
      method: 'POST',
      url: '/v1/auth/dev/token',
      payload: { email: `r-${uuidv7()}@example.com`, display_name: 'R' },
    });
    auth = { authorization: `Bearer ${issued.json<TokenResponse>().access_token}` };
    await app.inject({
      method: 'POST',
      url: '/v1/plugins/com.astra.general/install',
      headers: auth,
      payload: { version: '0.1.0', granted_scopes: ['artifacts.read', 'artifacts.write'] },
    });
    await app.inject({ method: 'POST', url: '/v1/work/artifacts', headers: auth, payload: batch });
  });
  afterAll(async () => {
    await harness.close();
  });

  const turn = async (text: string, replyCandidates: unknown[] = []) => {
    const conv = (
      await app.inject({ method: 'POST', url: '/v1/conversations', headers: auth, payload: {} })
    ).json<{ id: string }>().id;
    const res = await app.inject({
      method: 'POST',
      url: `/v1/conversations/${conv}/turns`,
      headers: auth,
      payload: { text, reply_candidates: replyCandidates },
    });
    return res;
  };

  it('resolves 「これ返して」 from the open mail, drafts with that thread only, and never sends', async () => {
    const res = await turn('これ返して', [
      { kind: 'mail', label: 'Re: MOPITA SITE_ID の件 - Gmail', app: 'Google Chrome' },
    ]);
    expect(res.statusCode).toBe(202);
    const body = res.json<{
      task_id: string;
      reply: {
        target: { artifact_id: string; thread_id: string };
        sources: unknown[];
        basis: string;
      };
    }>();
    expect(body.reply.target.thread_id).toBe('th-mopita');
    expect(body.reply.sources.length).toBeGreaterThan(0);
    expect(body.reply.basis).toContain('踏まえて');
    const tenantId = (await app.inject({ method: 'GET', url: '/v1/me', headers: auth })).json<{
      tenant: { id: string };
    }>().tenant.id;
    const task = await harness.tasks.get(tenantId, body.task_id);
    const input = task.input as { instruction?: string; context?: string; reply?: unknown };
    expect(input.instruction).toContain('返信');
    expect(input.context).toContain('MOPITA');
    // 別案件のメールは添えない
    expect(input.context).not.toContain('○○社');
    expect(input.reply).toBeDefined();
    // 送る段は無い（compose だけ）
    expect(task.kind).not.toBe('mail.send');
  });

  it('asks back instead of guessing when no mail is open', async () => {
    const res = await turn('これ返して');
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      needs_clarification: boolean;
      answer: { text?: string } | { content?: { text: string } };
    }>();
    expect(body.needs_clarification).toBe(true);
    expect(JSON.stringify(body.answer)).toContain('特定できませんでした');
  });

  it('builds the next meeting brief with sources, questions and no other project', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/work/brief/next', headers: auth });
    expect(res.statusCode).toBe(200);
    const brief = res.json<{
      event_id: string;
      project: string | null;
      open_items: { sources: unknown[] }[];
      suggested_questions: { reason: string; sources: unknown[] }[];
      provenance: unknown[];
    }>();
    expect(brief.event_id).toBe('c1');
    expect(brief.project).toBe('MOPITA連携');
    expect(brief.provenance.length).toBeGreaterThan(0);
    for (const q of brief.suggested_questions) {
      expect(q.reason.length).toBeGreaterThan(0);
      expect(q.sources.length).toBeGreaterThan(0);
    }
    expect(JSON.stringify(brief)).not.toContain('○○社');
  });

  it('sending is a separate approved task, never started by the draft', async () => {
    const payload = {
      source: 'gmail',
      to: ['tanaka@mti.example'],
      subject: 'Re: MOPITA SITE_ID の件',
      body: 'ご連絡ありがとうございます。',
      in_reply_to: 'g1',
      thread_id: 'th-mopita',
    };
    const res = await app.inject({
      method: 'POST',
      url: '/v1/work/reply/send',
      headers: auth,
      payload,
    });
    expect(res.statusCode).toBe(202);
    const taskId = res.json<{ task_id: string }>().task_id;
    // 同じ要求の再送だけを同一taskへ戻す。同じ長さの編集や宛先変更は別の確認が必要。
    const retry = await app.inject({
      method: 'POST',
      url: '/v1/work/reply/send',
      headers: auth,
      payload,
    });
    expect(retry.statusCode).toBe(202);
    expect(retry.json<{ task_id: string }>().task_id).toBe(taskId);
    const changedIds = new Set([taskId]);
    for (const edit of [
      { body: payload.body.replace('。', '！') },
      { to: ['sato@example.com'] },
      { source: 'outlook_mail' },
      { thread_id: 'th-quote' },
    ]) {
      const changed = await app.inject({
        method: 'POST',
        url: '/v1/work/reply/send',
        headers: auth,
        payload: { ...payload, ...edit },
      });
      expect(changed.statusCode).toBe(202);
      const changedId = changed.json<{ task_id: string }>().task_id;
      expect(changedIds.has(changedId)).toBe(false);
      changedIds.add(changedId);
    }
    const tenantId = (await app.inject({ method: 'GET', url: '/v1/me', headers: auth })).json<{
      tenant: { id: string };
    }>().tenant.id;
    const task = await harness.tasks.get(tenantId, taskId);
    expect(task.kind).toBe('mail.send');
    const approvals = await app.inject({
      method: 'GET',
      url: `/v1/tasks/${taskId}/approvals`,
      headers: auth,
    });
    expect(approvals.statusCode).toBe(200);
    // Outlook は既存メッセージへの返信（相手のメッセージ id が要る）。別 task で承認つき
    const outlookNoId = await app.inject({
      method: 'POST',
      url: '/v1/work/reply/send',
      headers: auth,
      payload: { source: 'outlook_mail', to: ['a@example.com'], subject: 's', body: 'b' },
    });
    expect(outlookNoId.statusCode).toBe(400);
    const outlook = await app.inject({
      method: 'POST',
      url: '/v1/work/reply/send',
      headers: auth,
      payload: {
        source: 'outlook_mail',
        to: ['a@example.com'],
        subject: 's',
        body: 'b',
        in_reply_to: 'AAMk1',
      },
    });
    expect(outlook.statusCode).toBe(202);
    const outlookTask = await harness.tasks.get(
      tenantId,
      outlook.json<{ task_id: string }>().task_id,
    );
    expect(outlookTask.kind).toBe('mail.send');
    expect((outlookTask.input as { source: string }).source).toBe('outlook_mail');
    // 他の送り元は断る
    const other = await app.inject({
      method: 'POST',
      url: '/v1/work/reply/send',
      headers: auth,
      payload: { source: 'microsoft_todo', to: ['a@example.com'], subject: 's', body: 'b' },
    });
    expect(other.statusCode).toBe(409);
  });
});

describe.skipIf(!url)('one-time initial profile over HTTP', () => {
  let harness: TestApp;
  let app: App;
  let headers: { authorization: string };
  beforeAll(async () => {
    harness = await makeTestApp({
      dbConfig: testDbConfig(url!, identityUrl),
      tokens: await makeTokens(),
    });
    app = harness.app;
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/dev/token',
      payload: { email: `initial-${uuidv7()}@example.invalid`, display_name: 'Initial' },
    });
    headers = { authorization: `Bearer ${response.json<TokenResponse>().access_token}` };
  });
  afterAll(async () => {
    await harness?.close();
  });
  it('requires completed data before review, validates edits, and never restarts a confirmed profile', async () => {
    expect(
      (await app.inject({ method: 'GET', url: '/v1/work/initial-profile', headers })).json(),
    ).toEqual({ profile: null });
    const initial = await app.inject({
      method: 'POST',
      url: '/v1/work/initial-profile',
      headers,
      payload: { provider: 'google' },
    });
    expect(initial.statusCode).toBe(200);
    const sections = { focus: [], people: [], priorities: [], work_pattern: [], open_items: 0 };
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/v1/work/initial-profile',
          headers,
          payload: sections,
        })
      ).statusCode,
    ).toBe(409);
    const lease = (
      await app.inject({ method: 'POST', url: '/v1/work/initial-profile/claim', headers })
    ).json<{ job: { lease: string } }>().job.lease;
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/work/initial-profile/artifacts',
          headers,
          payload: {
            lease,
            batch: { source: 'gmail', cursor: 'must-not-advance', watermark: null, artifacts: [] },
          },
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/work/initial-profile/artifacts',
          headers,
          payload: {
            lease,
            batch: { source: 'outlook_mail', cursor: null, watermark: null, artifacts: [] },
          },
        })
      ).statusCode,
    ).toBe(409);
    for (const source of ['gmail', 'google_calendar']) {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/v1/work/initial-profile/progress',
            headers,
            payload: { lease, outcome: { source, status: 'synced', artifacts: 0 } },
          })
        ).statusCode,
      ).toBe(204);
    }
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/work/initial-profile/finish',
          headers,
          payload: { lease, artifact_ids: [] },
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/v1/work/initial-profile',
          headers,
          payload: { ...sections, focus: Array(6).fill('Too many') },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/v1/work/initial-profile',
          headers,
          payload: sections,
        })
      ).statusCode,
    ).toBe(204);
    const again = (
      await app.inject({
        method: 'POST',
        url: '/v1/work/initial-profile',
        headers,
        payload: { provider: 'microsoft' },
      })
    ).json<{ profile: { id: string; status: string } }>().profile;
    expect(again.status).toBe('confirmed');
    expect(again.id).toBe(initial.json<{ profile: { id: string } }>().profile.id);
  });
});

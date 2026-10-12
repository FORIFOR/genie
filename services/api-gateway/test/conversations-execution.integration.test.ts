import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7, type TokenResponse } from '@genie/contracts';
import { makeTestApp, makeTokens, testDbConfig, type TestApp } from './support.js';
const url = process.env['TEST_DATABASE_URL'];
describe.skipIf(!url)('TaskDock conversation to execution.run', () => {
  let h: TestApp;
  let auth: { authorization: string };
  beforeAll(async () => {
    h = await makeTestApp({
      dbConfig: testDbConfig(url!, process.env['TEST_IDENTITY_DATABASE_URL']),
      tokens: await makeTokens(),
    });
    const token = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/dev/token',
      payload: { email: `execution-${uuidv7()}@example.com`, display_name: 'Execution' },
    });
    auth = { authorization: 'Bearer ' + token.json<TokenResponse>().access_token };
  });
  afterAll(async () => {
    await h?.close();
  });
  async function ask(text: string) {
    const conversation = await h.app.inject({
      method: 'POST',
      url: '/v1/conversations',
      headers: auth,
      payload: {},
    });
    return h.app.inject({
      method: 'POST',
      url: `/v1/conversations/${conversation.json<{ id: string }>().id}/turns`,
      headers: auth,
      payload: { text },
    });
  }
  it.each([
    'Gmailに a@example.com 宛て、件名「確認」、本文「お願いします」の下書きを保存して。',
    'Googleカレンダーに確認の予定を2026-10-01T10:00:00+09:00から2026-10-01T11:00:00+09:00で登録して。',
    '入力欄に「こんにちは」を入力して。',
  ])('starts a durable preparation task, not a fake completed answer: %s', async (text) => {
    const result = await ask(text);
    expect(result.statusCode).toBe(202);
    const id = result.json<{ task_id: string }>().task_id;
    expect(id).toBeTruthy();
    const task = await h.app.inject({ method: 'GET', url: '/v1/tasks/' + id, headers: auth });
    expect(task.statusCode).toBe(200);
    expect(task.json()).toMatchObject({ kind: 'execution.run', status: 'PENDING' });
  });
  it('does not turn a how-to question into a mutating task', async () => {
    const result = await ask('カレンダーに登録する方法を教えて。');
    const id = result.json<{ task_id?: string }>().task_id;
    if (id) {
      const task = await h.app.inject({ method: 'GET', url: '/v1/tasks/' + id, headers: auth });
      expect(task.json<{ kind: string }>().kind).not.toBe('execution.run');
    } else expect(result.statusCode).toBeGreaterThanOrEqual(200);
  });
});

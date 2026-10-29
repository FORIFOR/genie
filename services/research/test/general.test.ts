/**
 * General Assistant。正本 §2.2・§29。
 *
 * 見るのは:
 *   - 何を聞かれたか分からないまま、それらしい答えを作らない
 *   - 書いたものが**下書きだと分かる**
 *   - モデルが繋がっていないとき、代役が答えたふりをしない
 */
import { describe, expect, it, vi } from 'vitest';
import { generalExecutors } from '../src/general-executor.js';
import { DeterministicLanguageModel } from '../src/providers.js';
import type { LanguageModel } from '../src/providers.js';

const model = (over: Partial<LanguageModel> = {}): LanguageModel =>
  ({
    name: 'test',
    isStandIn: false,
    async decompose() {
      return [];
    },
    async extractClaims() {
      return [];
    },
    async synthesize() {
      return [];
    },
    async answer() {
      return '答えです。';
    },
    async compose() {
      return '本文です。';
    },
    ...over,
  }) as LanguageModel;

const task = { taskId: 't', tenantId: 'a', input: {} as Record<string, unknown> };

describe('answering', () => {
  it('puts the answer into an artifact the person can keep', async () => {
    const executors = generalExecutors(model());
    const outcome = await executors['general.answer']!.execute(task, {
      toolId: 'general.answer',
      args: { question: '議事録のコツは？' },
    });

    expect(outcome.artifact).toEqual({ title: '議事録のコツは？', markdown: '答えです。' });
  });

  it('passes along what the person already told us', async () => {
    const answer = vi.fn().mockResolvedValue('ok');
    const executors = generalExecutors(model({ answer }));
    await executors['general.answer']!.execute(task, {
      toolId: 'general.answer',
      args: { question: 'q', context: '前提です' },
    });
    expect(answer).toHaveBeenCalledWith('q', '前提です');
  });

  // 仕様 v1.0 §5②: 「で？」は直前の会話の続きとして答える
  it('passes the recent conversation from the task, and drops malformed lines', async () => {
    const answer = vi.fn().mockResolvedValue('ok');
    const executors = generalExecutors(model({ answer }));
    await executors['general.answer']!.execute(
      {
        ...task,
        input: {
          question: 'で？',
          history: [
            { role: 'user', text: '明日の天気は？' },
            { role: 'genie', text: '明日は晴れ、最高 22℃です。' },
            { role: 'system', text: '捨てる' },
            { role: 'user' },
          ],
        },
      },
      { toolId: 'general.answer', args: {} },
    );
    expect(answer).toHaveBeenCalledWith(
      'で？',
      undefined,
      [],
      [
        { role: 'user', text: '明日の天気は？' },
        { role: 'genie', text: '明日は晴れ、最高 22℃です。' },
      ],
    );
  });

  it('reads the question from the task when the step did not carry one', async () => {
    const executors = generalExecutors(model());
    const outcome = await executors['general.answer']!.execute(
      { ...task, input: { message: '依頼です' } },
      { toolId: 'general.answer', args: {} },
    );
    expect(outcome.artifact!.title).toBe('依頼です');
  });

  it('refuses when there is nothing to answer', async () => {
    // それらしい答えを作らない
    const executors = generalExecutors(model());
    await expect(
      executors['general.answer']!.execute(task, { toolId: 'general.answer', args: {} }),
    ).rejects.toThrow(/nothing to answer/);
  });

  it('shortens a long request rather than using it whole as a title', async () => {
    const executors = generalExecutors(model());
    const outcome = await executors['general.answer']!.execute(task, {
      toolId: 'general.answer',
      args: { question: 'あ'.repeat(100) },
    });
    expect(outcome.artifact!.title.length).toBeLessThanOrEqual(40);
    expect(outcome.artifact!.title.endsWith('…')).toBe(true);
  });
});

describe('writing', () => {
  it('keeps draft and send status separate from the copyable document', async () => {
    const executors = generalExecutors(model());
    const outcome = await executors['general.compose']!.execute(task, {
      toolId: 'general.compose',
      args: { instruction: '日程調整のメール' },
    });

    expect(outcome.artifact!.markdown).toBe('本文です。');
    expect(outcome.result).toEqual({ composed: true, draft: true, sent: false });
  });

  it('refuses when there is nothing to write', async () => {
    const executors = generalExecutors(model());
    await expect(
      executors['general.compose']!.execute(task, { toolId: 'general.compose', args: {} }),
    ).rejects.toThrow(/nothing to write/);
  });
});

describe('with no model connected', () => {
  it('says so, instead of writing something plausible', async () => {
    /*
     * 代役がもっともらしい文を返すと、モデルを繋いでいないことに
     * 誰も気づかないまま使われる。
     */
    const executors = generalExecutors(new DeterministicLanguageModel());
    await expect(
      executors['general.answer']!.execute(task, {
        toolId: 'general.answer',
        args: { question: 'q' },
      }),
    ).rejects.toThrow(/no language model is connected/);
    await expect(
      executors['general.compose']!.execute(task, {
        toolId: 'general.compose',
        args: { instruction: 'i' },
      }),
    ).rejects.toThrow(/no language model is connected/);
  });
});

describe('answering about a screenshot the person just took', () => {
  it('hands the attachments to the model by id — pixels never come through here', async () => {
    const answer = vi.fn().mockResolvedValue('画面の説明です。');
    const executors = generalExecutors(model({ answer }));
    await executors['general.answer']!.execute(
      {
        ...task,
        input: {
          question: 'これ何？',
          attachments: [
            { id: 'shot-1', kind: 'screenshot', label: 'スクリーンショット（たった今）' },
          ],
        },
      },
      { toolId: 'general.answer', args: {} },
    );
    expect(answer).toHaveBeenCalledWith('これ何？', undefined, [
      { id: 'shot-1', kind: 'screenshot', label: 'スクリーンショット（たった今）' },
    ]);
  });

  it('drops attachments whose id could reach outside the hand-over folder', async () => {
    const answer = vi.fn().mockResolvedValue('ok');
    const executors = generalExecutors(model({ answer }));
    await executors['general.answer']!.execute(
      {
        ...task,
        input: {
          question: 'q',
          attachments: [
            { id: '../etc/passwd', kind: 'screenshot', label: 'x' },
            { id: 'ok-1', kind: 'unknown', label: 'x' },
            { id: 'ok-2', kind: 'clipboard_image', label: '' },
          ],
        },
      },
      { toolId: 'general.answer', args: {} },
    );
    // 形の合うものが無ければ、添付無しとして問う（見たふりをしない）
    expect(answer).toHaveBeenCalledWith('q', undefined);
  });
});

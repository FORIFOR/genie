/**
 * 端末で動かす言語モデル。正本 §8・§21、UI/UX §22。
 *
 * 見るのは:
 *   - 原文に無い根拠を通さない
 *   - 形の違う返事を、答えとして受け取らない
 *   - 仕事の外から呼ばれたら、代役で答えず断る
 *   - 端末が居ないときに、勝手に別の手段へ乗り換えない
 */
import { describe, expect, it } from 'vitest';
import { HostLanguageModel, type HostCall, type HostModelContext } from '../src/host-model.js';

const CONTEXT: HostModelContext = {
  taskId: '01a00000-0000-7000-8000-000000000001',
  tenantId: '01a00000-0000-7000-8000-000000000002',
  userId: '01a00000-0000-7000-8000-000000000003',
  stepIndex: 2,
};

interface Ask {
  toolId: string;
  args: Record<string, unknown>;
  requestKey: string;
  stepIndex: number;
}

function host(reply: (toolId: string) => unknown): { host: HostCall; asks: Ask[] } {
  const asks: Ask[] = [];
  return {
    asks,
    host: {
      async execute(_input, step) {
        asks.push({
          toolId: step.toolId,
          args: step.args,
          requestKey: step.requestKey,
          stepIndex: step.index,
        });
        return { result: reply(step.toolId) };
      },
    },
  };
}

const model = (h: HostCall, context: HostModelContext | null = CONTEXT): HostLanguageModel =>
  new HostLanguageModel({ host: h, context: () => context });

const hit = {
  url: 'https://example.com/a',
  title: '決算',
  snippet: '2025年の売上は 120 億円でした。前年から 12% 増えています。',
  sourceType: 'filing' as const,
  publisher: 'A社',
  publishedAt: '2026-05-14',
};

describe('a model that runs on the device', () => {
  it('is not a stand-in, because it really is the model', () => {
    // 端末が居ないときは代役へ落ちるのではなく止まる。だから代役ではない。
    expect(model(host(() => ({})).host).isStandIn).toBe(false);
  });

  it('breaks a question apart, keeping at most what was asked for', async () => {
    const { host: h } = host(() => ({ queries: ['a', 'b', 'c', 'd'] }));
    expect(await model(h).decompose('A社と B社の売上は？', 2)).toEqual(['a', 'b']);
  });

  it('drops blank and non-string queries rather than passing them on', async () => {
    const { host: h } = host(() => ({ queries: ['a', '', '   ', 42, null, 'b'] }));
    expect(await model(h).decompose('q', 5)).toEqual(['a', 'b']);
  });

  it('returns nothing rather than guessing when the shape is wrong', async () => {
    const { host: h } = host(() => ({ answer: 'ここに答えがあります' }));
    expect(await model(h).decompose('q', 3)).toEqual([]);
  });

  it('throws away a claim whose support is not in the source', async () => {
    /*
     * ここを緩めると、Evidence Ledger に
     * 「もっともらしいが原文に無い」根拠が積まれる。
     */
    const { host: h } = host(() => ({
      claims: [
        { claim: '売上は 120 億円', supportText: '2025年の売上は 120 億円でした。' },
        { claim: '利益も増えた', supportText: '営業利益は 30 億円でした。' },
      ],
    }));
    const claims = await model(h).extractClaims('売上は？', hit);
    expect(claims).toEqual([
      { claim: '売上は 120 億円', supportText: '2025年の売上は 120 億円でした。' },
    ]);
  });

  it('throws away a claim with no support at all', async () => {
    const { host: h } = host(() => ({
      claims: [
        { claim: '売上は 120 億円', supportText: '' },
        { claim: '', supportText: '前年' },
      ],
    }));
    expect(await model(h).extractClaims('売上は？', hit)).toEqual([]);
  });

  it('sends the source along so the device can quote from it', async () => {
    const { host: h, asks } = host(() => ({ claims: [] }));
    await model(h).extractClaims('売上は？', hit);
    expect(asks[0]!.args).toMatchObject({ snippet: hit.snippet, url: hit.url });
  });

  it('ignores contradiction pairs that point outside the claims', async () => {
    const { host: h } = host(() => ({
      pairs: [
        { left: 0, right: 1 },
        { left: 0, right: 9 },
        { left: 1, right: 1 },
        { left: -1, right: 0 },
        { left: 'a', right: 0 },
      ],
    }));
    // 存在しない主張の矛盾は矛盾ではない
    expect(await model(h).detectContradictions(['増えた', '減った'])).toEqual([
      { left: 0, right: 1 },
    ]);
  });

  it('keeps only judgments that point at real claims', async () => {
    const h = host(() => ({
      assessments: [
        { text: '前走の勝ち方から有力', supports: [0, 1] },
        { text: '根拠の無い断定', supports: [] },
        { text: '存在しない主張に立つ判断', supports: [7] },
        { text: '', supports: [0] },
      ],
    }));
    const out = await model(h.host).assess('予想して', ['前走1着', '東京芝1800mで2勝']);
    expect(out).toEqual([{ text: '前走の勝ち方から有力', supports: [0, 1] }]);
    expect(h.asks[0]).toMatchObject({ toolId: 'llm.assess', args: { question: '予想して' } });
  });

  it('gives every different call its own key, so answers do not get crossed', async () => {
    const { host: h, asks } = host((toolId) =>
      toolId === 'llm.decompose' ? { queries: ['x'] } : { findings: ['y'] },
    );
    const m = model(h);

    await m.decompose('質問A', 3);
    await m.synthesize('質問A', ['主張1']);
    await m.decompose('質問B', 3);

    const keys = asks.map((a) => a.requestKey);
    expect(new Set(keys).size).toBe(3);
    // 同じ step の中の呼び出しなので、段は同じ
    expect(asks.every((a) => a.stepIndex === CONTEXT.stepIndex)).toBe(true);
  });

  it('gives the same call the same key, so a retry reuses the answer', async () => {
    const { host: h, asks } = host(() => ({ queries: ['x'] }));
    const m = model(h);
    await m.decompose('同じ質問', 3);
    await m.decompose('同じ質問', 3);
    expect(asks[0]!.requestKey).toBe(asks[1]!.requestKey);
  });

  it('refuses to answer outside a task rather than making something up', async () => {
    const { host: h, asks } = host(() => ({ queries: ['x'] }));
    await expect(model(h, null).decompose('q', 3)).rejects.toThrow(/task/);
    // 端末に頼んでもいない
    expect(asks).toEqual([]);
  });

  it('lets the device being away surface as it is, without substituting an answer', async () => {
    const failing: HostCall = {
      async execute() {
        throw Object.assign(new Error('端末が応答していません。'), { name: 'HostOffline' });
      },
    };
    // §22: 黙って別の経路へ乗り換えない
    await expect(model(failing).decompose('q', 3)).rejects.toMatchObject({ name: 'HostOffline' });
  });
});

describe('asking about a screenshot on the device', () => {
  it('passes the images by id so the device reads the pixels itself', async () => {
    const { host: h, asks } = host(() => ({ answer: '設定画面です。' }));
    const text = await model(h).answer('これ何？', undefined, [
      { id: 'shot-1', kind: 'screenshot', label: 'スクリーンショット（たった今）' },
    ]);
    expect(text).toBe('設定画面です。');
    expect(asks[0]!.toolId).toBe('llm.answer');
    expect(asks[0]!.args['images']).toEqual([
      { id: 'shot-1', kind: 'screenshot', label: 'スクリーンショット（たった今）' },
    ]);
  });

  it('sends no images key at all when nothing was attached', async () => {
    const { host: h, asks } = host(() => ({ answer: 'ok' }));
    await model(h).answer('q');
    expect('images' in asks[0]!.args).toBe(false);
  });
});

it('rejects a malformed JSON fragment instead of publishing it as a written answer', async () => {
  const { host: h } = host(() => ({ answer: '{', text: '{}' }));
  await expect(model(h).answer('write a document')).rejects.toThrow('form we could read');
  await expect(model(h).compose('write a document')).rejects.toThrow('form we could read');
});

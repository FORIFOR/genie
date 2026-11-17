#!/usr/bin/env node
/*
 * 同じ目的を、端末のモデルとクラウドのモデルで順に走らせて比べる。
 *
 * 測るのは 5 つ:
 *   completed     … 目的の達成を**画面から確認できた**走行かどうか（モデルの自己申告ではない）
 *   misoperations … 送ったのに効果を確かめられなかった操作の数
 *   seconds       … 人が待つ時間（実測の壁時計）
 *   modelCalls    … モデルを呼んだ回数
 *   costUsd       … 使ったトークン × 指定した単価。**請求額ではなく見積り。**
 *
 * 画面はそのまま送られる。クラウドを選ぶときは、
 * 個人情報や機密を含まない画面だけで試すこと。鍵と画面の中身は記録しない。
 *
 * 的は `tools/computer-use/typing-fixture.html`。Chrome で開き、同意の窓でその窓を選ぶ。
 * ネットワークも保存も使わない 1 枚で、3 語打てば CLEAR が出る——**終わりが画面に見える**。
 *
 *   open -a "Google Chrome" tools/computer-use/typing-fixture.html
 *   GEMINI_API_KEY=... node scripts/computer-model-compare.mjs \
 *     --cloud-model gemini-3.5-flash-lite --goals goals.json --out result.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? fallback : argv[at + 1];
};
const repo = resolve(new URL('..', import.meta.url).pathname);
const dist = `${repo}/workers/agent-host/dist/`;
process.env.ASTRA_DATA_ROOT ??= `${process.env.HOME}/Library/Application Support/Genie/local-preview/app`;

const { ComputerVisionRuntime } = await import(`${dist}computer-vision.js`);
const { NativeVisionDevice } = await import(`${dist}computer-vision-device.js`);
const { CloudModelBudget } = await import(`${dist}cloud-vision-budget.js`);
const { visionPromptFor } = await import(`${dist}computer-vision-prompts.js`);
const { locateImages } = await import(`${dist}visual-context.js`);

const localModel = flag('local-model', 'qwen3.5:9b');
const cloudModel = flag('cloud-model', 'gemini-3.5-flash-lite');
const localUrl = flag('local-url', 'http://127.0.0.1:11434/v1');
const cloudUrl = flag('cloud-url', 'https://generativelanguage.googleapis.com/v1beta/openai');
const helper = flag('helper', `${repo}/.build/computer/genie-computer-background`);
// 単価は利用者が指定する。**こちらで決め打ちにしない**（価格は変わるし、地域でも違う）。
const inPrice = Number(flag('usd-per-mtok-in', '0'));
const outPrice = Number(flag('usd-per-mtok-out', '0'));
const goals = JSON.parse(readFileSync(flag('goals', `${repo}/scripts/computer-compare-goals.json`), 'utf8'));
const key = process.env.GEMINI_API_KEY ?? '';
const which = flag('only', 'both');

function runner({ url, model, apiKey, tally }) {
  return {
    async run(step, signal) {
      const prompt = visionPromptFor(step.toolId, step.args);
      const content = [{ type: 'text', text: prompt }];
      for (const image of locateImages(step.args.images ?? [])) {
        if (!image.present) return { ok: false, error: { code: 'image_unavailable', message: '' } };
        content.push({
          type: 'image_url',
          image_url: { url: `data:image/png;base64,${readFileSync(image.path).toString('base64')}` },
        });
      }
      let response;
      try {
        response = await fetch(`${url}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
          body: JSON.stringify({
            model, temperature: 0, stream: false,
            ...(apiKey ? {} : { keep_alive: '30m' }),
            messages: [{ role: 'user', content }],
          }),
          signal,
        });
      } catch {
        return { ok: false, error: { code: 'llm.failed', message: '' } };
      }
      // 429 は「無料の分を使い切った」。掛け直さず、そのまま上へ返す。
      if (response.status === 429) return { ok: false, error: { code: 'llm.quota_exhausted', message: '' } };
      if (!response.ok) return { ok: false, error: { code: 'llm.failed', message: '' } };
      const body = await response.json();
      tally.calls += 1;
      tally.inTokens += body.usage?.prompt_tokens ?? 0;
      tally.outTokens += body.usage?.completion_tokens ?? 0;
      const text = body.choices?.[0]?.message?.content ?? '';
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) return { ok: false, error: { code: 'invalid_response', message: '' } };
      try { return { ok: true, result: JSON.parse(match[0]) }; }
      catch { return { ok: false, error: { code: 'invalid_response', message: '' } }; }
    },
  };
}

async function once(kind, goal) {
  const tally = { calls: 0, inTokens: 0, outTokens: 0 };
  const cloud = kind === 'cloud';
  if (cloud && !key) throw new Error('GEMINI_API_KEY is not set');
  const budget = new CloudModelBudget({
    statePath: `${process.env.ASTRA_DATA_ROOT}/VisualContext/cloud-model-ledger.json`,
  });
  const runtime = new ComputerVisionRuntime({
    enabled: true,
    model: runner(cloud ? { url: cloudUrl, model: cloudModel, apiKey: key, tally }
                        : { url: localUrl, model: localModel, tally }),
    selectModel: async () => (cloud ? 'gemini_api' : 'local'),
    allowExternalPixels: cloud,
    device: () => new NativeVisionDevice(helper),
    budget,
  });
  const at = new Date();
  const started = Date.now();
  const out = await runtime.run({
    id: `compare-${kind}-${started}`,
    toolId: 'computer.run',
    args: { goal: goal.goal, successCriteria: goal.criteria },
    approval: {
      approvalId: 'compare', operationId: 'computer.run', decision: 'APPROVED', decidedBy: 'user',
      decidedAt: at.toISOString(), expiresAt: new Date(at.getTime() + 600_000).toISOString(),
    },
  });
  const audit = out.result?.audit ?? [];
  return {
    model: cloud ? cloudModel : localModel,
    goal: goal.goal,
    completed: out.ok === true && out.result?.completed === true,
    stoppedAt: out.ok ? null : out.error.code,
    actions: audit.filter((row) => row.event !== 'goal_verification').length,
    // 送ったのに効果を確かめられなかった操作＝空振り。
    misoperations: audit.filter((row) => row.event !== 'goal_verification' && !row.verified).length,
    seconds: Number(((Date.now() - started) / 1000).toFixed(1)),
    modelCalls: tally.calls,
    inTokens: tally.inTokens,
    outTokens: tally.outTokens,
    costUsd: cloud
      ? Number(((tally.inTokens * inPrice + tally.outTokens * outPrice) / 1e6).toFixed(6))
      : 0,
  };
}

const rows = [];
for (const goal of goals) {
  for (const kind of which === 'both' ? ['local', 'cloud'] : [which]) {
    process.stderr.write(`# ${kind} ${goal.goal}\n`);
    try { rows.push(await once(kind, goal)); }
    catch (error) { rows.push({ model: kind, goal: goal.goal, error: String(error.message ?? error) }); }
  }
}
const summary = {};
for (const row of rows) {
  const at = (summary[row.model] ??= { runs: 0, completed: 0, misoperations: 0, seconds: 0, modelCalls: 0, costUsd: 0 });
  at.runs += 1;
  at.completed += row.completed ? 1 : 0;
  at.misoperations += row.misoperations ?? 0;
  at.seconds += row.seconds ?? 0;
  at.modelCalls += row.modelCalls ?? 0;
  at.costUsd = Number((at.costUsd + (row.costUsd ?? 0)).toFixed(6));
}
const report = { at: new Date().toISOString(), priceUsdPerMTok: { in: inPrice, out: outPrice }, summary, rows };
const out = flag('out', '');
if (out) writeFileSync(out, JSON.stringify(report, null, 1));
console.log(JSON.stringify(report, null, 1));

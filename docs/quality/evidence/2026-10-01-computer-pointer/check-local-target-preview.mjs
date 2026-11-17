// Recorded disposable fixture only. This never invokes NativeVisionDevice or delivers input.
// Run from any directory: node <this-file> <new-result-json-path>
import { copyFile, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { LlmRuntime } from '../../../../workers/agent-host/dist/llm-steps.js';
import { HttpLlmClient } from '../../../../workers/agent-host/dist/http-llm.js';
import { verdictOf } from '../../../../workers/agent-host/dist/computer-vision-policy.js';
if (!process.argv[2]) throw new Error('A new JSON result path is required.');
const dir = await mkdtemp(join(tmpdir(), 'genie-recorded-target-'));
const sha = (data) => createHash('sha256').update(data).digest('hex');
try {
  for (const [file, id] of [
    ['correct-lower', 'previewlower'],
    ['wrong-upper', 'previewupper'],
  ])
    await copyFile(
      new URL(`../target-preview/${file}.png`, import.meta.url),
      join(dir, `${id}.png`),
    );
  process.env.ASTRA_VISUAL_CONTEXT_DIR = dir;
  const llm = new LlmRuntime({
    allowedKinds: ['local'],
    http: {
      local: new HttpLlmClient({
        kind: 'local',
        endpoint: 'http://127.0.0.1:11434/v1',
        model: 'qwen3.5:9b',
        timeoutMs: 60_000,
        maxOutputTokens: 800,
      }),
    },
  });
  const frame = {
    id: 'distinct',
    width: 460,
    height: 372,
    sha256: 'a9e84bac7005952e5933cc788366071c28fd41d002ce1b2969af4a28c0ddf6a7',
  };
  const base = {
    phase: 'target',
    goal: 'Append a single X to the existing text in the lower large text area. Leave the upper small empty text area untouched.',
    vision_model_kind: 'local',
    frames: [frame],
    candidates: [
      { id: 'e0', role: 'AXButton', name: 'native-button' },
      { id: 'e1', role: 'AXImage', name: 'native-picture' },
      { id: 'e2', role: 'AXTextArea', name: 'native-field' },
      { id: 'e3', role: 'AXTextArea', name: 'native-other' },
    ],
    observation: { deliveryMode: 'background' },
  };
  const report = {
    scope:
      'Recorded native fixture, production preview renderer and LlmRuntime, actual local model, strict verdict parser. No native input, consent, frame freshness, or product E2E claim.',
    model: 'qwen3.5:9b',
    script: fileURLToPath(import.meta.url),
    scriptSha256: sha(await readFile(new URL(import.meta.url))),
    executedCode: {},
    cases: [],
  };
  for (const name of [
    'computer-vision-prompts',
    'computer-vision-policy',
    'llm-steps',
    'http-llm',
    'visual-context',
  ])
    report.executedCode[name] = sha(
      await readFile(new URL(`../../../../workers/agent-host/dist/${name}.js`, import.meta.url)),
    );
  for (const [name, id, elementId, target, text, expected] of [
    ['requested-lower-area', 'previewlower', 'e2', [40, 212, 420, 332], 'X', 'satisfied'],
    ['wrong-upper-area', 'previewupper', 'e3', [40, 152, 220, 202], 'X', 'not_satisfied'],
    ['wrong-text', 'previewlower', 'e2', [40, 212, 420, 332], 'Y', 'not_satisfied'],
  ]) {
    const png = await readFile(join(dir, `${id}.png`));
    const preview = {
      status: 'target_preview',
      id,
      width: png.readUInt32BE(16),
      height: png.readUInt32BE(20),
      sha256: sha(png),
      sourceFrameId: frame.id,
      sourceSha256: frame.sha256,
      elementId,
      target,
    };
    const started = Date.now();
    const response = await llm.run({
      id: name,
      toolId: 'llm.verify_computer_action',
      approval: null,
      args: {
        ...base,
        targetPreview: preview,
        images: [{ id, kind: 'screenshot', label: 'Exact input target' }],
        proposedInput: { action: 'type_keys', elementId, text },
      },
    });
    let verdict, error;
    try {
      verdict = verdictOf(response.result, frame);
    } catch (e) {
      error = e.message;
    }
    report.cases.push({
      name,
      preview,
      response,
      verdict,
      error,
      expected,
      pass: verdict?.outcome === expected,
      ms: Date.now() - started,
    });
  }
  report.status = report.cases.every((test) => test.pass) ? 'PASS' : 'FAIL';
  report.finishedAt = new Date().toISOString();
  await writeFile(process.argv[2], JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(
    `${report.status}: ${report.cases.filter((test) => test.pass).length}/3 recorded-image model checks`,
  );
  if (report.status !== 'PASS') process.exitCode = 1;
} finally {
  await rm(dir, { recursive: true, force: true });
}

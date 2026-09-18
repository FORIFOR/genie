import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LlmRuntime } from '../dist/llm-steps.js';
import { HttpLlmClient } from '../dist/http-llm.js';
import { NativeVisionDevice } from '../dist/computer-vision-device.js';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8X8AAAAASUVORK5CYII=',
  'base64',
);

test('existing VisualContext -> HTTP vision request carries two PNGs, structured response, and pinned provider', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'genie-vision-test-'));
  const old = process.env.ASTRA_VISUAL_CONTEXT_DIR;
  process.env.ASTRA_VISUAL_CONTEXT_DIR = dir;
  const requests = [];
  try {
    await writeFile(join(dir, 'before.png'), png, { mode: 0o600 });
    await writeFile(join(dir, 'after.png'), png, { mode: 0o600 });
    const client = new HttpLlmClient({
      kind: 'local',
      endpoint: 'http://127.0.0.1:11434/v1',
      model: 'test-vision',
      fetch: async (url, init) => {
        if (String(url).endsWith('/models'))
          return Response.json({ data: [{ id: 'test-vision' }] });
        requests.push(JSON.parse(init.body));
        return Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  frameId: 'after',
                  outcome: 'satisfied',
                  confidence: 0.95,
                  evidence: 'Visible',
                }),
              },
            },
          ],
        });
      },
    });
    const llm = new LlmRuntime({ allowedKinds: ['local'], http: { local: client } });
    const result = await llm.run({
      id: 'v',
      toolId: 'llm.verify_computer_action',
      approval: null,
      args: {
        goal: 'Open panel',
        phase: 'action',
        expectation: 'Panel appears',
        vision_model_kind: 'local',
        frames: [
          { id: 'before', width: 1, height: 1 },
          { id: 'after', width: 1, height: 1 },
        ],
        images: [
          { id: 'before', kind: 'screenshot', label: 'BEFORE' },
          { id: 'after', kind: 'screenshot', label: 'AFTER' },
        ],
      },
    });
    assert.equal(result.ok, true);
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].response_format, { type: 'json_object' });
    const images = requests[0].messages[1].content.filter((p) => p.type === 'image_url');
    assert.equal(images.length, 2);
    assert.equal(
      images.every((i) => i.image_url.url === 'data:image/png;base64,' + png.toString('base64')),
      true,
    );
    assert.equal(JSON.stringify(requests[0]).includes(dir), false);
    const denied = await llm.run({
      id: 'v2',
      toolId: 'llm.verify_computer_action',
      approval: null,
      args: { vision_model_kind: 'openai_api', images: [] },
    });
    assert.equal(denied.ok, false);
    assert.equal(requests.length, 1);
    const missing = await llm.run({
      id: 'v3',
      toolId: 'llm.plan_computer_action',
      approval: null,
      args: {
        vision_model_kind: 'local',
        images: [{ id: 'gone', kind: 'screenshot', label: 'CURRENT' }],
      },
    });
    assert.equal(missing.ok, false);
    assert.equal(requests.length, 1);
  } finally {
    if (old === undefined) delete process.env.ASTRA_VISUAL_CONTEXT_DIR;
    else process.env.ASTRA_VISUAL_CONTEXT_DIR = old;
    await rm(dir, { recursive: true, force: true });
  }
});

test('durable local claim prevents replay across device instances / restarts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'genie-vision-journal-'));
  const old = process.env.ASTRA_VISUAL_CONTEXT_DIR;
  process.env.ASTRA_VISUAL_CONTEXT_DIR = dir;
  try {
    await new NativeVisionDevice('/unused-helper').claim('same-request');
    await assert.rejects(
      new NativeVisionDevice('/unused-helper').claim('same-request'),
      /replay_blocked/,
    );
    await new NativeVisionDevice('/unused-helper').claim('new-request');
  } finally {
    if (old === undefined) delete process.env.ASTRA_VISUAL_CONTEXT_DIR;
    else process.env.ASTRA_VISUAL_CONTEXT_DIR = old;
    await rm(dir, { recursive: true, force: true });
  }
});

test('HTTP model cancellation passes an aborted signal, not a successful model result', async () => {
  const controller = new AbortController();
  const client = new HttpLlmClient({
    kind: 'local',
    endpoint: 'http://127.0.0.1:11434/v1',
    model: 'test-vision',
    fetch: async (_url, options) =>
      new Promise((_resolve, reject) => {
        assert.ok(options.signal);
        options.signal.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true },
        );
        controller.abort();
      }),
  });
  await assert.rejects(client.ask('check', [], controller.signal));
});

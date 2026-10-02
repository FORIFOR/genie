import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
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

test('native begin forwards an optional exact owned target, rejects malformed constraints and mismatched helper frames', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'genie-target-constraint-')));
  const old = process.env.ASTRA_VISUAL_CONTEXT_DIR;
  process.env.ASTRA_VISUAL_CONTEXT_DIR = dir;
  const helper = join(dir, 'helper.mjs');
  const requestPath = join(dir, 'request.json');
  const expectedTarget = { pid: 123, bundleId: 'org.genie.test-owned' };
  try {
    for (const mode of ['legacy', 'exact', 'wrong-pid', 'wrong-bundle']) {
      await writeFile(
        helper,
        `#!${process.execPath}
import { writeFile } from 'node:fs/promises';
let raw=''; for await (const chunk of process.stdin) raw+=chunk;
const request=JSON.parse(raw);
if(request.op!=='begin') throw new Error('unexpected operation');
await writeFile(${JSON.stringify(requestPath)},JSON.stringify(request));
const png=Buffer.from(${JSON.stringify(png.toString('base64'))},'base64');
await writeFile(request.outputPath,png,{mode:0o600});
process.stdout.write(JSON.stringify({id:request.id,pid:${mode === 'wrong-pid' ? 124 : 123},bundleId:${JSON.stringify(mode === 'wrong-bundle' ? 'org.genie.different' : expectedTarget.bundleId)},windowId:1,capturedAt:Date.now(),width:1,height:1,bounds:{x:0,y:0,width:1,height:1},sha256:${JSON.stringify(createHash('sha256').update(png).digest('hex'))}}));
`,
        { mode: 0o700 },
      );
      const device = new NativeVisionDevice(helper);
      await device.claim(`constraint-${dir}-${mode}`);
      try {
        const pending = device.begin(
          'Owned simulation',
          'local',
          new AbortController().signal,
          mode === 'legacy' ? undefined : expectedTarget,
        );
        if (mode.startsWith('wrong')) await assert.rejects(pending, /target_changed/);
        else assert.equal((await pending).pid, expectedTarget.pid);
        const request = JSON.parse(await readFile(requestPath, 'utf8'));
        assert.deepEqual(request.expectedTarget, mode === 'legacy' ? undefined : expectedTarget);
      } finally {
        await device.close();
      }
    }
    const device = new NativeVisionDevice('/does-not-exist');
    for (const target of [
      { pid: 0, bundleId: 'org.test' },
      { pid: 1.5, bundleId: 'org.test' },
      { pid: 2147483648, bundleId: 'org.test' },
      { pid: 123, bundleId: '' },
      { pid: 123 },
    ]) {
      await assert.rejects(
        device.begin('Owned simulation', 'local', new AbortController().signal, target),
        /invalid_expected_target/,
      );
    }
  } finally {
    if (old === undefined) delete process.env.ASTRA_VISUAL_CONTEXT_DIR;
    else process.env.ASTRA_VISUAL_CONTEXT_DIR = old;
    await rm(dir, { recursive: true, force: true });
  }
});

test('native preview adapter binds its request and validates actual PNG bytes before use, then removes them', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'genie-native-preview-')));
  const old = process.env.ASTRA_VISUAL_CONTEXT_DIR;
  process.env.ASTRA_VISUAL_CONTEXT_DIR = dir;
  const helper = join(dir, 'preview-helper.mjs');
  const requestPath = join(dir, 'request.json');
  const source = {
    id: 'cv-00000000-0000-4000-8000-000000000001',
    sha256: 'a'.repeat(64),
    width: 1000,
    height: 500,
    elements: [{ id: 'e9', role: 'AXTextArea', name: 'Editor' }],
  };
  const action = { action: 'type', frameId: source.id, target: [10, 20, 110, 60], text: 'hello' };
  try {
    for (const mode of ['valid', 'bad-hash', 'bad-dimensions', 'wrong-id']) {
      // A subprocess fake of the native protocol. This test never requests a
      // capture, consent, or native input and does not load AppKit.
      await writeFile(
        helper,
        `#!${process.execPath}
import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
let raw = ''; for await (const data of process.stdin) raw += data;
const request = JSON.parse(raw);
await writeFile(${JSON.stringify(requestPath)}, JSON.stringify(request));
if (request.op !== 'preview_target') throw new Error('Unexpected op');
const bytes = Buffer.from(${JSON.stringify(png.toString('base64'))}, 'base64');
await writeFile(request.outputPath, bytes, { mode: 0o600 });
process.stdout.write(JSON.stringify({
  status: 'target_preview', id: ${mode === 'wrong-id' ? JSON.stringify('cv-00000000-0000-4000-8000-000000000002') : 'request.id'},
  width: ${mode === 'bad-dimensions' ? 2 : 1}, height: 1,
  sha256: ${mode === 'bad-hash' ? JSON.stringify('b'.repeat(64)) : "createHash('sha256').update(bytes).digest('hex')"},
  sourceFrameId: request.scope.id, sourceSha256: request.scope.sha256,
  elementId: 'e9', target: [10, 20, 110, 60],
}));
`,
        { mode: 0o700 },
      );
      const device = new NativeVisionDevice(helper);
      await device.claim(`preview-${mode}`);
      const expiresAt = Date.now() + 30_000;
      let proof;
      if (mode === 'valid') {
        proof = await device.previewTarget(source, action, new AbortController().signal, expiresAt);
        assert.equal(proof.sourceFrameId, source.id);
        assert.equal(proof.elementId, 'e9');
        assert.deepEqual(proof.target, [10, 20, 110, 60]);
      } else {
        await assert.rejects(
          device.previewTarget(source, action, new AbortController().signal, expiresAt),
          mode === 'wrong-id' ? /invalid_target_preview/ : /image_mismatch/,
        );
      }
      const request = JSON.parse(await readFile(requestPath, 'utf8'));
      assert.equal(request.op, 'preview_target');
      assert.equal(request.referencePath, join(dir, `${source.id}.png`));
      assert.equal(request.authorizationExpiresAt, expiresAt);
      assert.deepEqual(request.action, action);
      assert.equal(request.outputPath, join(dir, `${request.id}.png`));
      await access(request.outputPath);
      if (proof) {
        // The native adapter accepted this file. Replacing the handover entry
        // afterward must still stop it at the actual model-read boundary.
        await writeFile(request.outputPath, Buffer.concat([png, Buffer.from('changed')]));
        let modelRequests = 0;
        const http = new HttpLlmClient({
          kind: 'local',
          endpoint: 'http://127.0.0.1:11434/v1',
          model: 'test-vision',
          fetch: async (url) => {
            if (String(url).endsWith('/models'))
              return Response.json({ data: [{ id: 'test-vision' }] });
            modelRequests++;
            throw new Error('Tampered pixels must not be sent');
          },
        });
        const llm = new LlmRuntime({ allowedKinds: ['local'], http: { local: http } });
        const outcome = await llm.run({
          id: 'changed-preview',
          toolId: 'llm.verify_computer_action',
          approval: null,
          args: {
            phase: 'target',
            goal: 'Fill the editor',
            vision_model_kind: 'local',
            frames: [source],
            images: [{ id: proof.id, kind: 'screenshot', label: 'PROPOSED_TARGET_PREVIEW' }],
            targetPreview: proof,
            proposedInput: { action: 'type', elementId: 'e9', text: 'hello' },
          },
        });
        assert.equal(outcome.error?.code, 'llm.image_unavailable');
        assert.equal(modelRequests, 0);
      }
      await device.close();
      await assert.rejects(access(request.outputPath), { code: 'ENOENT' });
    }
  } finally {
    if (old === undefined) delete process.env.ASTRA_VISUAL_CONTEXT_DIR;
    else process.env.ASTRA_VISUAL_CONTEXT_DIR = old;
    await rm(dir, { recursive: true, force: true });
  }
});

test('target verification carries one bound preview PNG through the production LlmRuntime HTTP path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'genie-vision-target-'));
  const old = process.env.ASTRA_VISUAL_CONTEXT_DIR;
  process.env.ASTRA_VISUAL_CONTEXT_DIR = dir;
  const requests = [];
  try {
    await writeFile(join(dir, 'preview.png'), png, { mode: 0o600 });
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
                  frameId: 'current',
                  outcome: 'satisfied',
                  confidence: 0.95,
                  evidence: 'The visible name field matches the requested target.',
                }),
              },
            },
          ],
        });
      },
    });
    const llm = new LlmRuntime({ allowedKinds: ['local'], http: { local: client } });
    const args = {
      phase: 'target',
      goal: 'Enter Genie in the name field',
      vision_model_kind: 'local',
      proposedInput: { action: 'type', elementId: 'e1', text: 'Genie' },
      frames: [{ id: 'current', width: 1, height: 1 }],
      images: [{ id: 'preview', kind: 'screenshot', label: 'PROPOSED_TARGET_PREVIEW' }],
      targetPreview: {
        id: 'preview',
        sourceFrameId: 'current',
        width: 1,
        height: 1,
        sha256: createHash('sha256').update(png).digest('hex'),
      },
    };
    const result = await llm.run({
      id: 'target',
      toolId: 'llm.verify_computer_action',
      approval: null,
      args,
    });
    assert.equal(result.ok, true);
    assert.equal(requests.length, 1);
    const content = requests[0].messages[1].content;
    assert.equal(content.filter((item) => item.type === 'image_url').length, 1);
    assert.match(content.find((item) => item.type === 'text').text, /BEFORE any input/);
    assert.equal(requests[0].reasoning_effort, 'none');
    const missing = await llm.run({
      id: 'missing',
      toolId: 'llm.verify_computer_action',
      approval: null,
      args: { ...args, images: [] },
    });
    assert.equal(missing.error?.code, 'llm.image_unavailable');
    const extra = await llm.run({
      id: 'extra',
      toolId: 'llm.verify_computer_action',
      approval: null,
      args: { ...args, images: [...args.images, ...args.images] },
    });
    assert.equal(extra.error?.code, 'llm.image_unavailable');
    const unbound = await llm.run({
      id: 'unbound',
      toolId: 'llm.verify_computer_action',
      approval: null,
      args: { ...args, targetPreview: undefined },
    });
    assert.equal(unbound.error?.code, 'llm.image_unavailable');
    const mismatched = await llm.run({
      id: 'mismatched',
      toolId: 'llm.verify_computer_action',
      approval: null,
      args: { ...args, targetPreview: { ...args.targetPreview, width: 2 } },
    });
    assert.equal(mismatched.error?.code, 'llm.image_unavailable');
    assert.equal(requests.length, 1);
  } finally {
    if (old === undefined) delete process.env.ASTRA_VISUAL_CONTEXT_DIR;
    else process.env.ASTRA_VISUAL_CONTEXT_DIR = old;
    await rm(dir, { recursive: true, force: true });
  }
});

test('Codex target dispatch uses a private read-only copy of validated bytes and cleans it on success or failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'genie-codex-target-'));
  const old = process.env.ASTRA_VISUAL_CONTEXT_DIR;
  process.env.ASTRA_VISUAL_CONTEXT_DIR = dir;
  const original = join(dir, 'preview.png');
  try {
    for (const fails of [false, true]) {
      await writeFile(original, png, { mode: 0o600 });
      let attached;
      const cli = {
        probe: async () => ({ available: true, reason: null, version: 'test' }),
        ask: async (_prompt, options) => {
          attached = options.images[0];
          assert.notEqual(attached, original);
          assert.equal((await stat(attached)).mode & 0o777, 0o400);
          assert.equal((await stat(join(attached, '..'))).mode & 0o777, 0o700);
          await writeFile(original, Buffer.concat([png, Buffer.from('replaced')]));
          assert.deepEqual(await readFile(attached), png);
          assert.equal(options.webSearch, false);
          if (fails) throw new Error('CLI failed');
          return {
            frameId: 'current',
            outcome: 'satisfied',
            confidence: 0.95,
            evidence: 'Matches',
          };
        },
      };
      const llm = new LlmRuntime({ allowedKinds: ['codex'], codex: cli });
      const result = await llm.run({
        id: 'target-copy',
        toolId: 'llm.verify_computer_action',
        approval: null,
        args: {
          phase: 'target',
          goal: 'Fill the editor',
          vision_model_kind: 'codex',
          frames: [{ id: 'current', width: 1, height: 1 }],
          images: [{ id: 'preview', kind: 'screenshot', label: 'PROPOSED_TARGET_PREVIEW' }],
          targetPreview: {
            id: 'preview',
            sourceFrameId: 'current',
            width: 1,
            height: 1,
            sha256: createHash('sha256').update(png).digest('hex'),
          },
          proposedInput: { action: 'type', elementId: 'e9', text: 'hello' },
        },
      });
      assert.equal(result.ok, !fails);
      assert.ok(attached);
      await assert.rejects(access(attached), { code: 'ENOENT' });
    }
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

test('moving preview storage does not forget a claim in the legacy cache', async () => {
  const home = await mkdtemp(join(tmpdir(), 'genie-legacy-home-'));
  const oldHome = process.env.HOME,
    oldCache = process.env.ASTRA_VISUAL_CONTEXT_DIR;
  process.env.HOME = home;
  try {
    process.env.ASTRA_VISUAL_CONTEXT_DIR = join(
      home,
      'Library',
      'Caches',
      'Astra',
      'VisualContext',
    );
    await new NativeVisionDevice('/unused-helper').claim('legacy-started-request');
    process.env.ASTRA_VISUAL_CONTEXT_DIR = join(home, 'isolated-preview', 'app', 'VisualContext');
    await assert.rejects(
      new NativeVisionDevice('/unused-helper').claim('legacy-started-request'),
      /replay_blocked/,
    );
    await new NativeVisionDevice('/unused-helper').claim('fresh-isolated-request');
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldCache === undefined) delete process.env.ASTRA_VISUAL_CONTEXT_DIR;
    else process.env.ASTRA_VISUAL_CONTEXT_DIR = oldCache;
    await rm(home, { recursive: true, force: true });
  }
});

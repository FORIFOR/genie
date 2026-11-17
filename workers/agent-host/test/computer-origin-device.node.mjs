import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const base = process.env.GENIE_VISION_TEST_DIST
  ? pathToFileURL(resolve(process.env.GENIE_VISION_TEST_DIST) + '/').href
  : new URL('../dist/', import.meta.url).href;
const { NativeVisionDevice } = await import(new URL('computer-vision-device.js', base));

test('native protocol pins origins through capture, preview and apply; old helpers fail closed', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'genie-origin-device-')));
  const previous = process.env.ASTRA_VISUAL_CONTEXT_DIR;
  process.env.ASTRA_VISUAL_CONTEXT_DIR = dir;
  const helper = join(dir, 'helper.mjs');
  const state = join(dir, 'state');
  const calls = join(dir, 'calls');
  const allowed = ['https://official.example'];
  const signal = new AbortController().signal;
  let device;
  try {
    await writeFile(state, 'valid');
    await writeFile(
      helper,
      `#!${process.execPath}
import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
let raw=''; for await (const chunk of process.stdin) raw+=chunk;
const request=JSON.parse(raw);
await appendFile(${JSON.stringify(calls)},JSON.stringify(request)+'\\n');
const mode=await readFile(${JSON.stringify(state)},'utf8');
if(request.op==='end') { process.stdout.write('{}'); process.exit(0); }
if(JSON.stringify(request.allowedOrigins)!==JSON.stringify(${JSON.stringify(allowed)})) throw Error('constraint missing');
if(request.op==='apply') {
  process.stdout.write(JSON.stringify(mode==='redirect' ? {error:'document_origin_changed'} : {status:'applied',effect:'confirmed'}));
  process.exit(0);
}
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8X8AAAAASUVORK5CYII=','base64');
const hash=createHash('sha256').update(png).digest('hex');
await writeFile(request.outputPath,png,{mode:0o600});
if(request.op==='preview_target') {
  process.stdout.write(JSON.stringify({status:'target_preview',id:request.id,width:1,height:1,sha256:hash,sourceFrameId:request.scope.id,sourceSha256:request.scope.sha256,elementId:'e1',elementRole:'AXTextField',target:[0,0,10,10]})); process.exit(0);
}
process.stdout.write(JSON.stringify({id:request.id,pid:123,bundleId:'com.apple.Safari',windowId:1,capturedAt:Date.now(),width:1,height:1,bounds:{x:0,y:0,width:10,height:10},sha256:hash,deliveryMode:'background',backgroundSession:'fixture',...(mode==='old' ? {} : {documentOrigin:mode==='redirect'?'https://untrusted.example':'https://official.example',allowedOrigins:request.allowedOrigins})}));
`,
      { mode: 0o700 },
    );
    device = new NativeVisionDevice(helper);
    await device.claim(`origin-protocol-${dir}`);
    const initial = await device.begin('Prepare cart', 'local', signal, undefined, allowed);
    assert.equal(initial.documentOrigin, allowed[0]);
    const current = await device.capture(initial, signal);
    assert.deepEqual(current.allowedOrigins, allowed);
    const action = {
      action: 'click',
      elementId: 'e1',
      frameId: current.id,
      expectation: 'cart visible',
      confidence: 0.95,
      risk: 'navigation',
    };
    // Protocol fixture, not a native AX capture: enlarge the source metadata so
    // a meaningful target rectangle can accompany the one-pixel preview PNG.
    await device.previewTarget(
      { ...current, width: 1000, height: 500 },
      { ...action, action: 'type', text: 'dummy' },
      signal,
      Date.now() + 30000,
    );
    await device.apply(current, action, signal, Date.now() + 30000);
    await writeFile(state, 'redirect');
    await assert.rejects(
      device.apply(current, action, signal, Date.now() + 30000),
      /document_origin_changed/,
    );
    await assert.rejects(device.capture(initial, signal), /document_origin_not_allowed/);
    await writeFile(state, 'old');
    await assert.rejects(device.capture(initial, signal), /document_origin_unavailable/);
    const requests = (await readFile(calls, 'utf8')).trim().split('\n').map(JSON.parse);
    for (const request of requests) assert.deepEqual(request.allowedOrigins, allowed);
    assert.deepEqual(
      requests.map((r) => r.op),
      ['begin', 'capture', 'preview_target', 'apply', 'apply', 'capture', 'capture'],
    );
  } finally {
    await device?.close();
    if (previous === undefined) delete process.env.ASTRA_VISUAL_CONTEXT_DIR;
    else process.env.ASTRA_VISUAL_CONTEXT_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

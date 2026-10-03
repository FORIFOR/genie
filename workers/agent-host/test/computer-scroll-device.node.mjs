import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const base = process.env.GENIE_VISION_TEST_DIST
  ? pathToFileURL(resolve(process.env.GENIE_VISION_TEST_DIST) + '/').href
  : new URL('../dist/', import.meta.url).href;
const { NativeVisionDevice } = await import(new URL('computer-vision-device.js', base));
const receipt = { direction:'down', before:0, after:0.1, deltaPoints:95, viewportPoints:190 };

for (const [name, result, valid] of [
  ['confirmed native receipt', { status:'applied', route:'ax_scroll', effect:'confirmed', scroll:receipt }, true],
  ['missing native receipt', { status:'applied', route:'ax_scroll', effect:'confirmed' }, false],
  ['unconfirmed dispatch', { status:'applied', route:'ax_scroll', effect:'unconfirmed', scroll:receipt }, false],
  ['wrong direction', { status:'applied', route:'ax_scroll', effect:'confirmed', scroll:{...receipt,direction:'up'} }, false],
]) test(`native scroll adapter: ${name}`, async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'genie-scroll-device-')));
  const old = process.env.ASTRA_VISUAL_CONTEXT_DIR;
  process.env.ASTRA_VISUAL_CONTEXT_DIR = dir;
  const helper = join(dir, 'fake-helper.mjs'), requestFile=join(dir, 'request.json');
  await writeFile(helper, `#!${process.execPath}\nimport { readFileSync,writeFileSync } from 'node:fs';\nconst request=JSON.parse(readFileSync(0,'utf8'));\nwriteFileSync(${JSON.stringify(requestFile)},JSON.stringify(request));\nconsole.log(${JSON.stringify(JSON.stringify(result))});\n`, {mode:0o700});
  const device=new NativeVisionDevice(helper);
  try {
    await device.claim(randomUUID());
    const frame={id:'cv-00000000-0000-4000-8000-000000000001',bundleId:'fixture',pid:42,windowId:1,
      capturedAt:Date.now(),width:100,height:100,bounds:{x:0,y:0,width:100,height:100},sha256:'a'.repeat(64),deliveryMode:'background'};
    const action={action:'scroll',direction:'down',elementId:'e2',frameId:frame.id,expectation:'next rows visible',confidence:1,risk:'navigation'};
    const expiry=Date.now()+10000;
    if(valid) assert.deepEqual(await device.apply(frame,action,new AbortController().signal,expiry),
      {route:'ax_scroll',effect:'confirmed',scroll:receipt});
    else await assert.rejects(device.apply(frame,action,new AbortController().signal,expiry),/input_effect_unconfirmed/);
    const request=JSON.parse(await readFile(requestFile,'utf8'));
    assert.equal(request.op,'apply');
    assert.deepEqual(request.action,action);
    assert.equal(request.authorizationExpiresAt,expiry);
    assert.equal(request.referencePath,join(dir,frame.id+'.png'));
  } finally {
    await device.close();
    if(old===undefined) delete process.env.ASTRA_VISUAL_CONTEXT_DIR; else process.env.ASTRA_VISUAL_CONTEXT_DIR=old;
    await rm(dir,{recursive:true,force:true});
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { HOOK_EVENTS, withHooks, withoutHooks } from '../claude-code-hooks.mjs';

const run = promisify(execFile);
const HOOK = fileURLToPath(new URL('../claude-code-hook.sh', import.meta.url));
const BASE = 'http://127.0.0.1:43123';

const theirs = { hooks: [{ type: 'command', command: '/usr/local/bin/notify-me' }] };

test('adds async hooks for every watched event and keeps the user’s own hooks', () => {
  const before = { model: 'opus', hooks: { Stop: [theirs], PreToolUse: [theirs] } };
  const after = withHooks(before, BASE);
  assert.equal(after.model, 'opus');
  assert.deepEqual(after.hooks.PreToolUse, [theirs]);
  assert.deepEqual(after.hooks.Stop[0], theirs);
  for (const event of HOOK_EVENTS) {
    const ours = after.hooks[event].at(-1).hooks[0];
    assert.equal(ours.type, 'command');
    assert.equal(ours.async, true, `${event} must not make Claude Code wait`);
    assert.ok(ours.command.includes(HOOK) && ours.command.endsWith(BASE));
  }
  // 元の settings は書き換えない
  assert.deepEqual(before.hooks.Stop, [theirs]);
});

test('installing twice does not add the hooks twice', () => {
  const twice = withHooks(withHooks({}, BASE), BASE);
  for (const event of HOOK_EVENTS) assert.equal(twice.hooks[event].length, 1);
});

test('uninstall removes only Genie’s hooks', () => {
  const installed = withHooks({ hooks: { Stop: [theirs] }, env: { A: '1' } }, BASE);
  const removed = withoutHooks(installed);
  assert.deepEqual(removed, { hooks: { Stop: [theirs] }, env: { A: '1' } });
  assert.deepEqual(withoutHooks(withHooks({}, BASE)), {});
});

test('the hook never fails and never sends anywhere but this Mac', async () => {
  for (const base of [
    'https://example.com',
    'http://10.0.0.5:43123',
    '',
    'http://127.0.0.1.evil:1',
    'http://127.0.0.1:1@evil.example',
    'http://localhost:43123/x',
  ]) {
    const { stdout } = await run('/bin/sh', [HOOK, base], { timeout: 5000 });
    assert.equal(stdout, '');
    // 鍵を読みにも行かない（sh -x の足跡に security も curl も出ない）
    const { stderr: trace } = await run('/bin/sh', ['-x', HOOK, base], { timeout: 5000 });
    assert.doesNotMatch(trace, /security|curl/, `${base} must be refused before the key is read`);
  }
  // 手元の宛先は通す（鍵を読みに行く）
  const { stderr: allowed } = await run('/bin/sh', ['-x', HOOK, 'http://localhost:1'], {
    timeout: 5000,
  });
  assert.match(allowed, /security find-generic-password/);
  // 手元の宛先でも、鍵が無ければ黙って 0 で終わる
  const { stdout, stderr } = await run('/bin/sh', [HOOK, 'http://127.0.0.1:1'], { timeout: 5000 });
  assert.equal(stdout + stderr, '');
});

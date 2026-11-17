import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RECOVERY_DELAYS_MS,
  recoverInfrastructure,
  redisAofCorrupt,
  repairRedisArgs,
} from '../local-preview/recovery.mjs';

const compose = ['--context', 'c', 'compose', '-p', 'genie-preview-x', '-f', 'compose.json'];
// 2026-10-19 に実際に出た redis のログ
const corrupt =
  '1:M 19 Oct 2026 11:01:26.509 # Bad file format reading the append only file appendonly.aof.5.incr.aof: make a backup of your AOF file, then use ./redis-check-aof --fix <filename.manifest>';

test('restarts the stores once Docker is back, without touching redis data', async () => {
  const calls = [];
  const done = await recoverInfrastructure({
    run: async (name, args) => calls.push([name, args]),
    logs: async () => assert.fail('logs are read only after a failed restart'),
    composeArgs: compose,
  });
  assert.equal(done, 'restarted');
  assert.deepEqual(
    calls.map(([name]) => name),
    ['infrastructure'],
  );
  assert.ok(calls[0][1].includes('--wait'));
});

test('repairs a corrupt redis append-only file only when redis says so, keeping one copy', async () => {
  const calls = [];
  let first = true;
  const done = await recoverInfrastructure({
    run: async (name, args) => {
      calls.push(name);
      if (name === 'infrastructure' && first) {
        first = false;
        throw new Error('redis exited (1)');
      }
    },
    logs: async (service) => (service === 'redis' ? corrupt : ''),
    composeArgs: compose,
  });
  assert.equal(done, 'repaired');
  assert.deepEqual(calls, ['infrastructure', 'redis-repair', 'infrastructure']);
  const script = repairRedisArgs(compose).at(-1);
  assert.match(script, /cp -a \/data\/appendonlydir \/data\/appendonlydir\.before-repair/);
  assert.match(script, /rm -rf \/data\/appendonlydir\.before-repair;/);
  assert.match(script, /redis-check-aof --fix appendonly\.aof\.manifest/);
});

test('does not repair anything for other failures, and gives up after a few tries', async () => {
  const calls = [];
  await assert.rejects(
    recoverInfrastructure({
      run: async (name) => {
        calls.push(name);
        throw new Error('Cannot connect to the Docker daemon');
      },
      logs: async () => 'Ready to accept connections',
      composeArgs: compose,
    }),
    /Docker daemon/,
  );
  assert.deepEqual(calls, ['infrastructure']);
  assert.equal(redisAofCorrupt('Ready to accept connections'), false);
  assert.equal(redisAofCorrupt(corrupt), true);
  assert.ok(RECOVERY_DELAYS_MS.length <= 5);
});

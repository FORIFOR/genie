import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, chmod, symlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileExecutionStore } from '../src/execution-store.js';
import {
  ExecutionRuntime,
  executionDigest,
  type ExecutionAdapter,
} from '../src/execution-runtime.js';
import {
  intentOf,
  matchesReadback,
  selectExecutionRoute,
  type ExecutionCapability,
  type PreparedExecution,
} from '../src/execution-policy.js';
import type { HostStep } from '../src/connector-steps.js';

const now = Date.parse('2026-09-19T03:00:00Z');
const goal = 'Gmailで a@example.com 宛て、件名「確認」、本文「明日お願いします」の下書きを保存して';
const intent = {
  operation: 'mail.draft' as const,
  parameters: { to: ['a@example.com'], subject: '確認', body: '明日お願いします' },
};
const proof = {
  approvalId: 'approval-1',
  operationId: 'execution.apply',
  decision: 'APPROVED' as const,
  decidedBy: 'user',
  decidedAt: new Date(now - 1000).toISOString(),
  expiresAt: new Date(now + 60_000).toISOString(),
};
const capability = (
  id = 'api:mail',
  route: ExecutionCapability['route'] = 'api',
): ExecutionCapability => ({
  id,
  route,
  label: 'Gmail',
  fingerprint: 'a'.repeat(64),
  operations: ['mail.draft'],
  verification: 'readback',
});
function harness(
  options: { verified?: boolean; candidates?: ExecutionCapability[]; proposal?: unknown } = {},
) {
  const values = new Map<string, PreparedExecution>();
  const claims = new Set<string>();
  const adapters: ExecutionAdapter[] = (options.candidates ?? [capability()]).map((c) => ({
    id: c.id,
    probe: vi.fn(async () => c),
    execute: vi.fn(async () => ({ verified: options.verified ?? true, evidence: 'b'.repeat(64) })),
  }));
  const model = {
    handles: () => true,
    run: vi.fn(async () => ({ ok: true, result: options.proposal ?? intent })),
  };
  const runtime = new ExecutionRuntime({
    model,
    adapters,
    now: () => now,
    deviceId: 'device-1',
    store: {
      async save(value) {
        const item = { ...value, id: 'plan-1' };
        values.set(item.id, structuredClone(item));
        return item;
      },
      async load(id) {
        if (!values.has(id)) throw new Error('missing');
        return structuredClone(values.get(id)!);
      },
      async claim(id) {
        if (claims.has(id)) throw new Error('replay');
        claims.add(id);
      },
    },
  });
  const prepare = () =>
    runtime.run({ id: 'prepare-1', toolId: 'execution.prepare', args: { goal }, approval: null });
  const apply = (prepared: unknown, approval: HostStep['approval'] = proof) =>
    runtime.run({ id: 'apply-1', toolId: 'execution.apply', args: { prepared }, approval });
  return { runtime, adapters, model, prepare, apply, claims, values };
}

describe('verified execution policy', () => {
  it('chooses real API before MCP regardless of registration order', () => {
    expect(selectExecutionRoute(intent, [capability('mcp:mail', 'mcp'), capability()])?.route).toBe(
      'api',
    );
  });
  it('never downgrades saved-data requirements to a visual check', () => {
    expect(
      selectExecutionRoute(intent, [{ ...capability('vision', 'vision'), verification: 'visual' }]),
    ).toBeNull();
  });
  it('does not invent a recipient or allow text tool proposals to become shell', () => {
    expect(
      intentOf({ ...intent, parameters: { ...intent.parameters, to: ['evil@example.com'] } }, goal),
    ).toBeNull();
    expect(intentOf({ operation: 'shell', parameters: { command: 'whoami' } }, goal)).toBeNull();
  });
  it.each(['送信して', '支払って', '請求書を保存して', '削除して'])(
    'refuses high-risk visual fallback %s',
    (command) => {
      expect(
        intentOf({ operation: 'computer.run', parameters: {} }, `このアプリ画面で${command}`),
      ).toBeNull();
    },
  );
  it('compares entire readback, not a true success flag', () => {
    const read = {
      id: 'draft-1',
      to: ['a@example.com'],
      subject: '確認',
      body: '明日お願いします',
      draft: true,
    };
    expect(matchesReadback(intent, 'draft-1', read)).toBe(true);
    for (const changed of [
      { id: 'other' },
      { to: ['b@example.com'] },
      { subject: 'other' },
      { body: 'other' },
      { draft: false },
    ])
      expect(matchesReadback(intent, 'draft-1', { ...read, ...changed, verified: true })).toBe(
        false,
      );
  });
  it('canonical digest survives PostgreSQL jsonb key ordering', () => {
    expect(executionDigest({ b: { x: 1, y: 2 }, a: 3 })).toBe(
      executionDigest({ a: 3, b: { y: 2, x: 1 } }),
    );
  });
});

describe('prepare -> approve -> apply -> receipt', () => {
  it('prepares without mutation, then applies only the exact approved proposal once', async () => {
    const h = harness();
    const prepared = (await h.prepare()).result as PreparedExecution;
    expect(prepared.status).toBe('ready');
    expect(prepared.deviceId).toBe('device-1');
    expect(prepared.details.some((x) => x.value === '明日お願いします')).toBe(true);
    expect(h.adapters[0]!.execute).not.toHaveBeenCalled();
    expect((await h.apply(prepared, null)).ok).toBe(false);
    expect(
      (
        await h.apply({
          ...prepared,
          intent: { ...intent, parameters: { ...intent.parameters, body: 'changed' } },
        })
      ).ok,
    ).toBe(false);
    const result = await h.apply(prepared);
    expect(result.ok).toBe(true);
    expect(result.result).toMatchObject({ receipt: { status: 'verified', level: 'readback' } });
    expect((await h.apply(prepared)).ok).toBe(false);
    expect(h.adapters[0]!.execute).toHaveBeenCalledTimes(1);
  });
  it('pins a route instead of changing providers after approval', async () => {
    const h = harness({ candidates: [capability(), capability('mcp:mail', 'mcp')] });
    const prepared = (await h.prepare()).result;
    vi.mocked(h.adapters[0]!.probe).mockResolvedValue({ ...capability(), fingerprint: 'changed' });
    expect((await h.apply(prepared)).ok).toBe(false);
    expect(h.adapters[1]!.execute).not.toHaveBeenCalled();
  });
  it('never falls back/repeats when write or readback fails', async () => {
    const h = harness({ candidates: [capability(), capability('mcp:mail', 'mcp')] });
    const prepared = (await h.prepare()).result;
    vi.mocked(h.adapters[0]!.execute).mockRejectedValue(new Error('connection lost after POST'));
    expect((await h.apply(prepared)).result).toMatchObject({
      receipt: { status: 'unverified', level: null },
    });
    expect(h.adapters[1]!.execute).not.toHaveBeenCalled();
    expect((await h.apply(prepared)).ok).toBe(false);
  });
  it('does not promote failed verification to a success badge', async () => {
    const h = harness({ verified: false });
    expect((await h.apply((await h.prepare()).result)).result).toMatchObject({
      receipt: { status: 'unverified', level: null, evidence: null },
    });
  });
  it('requires nonempty, matching, unexpired approval', async () => {
    const h = harness();
    const p = (await h.prepare()).result;
    for (const approval of [
      { ...proof, operationId: 'other' },
      { ...proof, expiresAt: 'invalid' },
      { ...proof, expiresAt: new Date(now).toISOString() },
      { ...proof, decidedBy: '' },
    ])
      expect((await h.apply(p, approval)).ok).toBe(false);
    expect(h.adapters[0]!.execute).not.toHaveBeenCalled();
  });
  it('stops a cancelled prepare before any model call', async () => {
    const h = harness();
    const abort = new AbortController();
    abort.abort();
    expect(
      (
        await h.runtime.run(
          { id: 'p', toolId: 'execution.prepare', args: { goal }, approval: null },
          abort.signal,
        )
      ).ok,
    ).toBe(false);
    expect(h.model.run).not.toHaveBeenCalled();
  });
  it('returns blocked work without a mutation or false verification', async () => {
    const h = harness({ candidates: [] });
    const prepared = (await h.prepare()).result as PreparedExecution;
    expect(prepared.status).toBe('unavailable');
    const result = await h.runtime.run({
      id: 'report',
      toolId: 'execution.report',
      args: { prepared },
      approval: null,
    });
    expect(result.result).toMatchObject({ receipt: { status: 'unavailable', evidence: null } });
  });
  it('does not interpret an arbitrary report as a verified action', async () => {
    const h = harness();
    const result = await h.runtime.run({
      id: 'report',
      toolId: 'execution.report',
      args: { prepared: { status: 'verified' } },
      approval: null,
    });
    expect(result.result).toMatchObject({ receipt: { status: 'unavailable' } });
  });
  it('serializes concurrent preparation, not just concurrent mutation', async () => {
    const h = harness();
    let release!: () => void;
    h.model.run.mockImplementationOnce(async () => {
      await new Promise<void>((r) => (release = r));
      return { ok: true, result: intent };
    });
    const first = h.prepare();
    await vi.waitFor(() => expect(release).toBeDefined());
    expect((await h.prepare()).error?.code).toBe('execution.busy');
    release();
    await first;
  });
});

describe('private immutable plans', () => {
  it('persists replay refusal after restart and refuses path traversal/symlinks', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'genie-execution-'));
    try {
      const store = new FileExecutionStore(dir);
      const p = await store.save({
        version: 1,
        status: 'needs_input',
        goal: 'test',
        intent: null,
        capability: null,
        message: 'test',
        expiresAt: now + 1,
        details: [],
      });
      await store.claim(p.id);
      await expect(new FileExecutionStore(dir).claim(p.id)).rejects.toThrow();
      await expect(store.load('../escape')).rejects.toThrow();
      const file = join(dir, `${p.id}.json`);
      await rm(file);
      await symlink('/etc/passwd', file);
      await expect(store.load(p.id)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

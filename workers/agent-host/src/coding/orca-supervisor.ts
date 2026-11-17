/** Observe an approved Orca launch until its first turn finishes or hits a quota wall. */
import { OrcaAdapter, OrcaError, type CodingAgent, type OrcaTurnState } from './orca-adapter.js';
import { probeCodingQuota, type QuotaProbe } from './orca-action-runner.js';

export interface OrcaSupervisionJob {
  requestId: string;
  taskId: string;
  path: string;
  agent: CodingAgent;
  fallbackAgent: CodingAgent;
  prompt: string;
  terminal: string;
  approvalExpiresAt: string;
  switchingSince: string | null;
}
export type OrcaSupervisionOutcome =
  | { state: 'finished' }
  | { state: 'blocked' | 'uncertain'; reason: string }
  | { state: 'switched'; terminal: string; agent: CodingAgent };

type Port = Pick<OrcaAdapter, 'observe' | 'activeAgents' | 'closeForHandoff' | 'launch'>;

export interface OrcaSupervisionTransport {
  list(hostId: string): Promise<readonly OrcaSupervisionJob[]>;
  begin(hostId: string, requestId: string): Promise<boolean>;
  finish(hostId: string, requestId: string, outcome: OrcaSupervisionOutcome): Promise<void>;
}

export function httpOrcaSupervisionTransport(config: {
  baseUrl: string;
  token: string;
  fetch?: typeof globalThis.fetch;
}): OrcaSupervisionTransport {
  const fetchImpl = config.fetch ?? globalThis.fetch;
  const call = async (path: string, method: 'GET' | 'POST', body?: unknown): Promise<unknown> => {
    const response = await fetchImpl(config.baseUrl + path, {
      method,
      headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Orca supervision HTTP ${response.status}`);
    return response.status === 204 ? null : response.json();
  };
  return {
    async list(hostId) {
      const response = (await call(
        `/v1/host-steps/orca-supervisions?host_id=${encodeURIComponent(hostId)}`,
        'GET',
      )) as { items?: unknown };
      if (!Array.isArray(response?.items)) throw new Error('Invalid Orca supervision list');
      return response.items as OrcaSupervisionJob[];
    },
    async begin(hostId, requestId) {
      const response = (await call(
        `/v1/host-steps/${encodeURIComponent(requestId)}/orca-supervision/begin`,
        'POST',
        { host_id: hostId },
      )) as { claimed?: unknown };
      if (typeof response?.claimed !== 'boolean') throw new Error('Invalid Orca supervision claim');
      return response.claimed;
    },
    async finish(hostId, requestId, outcome) {
      await call(
        `/v1/host-steps/${encodeURIComponent(requestId)}/orca-supervision/finish`,
        'POST',
        { host_id: hostId, outcome },
      );
    },
  };
}

function handoffPrompt(original: string): string | null {
  const prefix =
    'Continue this coding task in the existing repository. First inspect current files and Git status. Continue only unfinished work; do not repeat external operations already performed. Do not push, deploy, or delete without explicit approval.\n\nOriginal task:\n';
  return prefix.length + original.length <= 8_000 ? prefix + original : null;
}

export class OrcaSupervisor {
  #timer: ReturnType<typeof setInterval> | null = null;
  #running = false;
  readonly #pending = new Map<string, OrcaSupervisionOutcome>();
  readonly #idleSince = new Map<string, number>();

  constructor(
    private readonly deps: {
      hostId: string;
      transport: OrcaSupervisionTransport;
      port: Port;
      quotaProbe?: QuotaProbe;
      now?: () => number;
      onError?: (message: string) => void;
    },
  ) {}

  start(intervalMs = 10_000): void {
    if (this.#timer) return;
    this.#timer = setInterval(
      () =>
        void this.tick().catch((error: unknown) =>
          this.deps.onError?.(error instanceof Error ? error.message : 'unknown'),
        ),
      intervalMs,
    );
    this.#timer.unref?.();
    void this.tick().catch((error: unknown) =>
      this.deps.onError?.(error instanceof Error ? error.message : 'unknown'),
    );
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  async tick(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      for (const [id, outcome] of this.#pending) {
        await this.deps.transport.finish(this.deps.hostId, id, outcome);
        this.#pending.delete(id);
      }
      const jobs = await this.deps.transport.list(this.deps.hostId);
      for (const job of jobs) await this.#check(job);
    } finally {
      this.#running = false;
    }
  }

  async #settle(job: OrcaSupervisionJob, outcome: OrcaSupervisionOutcome): Promise<void> {
    this.#pending.set(job.requestId, outcome);
    await this.deps.transport.finish(this.deps.hostId, job.requestId, outcome);
    this.#pending.delete(job.requestId);
  }

  async #check(job: OrcaSupervisionJob): Promise<void> {
    const now = this.deps.now?.() ?? Date.now();
    if (job.switchingSince) {
      if (now - Date.parse(job.switchingSince) > 120_000)
        await this.#settle(job, {
          state: 'uncertain',
          reason: '引き継ぎ中に端末が中断されました。',
        });
      return;
    }
    if (Date.parse(job.approvalExpiresAt) <= now) {
      await this.#settle(job, {
        state: 'blocked',
        reason: '代替エージェントの承認期限が切れました。',
      });
      return;
    }
    const state: OrcaTurnState = await this.deps.port.observe(job.path, job.agent, job.terminal);
    if (state === 'idle') {
      const first = this.#idleSince.get(job.requestId);
      if (first === undefined) {
        this.#idleSince.set(job.requestId, now);
        return;
      }
      // Orca can briefly report TUI idle just after accepting a prompt, before
      // the provider replies. Confirm stable idle before ending supervision.
      if (now - first < 20_000) return;
    } else {
      this.#idleSince.delete(job.requestId);
    }
    if (state === 'exited') {
      await this.#settle(job, {
        state: 'uncertain',
        reason: '元の端末が応答結果を確認する前に終了しました。',
      });
      return;
    }
    if (state === 'idle') {
      await this.#settle(job, { state: 'finished' });
      return;
    }
    if (state !== 'quota') return;
    const prompt = handoffPrompt(job.prompt);
    if (!prompt) {
      await this.#settle(job, {
        state: 'blocked',
        reason: '引き継ぎ文が長すぎます。端末で続けてください。',
      });
      return;
    }
    const active = await this.deps.port.activeAgents(job.path);
    if (active.length !== 1 || active[0] !== job.terminal) {
      await this.#settle(job, {
        state: 'uncertain',
        reason: '元の端末だけが動いていると確認できません。',
      });
      return;
    }
    const available = await (this.deps.quotaProbe ?? probeCodingQuota)(job.fallbackAgent);
    if (available !== 'available') {
      await this.#settle(job, {
        state: 'blocked',
        reason:
          available === 'rate_limited'
            ? '代替エージェントも利用上限に達しています。'
            : '代替エージェントを利用できるか確認できません。',
      });
      return;
    }
    if (!(await this.deps.transport.begin(this.deps.hostId, job.requestId))) return;
    let terminal: string;
    try {
      await this.deps.port.closeForHandoff(job.path, job.terminal);
      if ((await this.deps.port.activeAgents(job.path)).length)
        throw new OrcaError('delivery_unconfirmed', '別のエージェントが既に動いています。');
      const launched = await this.deps.port.launch(job.path, job.fallbackAgent, prompt);
      terminal = launched.terminal;
    } catch {
      // After the claim, a lost reply can mean the replacement already started. Never resend it.
      await this.#settle(job, { state: 'uncertain', reason: '引き継ぎの結果を確認できません。' });
      return;
    }
    await this.#settle(job, { state: 'switched', terminal, agent: job.fallbackAgent });
  }
}

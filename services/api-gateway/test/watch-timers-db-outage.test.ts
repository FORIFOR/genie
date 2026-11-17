/**
 * 保存サービスが一時的に止まっても、見守りのタイマーが gateway を落とさない（2026-11-08 実際に落ちた:
 * opencode の見守りの tick が「timeout exceeded when trying to connect」を取りこぼし、プロセスが終了した）。
 */
import type { DbHandle } from '@genie/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentJobs } from '../src/agent-jobs.js';
import { AgentSessionWatch } from '../src/agent-session-watch.js';
import { OpencodeWatchService } from '../src/opencode-watch.js';

/** どこを触っても「つながらない」で落ちる保存サービス */
const downDb = new Proxy(
  {},
  {
    get: () => {
      throw new Error('timeout exceeded when trying to connect');
    },
  },
) as unknown as DbHandle;

const rejections: unknown[] = [];
const onRejection = (reason: unknown) => rejections.push(reason);

afterEach(() => {
  process.off('unhandledRejection', onRejection);
  rejections.length = 0;
});

async function startAndWait(start: (log: (event: string) => void) => { stop(): void }) {
  process.on('unhandledRejection', onRejection);
  const events: string[] = [];
  const service = start((event) => events.push(event));
  await vi.waitFor(() => expect(events.length).toBeGreaterThan(0));
  // 取りこぼしは次のマイクロタスク以降に出るので、少し待ってから見る
  await new Promise((r) => setTimeout(r, 20));
  service.stop();
  expect(rejections).toEqual([]);
  return events;
}

describe('見守りのタイマーは保存サービスが止まっても落ちない', () => {
  it('opencode の見守り', async () => {
    const events = await startAndWait((log) => {
      const s = new OpencodeWatchService({ db: downDb, notify: async () => {}, log });
      s.start(60_000);
      return s;
    });
    expect(events).toContain('opencode_watch.tick_failed');
  });

  it('エージェントのセッションの見守り', async () => {
    const events = await startAndWait((log) => {
      const s = new AgentSessionWatch({ db: downDb, log });
      s.start(60_000);
      return s;
    });
    expect(events).toContain('agent_session_watch.tick_failed');
  });

  it('Genie が動かす仕事', async () => {
    const events = await startAndWait((log) => {
      const s = new AgentJobs({ db: downDb, adapters: {}, log });
      s.start(60_000);
      return s;
    });
    expect(events).toContain('agent_jobs.tick_failed');
  });
});

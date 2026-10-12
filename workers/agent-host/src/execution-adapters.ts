import { access, constants, readFile } from 'node:fs/promises';
import type { ConnectorRuntime, HostStep } from './connector-steps.js';
import {
  matchesReadback,
  object,
  type ExecutionIntent,
  type ExecutionCapability,
} from './execution-policy.js';
import { executionDigest, type ExecutionAdapter } from './execution-runtime.js';
import type { ComputerVisionRuntime } from './computer-vision.js';
import type { StepRunner } from './step-loop.js';
import { runExecutionHelper } from './execution-ax.js';

export function apiExecutionAdapters(connectors: ConnectorRuntime): ExecutionAdapter[] {
  return (['mail.draft', 'calendar.create'] as const).map((operation) => {
    const id = `api:${operation}`;
    const key = operation === 'mail.draft' ? 'gmail-actions' : 'google-calendar-actions';
    return {
      id,
      async probe(intent, signal) {
        if (intent.operation !== operation || !(await connectors.connected(key))) return null;
        if (operation === 'mail.draft') await connectors.gmailActions().probeDrafts(signal);
        else await connectors.googleCalendarActions().probeWriteAccount(signal);
        const fingerprint = await connectors.executionFingerprint(key);
        return fingerprint
          ? {
              id,
              route: 'api',
              label:
                operation === 'mail.draft'
                  ? '接続中のGmail（下書きのみ）'
                  : '接続中のGoogle Calendar（自分の予定）',
              fingerprint,
              operations: [operation],
              verification: 'readback',
            }
          : null;
      },
      async execute(intent, proof, _requestId, signal) {
        signal?.throwIfAborted();
        const p = intent.parameters;
        let id: string, readback: unknown;
        if (operation === 'mail.draft') {
          const provider = connectors.gmailActions();
          const written = await provider.draft(
            { to: p['to'] as string[], subject: String(p['subject']), body: String(p['body']) },
            signal,
          );
          id = written.draftId;
          signal?.throwIfAborted();
          readback = await provider.getDraft(id, signal);
        } else {
          const provider = connectors.googleCalendarActions();
          const written = await provider.create(
            {
              title: String(p['title']),
              start: { dateTime: String(p['start']) },
              end: { dateTime: String(p['end']) },
            },
            { ...proof, operationId: 'calendar.create' },
            signal,
          );
          id = written.id;
          signal?.throwIfAborted();
          const read = await provider.getCreatedEvent(id, signal);
          readback = {
            id: read.id,
            title: read.title,
            start: read.start.dateTime,
            end: read.end.dateTime,
            attendees: read.attendees.map((a) => a.email),
            cancelled: read.status === 'cancelled',
          };
        }
        const verified = matchesReadback(intent, id, readback);
        return { verified, ...(verified ? { evidence: executionDigest(readback) } : {}) };
      },
    };
  });
}

/** AX and Vision do not satisfy a saved-data/readback contract and cannot replace those routes. */
export function nativeExecutionAdapters(options: {
  axHelper?: string;
  vision: ComputerVisionRuntime;
  visionHelper?: string;
  selectVisionModel: () => Promise<string | null>;
  allowExternalPixels: boolean;
}): ExecutionAdapter[] {
  return [
    {
      id: 'native:field',
      async probe(intent, signal) {
        if (
          intent.operation !== 'text.insert' ||
          process.platform !== 'darwin' ||
          !options.axHelper
        )
          return null;
        const result = await runExecutionHelper(options.axHelper, { command: 'probe' }, signal);
        if (result['available'] !== true) return null;
        return {
          id: 'native:field',
          route: 'accessibility',
          label: 'Macの入力欄（端末上で対象を確認）',
          fingerprint: executionDigest(await readFile(options.axHelper)),
          operations: ['text.insert'],
          verification: 'field',
        };
      },
      async execute(intent, proof, _requestId, signal) {
        const result = await runExecutionHelper(
          options.axHelper!,
          {
            command: 'insert',
            text: intent.parameters['text'],
            expiresAt: Date.parse(proof.expiresAt),
          },
          signal,
        );
        const verified =
          result['verified'] === true &&
          typeof result['evidence'] === 'string' &&
          /^[a-f0-9]{64}$/.test(result['evidence']);
        return { verified, ...(verified ? { evidence: result['evidence'] as string } : {}) };
      },
    },
    {
      id: 'native:vision',
      async probe(intent) {
        if (
          intent.operation !== 'computer.run' ||
          !options.vision.config.enabled ||
          process.platform !== 'darwin' ||
          !options.visionHelper
        )
          return null;
        await access(options.visionHelper, constants.X_OK);
        const model = await options.selectVisionModel();
        if (
          !model ||
          (!options.allowExternalPixels && model !== 'local') ||
          model === 'claude_code'
        )
          return null;
        return {
          id: 'native:vision',
          route: 'vision',
          label: `Mac画面（${model === 'local' ? '端末内モデル' : model + 'へ画像送信'}・毎操作確認）`,
          fingerprint: executionDigest([await readFile(options.visionHelper), model]),
          operations: ['computer.run'],
          verification: 'visual',
        };
      },
      async execute(intent, proof, requestId, signal) {
        const result = await options.vision.run(
          {
            id: requestId,
            toolId: 'computer.run',
            args: intent.parameters,
            approval: { ...proof, operationId: 'computer.run' },
          },
          signal,
        );
        if (!result.ok) throw new Error('Vision execution did not finish');
        const read = object(result.result);
        const verified =
          read?.['completed'] === true &&
          read['verification'] === 'visual' &&
          Array.isArray(read['audit']);
        return { verified, ...(verified ? { evidence: executionDigest(read) } : {}) };
      },
    },
  ];
}

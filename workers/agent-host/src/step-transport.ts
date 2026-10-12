/**
 * 受け渡しの HTTP 表面。正本 §4.4。
 *
 * **薄くしておく。**判断は `HostStepLoop` にあり、ここは HTTP に写すだけ。
 */
import type { HostStep } from './connector-steps.js';
import type { StepTransport } from './step-loop.js';

export interface StepTransportConfig {
  readonly baseUrl: string;
  readonly token: string;
  readonly fetch?: typeof globalThis.fetch;
}

interface RawStep {
  id: string;
  taskId?: string;
  toolId: string;
  args?: Record<string, unknown>;
  approval?: HostStep['approval'];
}

export function httpStepTransport(config: StepTransportConfig): StepTransport {
  const doFetch = config.fetch ?? globalThis.fetch;

  const call = async (path: string, body: unknown): Promise<unknown> => {
    const response = await doFetch(`${config.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text();
      // 返せなかったことを、返せたことにしない
      throw new Error(`POST ${path} failed with ${response.status}: ${text.slice(0, 200)}`);
    }
    return response.status === 204 ? null : ((await response.json()) as unknown);
  };

  return {
    async claim(hostId) {
      const body = (await call('/v1/host-steps/claim', { host_id: hostId })) as RawStep | null;
      if (!body) return null;
      return {
        id: body.id,
        ...(body.taskId ? { taskId: body.taskId } : {}),
        toolId: body.toolId,
        args: body.args ?? {},
        approval: body.approval ?? null,
      };
    },
    async shouldCancel(step) {
      if (!step.taskId) return true;
      const response = await doFetch(
        `${config.baseUrl}/v1/tasks/${encodeURIComponent(step.taskId)}`,
        {
          headers: { authorization: `Bearer ${config.token}` },
          redirect: 'error',
          signal: AbortSignal.timeout(5000),
        },
      );
      if (!response.ok) return true;
      const body = (await response.json()) as { status?: string };
      return !['PENDING', 'RUNNING', 'WAITING_APPROVAL'].includes(body.status ?? '');
    },
    async complete(requestId, hostId, result) {
      await call(`/v1/host-steps/${requestId}/complete`, { host_id: hostId, result });
    },
    async fail(requestId, hostId, error) {
      await call(`/v1/host-steps/${requestId}/fail`, { host_id: hostId, error });
    },
  };
}

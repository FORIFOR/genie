/**
 * 電話（Oathra）の接続。本人の接続を預かる・見る・手放す。
 *
 *   PUT    /v1/phone/connection   Oathra の `connect-agent.mjs --output` が書いた JSON をそのまま渡す
 *   GET    /v1/phone/connection   接続の状態（トークンは返さない）
 *   DELETE /v1/phone/connection   接続を切る
 *
 * **預かる前に Oathra に確かめる。**使えない接続を「繋がった」と見せない。
 * トークンは封じて置き、応答にもログにも出さない。
 */
import { GenieError } from '@genie/contracts';
import {
  OathraError,
  checkedOrigin,
  type OathraClient,
  type OathraConnection,
} from '@genie/service-phone';
import type { PhoneConnectionStore } from '@genie/service-phone';
import { z } from 'zod';
import type { App } from '../fastify.js';
import { requirePrincipal } from '../auth/middleware.js';

export interface PhoneRouteDeps {
  readonly store: PhoneConnectionStore;
  readonly clientOf: (connection: OathraConnection) => OathraClient;
}

/** connect-agent.mjs の出力。ほかの項目（grant の写しなど）は読まない。 */
const ConnectionBody = z.object({
  baseUrl: z.string().min(1).max(512),
  token: z.string().min(16).max(2048),
  grantId: z.string().min(1).max(128),
});

/** Oathra が断った理由を、直し方の分かる形で返す。 */
async function grantStatus(client: OathraClient) {
  try {
    return await client.connection();
  } catch (error) {
    if (error instanceof OathraError) {
      throw new GenieError(
        error.status === 401 || error.status === 403 || error.status === 404
          ? 'common.validation_failed'
          : 'common.unavailable',
        'Oathra がこの接続を受け付けませんでした。Oathra で委任を確かめてください。',
        { details: { oathra_error: error.code } },
      );
    }
    throw new GenieError('common.unavailable', 'Oathra に繋がりませんでした。', {
      retryable: true,
    });
  }
}

export function registerPhoneRoutes(app: App, deps: PhoneRouteDeps): void {
  app.put('/v1/phone/connection', async (request) => {
    const principal = requirePrincipal();
    if (!deps.store.canStore) {
      throw new GenieError(
        'common.unavailable',
        'このサーバには秘密を封じる鍵（GENIE_SECRET_KEY）が無いので、電話の接続を預かれません。',
      );
    }
    const parsed = ConnectionBody.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new GenieError(
        'common.validation_failed',
        'baseUrl / token / grantId を渡してください。',
      );
    }
    let baseUrl: string;
    try {
      baseUrl = checkedOrigin(parsed.data.baseUrl);
    } catch {
      throw new GenieError(
        'common.validation_failed',
        'Oathra の接続先は HTTPS の origin にしてください（HTTP は loopback だけ）。',
      );
    }
    const connection = { baseUrl, token: parsed.data.token, grantId: parsed.data.grantId };
    const status = await grantStatus(deps.clientOf(connection));
    const saved = await deps.store.save(principal, connection);
    return { ...saved, ...permissionsOf(status) };
  });

  app.get('/v1/phone/connection', async () => {
    const principal = requirePrincipal();
    const saved = await deps.store.status(principal);
    if (!saved) return { connected: false };
    const connection = await deps.store.connection(principal).catch(() => null);
    // 状態だけ確かめる。届かなくても接続は残す（一時的な不通で切らない）
    const status = connection
      ? await deps
          .clientOf(connection)
          .connection()
          .catch(() => null)
      : null;
    return {
      connected: true,
      ...saved,
      reachable: status !== null,
      ...(status ? permissionsOf(status) : {}),
    };
  });

  app.delete('/v1/phone/connection', async (_request, reply) => {
    const principal = requirePrincipal();
    await deps.store.revoke(principal);
    return reply.status(204).send();
  });
}

function permissionsOf(status: Awaited<ReturnType<OathraClient['connection']>>) {
  return {
    ready: status.ready,
    remaining_calls: status.remainingCalls,
    next_action: status.nextAction,
    allow_sales: status.grant.allowSales === true,
    read_inbound: status.grant.readInbound === true,
    expires_at: new Date(status.grant.expiresAt).toISOString(),
  };
}

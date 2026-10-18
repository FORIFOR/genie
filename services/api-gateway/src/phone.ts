/**
 * Oathra 経由の電話を gateway に繋ぐ。正本外の拡張（Oathra 連携）。
 *
 * 接続は**利用者ごと**（`phone_connections`。トークンは `GENIE_SECRET_KEY` で封じて置く）。
 * 「電話して」と頼んだ本人の接続だけを使い、無ければ「繋がっていない」と答える。
 * 環境変数の接続（`GENIE_OATHRA_CONNECTION_FILE` + `GENIE_OATHRA_OWNER`）は
 * 手元で試すための 1 人分の逃がし口として残す。
 *
 * 着信の取り込みは `GENIE_OATHRA_INBOUND=on` のときだけ回す。Oathra 側の委任に
 * `readInbound` が無い人は、その人だけ断られる。
 */
import {
  InboundPhoneSyncs,
  PhoneConnectionStore,
  oathraClient,
  phoneConnections,
  phoneSetupFromEnv,
  phoneTaskFor,
  secretBoxFromEnv,
  type InboundTaskRequest,
  type OathraClient,
  type OathraConnection,
  type PhoneConnections,
  type PhoneTaskDecision,
} from '@genie/service-phone';
import { isDocumentRequest, routeLane } from '@genie/service-conversation';
import { agentKindFor, type TaskService } from '@genie/service-task';
import type { DbHandle } from '@genie/db';
import type { Logger } from '@genie/telemetry';

export interface GatewayPhone {
  readonly phone: {
    taskFor(
      principal: { tenantId: string; userId: string },
      text: string,
    ): Promise<PhoneTaskDecision | null>;
  };
  /** 利用者ごとの接続を預かる先。route（PUT / GET / DELETE /v1/phone/connection）が使う。 */
  readonly store: PhoneConnectionStore;
  readonly clientOf: (connection: OathraConnection) => OathraClient;
  readonly inbound: InboundPhoneSyncs | null;
}

const GENERAL = agentKindFor('com.astra.general', 'assistant');

/**
 * 本人が電話で頼んだこと。チャットと同じ振り分けで、同じ種類の仕事にする。
 *
 * 電話の頼みで進められないもの（相手が決まらない等）は、**黙って捨てない。**
 * `phone.unresolved` として理由を仕事の一覧に残す。
 */
export async function ownerRequestFor(
  client: OathraClient | null,
  text: string,
): Promise<InboundTaskRequest | null> {
  const lane = routeLane({
    text,
    modality: 'voice',
    meetingActive: false,
    hasSelection: false,
    namedAgent: null,
  }).lane;
  if (lane === 'action') {
    const decision = await phoneTaskFor(text, client);
    if (decision?.kind === 'task') return decision.request;
    if (decision?.kind === 'notice') {
      return {
        kind: 'phone.unresolved',
        title: '電話の依頼を進められませんでした',
        input: { notice: decision.notice, words: text },
      };
    }
  }
  if (lane === 'research') {
    return { kind: 'research', title: '電話で頼まれた調べもの', input: { question: text } };
  }
  return {
    kind: GENERAL,
    title: '電話で頼まれたこと',
    input: {
      question: text,
      message: text,
      ...(isDocumentRequest(text) ? { instruction: text } : {}),
    },
  };
}

export function phoneFromEnv(
  env: NodeJS.ProcessEnv,
  deps: {
    readonly db: DbHandle;
    readonly tasks: TaskService;
    readonly logger: Logger;
    readonly fetchImpl?: typeof fetch;
  },
): GatewayPhone {
  const store = new PhoneConnectionStore({ db: deps.db, secrets: secretBoxFromEnv(env) });
  const connections: PhoneConnections = phoneConnections({
    store,
    fallback: phoneSetupFromEnv(env),
  });
  const clientOf = (connection: OathraConnection) =>
    oathraClient(connection, deps.fetchImpl ?? fetch);

  const phone = {
    taskFor: async (principal: { tenantId: string; userId: string }, text: string) => {
      const saved = await connections.connectionFor(principal);
      return phoneTaskFor(text, saved ? clientOf(saved) : null);
    },
  };

  if (env['GENIE_OATHRA_INBOUND'] !== 'on') return { phone, store, clientOf, inbound: null };

  const inbound = new InboundPhoneSyncs({
    connections,
    clientOf,
    tasks: {
      create: async ({ tenantId, userId, request, idempotencyKey }) => {
        const { task, deduplicated } = await deps.tasks.create({
          tenantId,
          userId,
          request: { ...request, input: request.input as never } as never,
          idempotencyKey,
        });
        return { task: { id: task.id }, deduplicated };
      },
    },
    ownerRequest: (_owner, client, text) => ownerRequestFor(client, text),
    messageRequest: ({ instruction, context }) => ({
      kind: GENERAL,
      title: '着信の用件',
      input: { instruction, message: instruction, context },
    }),
    log: (event, detail) => deps.logger.info(detail, event),
  });
  return { phone, store, clientOf, inbound };
}

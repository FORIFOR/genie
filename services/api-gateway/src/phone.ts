/**
 * Oathra 経由の電話を gateway に繋ぐ。正本外の拡張（Oathra 連携）。
 *
 * 接続は**1 人の利用者のもの**（`GENIE_OATHRA_OWNER`）。ほかの利用者が「電話して」と
 * 頼んでも、この人の連絡先は読まず「繋がっていない」と答える。
 *
 * 着信の取り込みは `GENIE_OATHRA_INBOUND=on` のときだけ回す。Oathra 側の委任に
 * `readInbound` が無いと断られるので、明示して有効にする。
 */
import {
  InboundPhoneSync,
  oathraClient,
  phoneSetupFromEnv,
  phoneTaskFor,
  type InboundTaskRequest,
  type PhoneTaskDecision,
} from '@genie/service-phone';
import { isDocumentRequest, routeLane } from '@genie/service-conversation';
import { agentKindFor, type TaskService } from '@genie/service-task';
import type { Logger } from '@genie/telemetry';

export interface GatewayPhone {
  readonly phone: {
    taskFor(
      principal: { tenantId: string; userId: string },
      text: string,
    ): Promise<PhoneTaskDecision | null>;
  };
  readonly inbound: InboundPhoneSync | null;
}

const GENERAL = agentKindFor('com.astra.general', 'assistant');

export function phoneFromEnv(
  env: NodeJS.ProcessEnv,
  deps: { readonly tasks: TaskService; readonly logger: Logger },
): GatewayPhone {
  const setup = phoneSetupFromEnv(env);
  const client = setup ? oathraClient(setup.connection) : null;
  const isOwner = (p: { tenantId: string; userId: string }) =>
    !!setup && p.tenantId === setup.owner.tenantId && p.userId === setup.owner.userId;

  const phone = {
    taskFor: (principal: { tenantId: string; userId: string }, text: string) =>
      phoneTaskFor(text, isOwner(principal) ? client : null),
  };

  if (!setup || !client || env['GENIE_OATHRA_INBOUND'] !== 'on') return { phone, inbound: null };

  /** 本人が電話で頼んだこと。チャットと同じ振り分けで、同じ種類の仕事にする。 */
  const ownerRequest = async (text: string): Promise<InboundTaskRequest | null> => {
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
        // 進められない電話の頼み。Oathra 側の着信通知で本人は気づける。黙って別の仕事にしない
        deps.logger.warn(
          { notice: decision.notice },
          'phone request from a call could not be started',
        );
        return null;
      }
    }
    if (lane === 'research')
      return { kind: 'research', title: '電話で頼まれた調べもの', input: { question: text } };
    return {
      kind: GENERAL,
      title: '電話で頼まれたこと',
      input: {
        question: text,
        message: text,
        ...(isDocumentRequest(text) ? { instruction: text } : {}),
      },
    };
  };

  const inbound = new InboundPhoneSync({
    client,
    owner: setup.owner,
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
    ownerRequest,
    messageRequest: ({ instruction, context }) => ({
      kind: GENERAL,
      title: '着信の用件',
      input: { instruction, message: instruction, context },
    }),
    log: (event, detail) => deps.logger.info(detail, event),
  });
  return { phone, inbound };
}

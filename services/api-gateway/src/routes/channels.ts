/**
 * チャット（Slack / LINE）の HTTP 表面。
 *
 * 受け口（Webhook）は**認証ではなく署名で守る。**署名は受け取ったままのバイト列で確かめるので、
 * この scope だけ本文を Buffer のまま受ける。確かめたらすぐ 200 を返し、処理は後ろで行う
 * （Slack は 3 秒で返さないと送り直す。重複は受信箱が捨てる）。
 *
 * 本人の操作（連携コードの発行・連携の一覧・解除・送る範囲）は通常どおり認証必須。
 */
import { GenieError } from '@genie/contracts';
import {
  normalizeLineWebhook,
  normalizeSlackAction,
  normalizeSlackEvent,
  verifyLineSignature,
  verifySlackSignature,
  type ChannelService,
  type ChannelStore,
} from '@genie/service-channels';
import { z } from 'zod';
import type { App } from '../fastify.js';
import { requirePrincipal } from '../auth/middleware.js';
import type { RouteRateLimit } from '../plugins/rate-limit.js';

export interface ChannelRouteDeps {
  readonly service: ChannelService;
  readonly store: ChannelStore;
  /** 設定されている提供者だけ受け口が開く。 */
  readonly slackSigningSecret: string | null;
  readonly lineChannelSecret: string | null;
}

/** 受け口は IP ごと。提供者の再送の束でも詰まらない幅にする。 */
const WEBHOOK_RATE_LIMIT: RouteRateLimit = {
  limit: 600,
  windowMs: 60_000,
  by: 'ip',
  bucket: 'channel-webhook',
};

const Provider = z.enum(['slack', 'line']);
const PostingPolicy = z.enum(['summary_and_link', 'full_text']);

export function registerChannelRoutes(app: App, deps: ChannelRouteDeps): void {
  const later = (label: string, work: () => Promise<unknown>) => {
    setImmediate(() => {
      work().catch((error: unknown) => {
        app.log.error({ err: error, channel_step: label }, 'channel processing failed');
      });
    });
  };

  void app.register(async (scope) => {
    // 署名のために生の本文を残す（この scope の中だけ）
    scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) =>
      done(null, body),
    );
    scope.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'buffer' },
      (_req, body, done) => done(null, body),
    );

    scope.post(
      '/v1/channels/slack/events',
      { config: { auth: false, rateLimit: WEBHOOK_RATE_LIMIT } },
      async (request, reply) => {
        const raw = rawBody(request.body);
        if (!deps.slackSigningSecret)
          throw new GenieError('common.unavailable', 'slack is not configured');
        if (
          !verifySlackSignature({
            signingSecret: deps.slackSigningSecret,
            timestamp: header(request.headers['x-slack-request-timestamp']),
            signature: header(request.headers['x-slack-signature']),
            rawBody: raw,
          })
        ) {
          throw new GenieError('auth.forbidden', 'bad slack signature');
        }
        const inbound = normalizeSlackEvent(parseJson(raw));
        if (inbound.kind === 'url_verification')
          return reply.send({ challenge: inbound.challenge });
        if (inbound.kind === 'message')
          later('slack.receive', () => deps.service.receive(inbound.message));
        else request.log.info({ reason: inbound.reason }, 'slack event ignored');
        return reply.status(200).send({ ok: true });
      },
    );

    scope.post(
      '/v1/channels/slack/interactions',
      { config: { auth: false, rateLimit: WEBHOOK_RATE_LIMIT } },
      async (request, reply) => {
        const raw = rawBody(request.body);
        if (!deps.slackSigningSecret)
          throw new GenieError('common.unavailable', 'slack is not configured');
        if (
          !verifySlackSignature({
            signingSecret: deps.slackSigningSecret,
            timestamp: header(request.headers['x-slack-request-timestamp']),
            signature: header(request.headers['x-slack-signature']),
            rawBody: raw,
          })
        ) {
          throw new GenieError('auth.forbidden', 'bad slack signature');
        }
        const payload = new URLSearchParams(raw.toString('utf8')).get('payload');
        const inbound = normalizeSlackAction(payload ? parseJson(Buffer.from(payload)) : null);
        if (inbound.kind === 'action') later('slack.act', () => deps.service.act(inbound.action));
        else request.log.info({ reason: inbound.reason }, 'slack action ignored');
        return reply.status(200).send();
      },
    );

    scope.post(
      '/v1/channels/line/webhook',
      { config: { auth: false, rateLimit: WEBHOOK_RATE_LIMIT } },
      async (request, reply) => {
        const raw = rawBody(request.body);
        if (!deps.lineChannelSecret)
          throw new GenieError('common.unavailable', 'line is not configured');
        if (
          !verifyLineSignature({
            channelSecret: deps.lineChannelSecret,
            signature: header(request.headers['x-line-signature']),
            rawBody: raw,
          })
        ) {
          throw new GenieError('auth.forbidden', 'bad line signature');
        }
        const inbound = normalizeLineWebhook(parseJson(raw));
        for (const message of inbound.messages)
          later('line.receive', () => deps.service.receive(message));
        for (const action of inbound.actions) later('line.act', () => deps.service.act(action));
        if (inbound.ignored.length > 0) {
          request.log.info(
            { reasons: inbound.ignored.map((i) => i.reason) },
            'line events ignored',
          );
        }
        return reply.status(200).send({ ok: true });
      },
    );
  });

  /** 連携コードを出す。チャットで「連携 <コード>」と送ると結ばれる（10 分・1 回）。 */
  app.post('/v1/channels/link-codes', async (request, reply) => {
    const principal = requirePrincipal();
    const body = z.object({ provider: Provider }).parse(request.body ?? {});
    const { code, expiresAt } = await deps.store.issueLinkCode(
      principal.tenantId,
      principal.userId,
      body.provider,
    );
    return reply.status(201).send({
      provider: body.provider,
      code,
      message: `連携 ${code}`,
      expires_at: expiresAt.toISOString(),
    });
  });

  app.get('/v1/channels/links', async () => {
    const principal = requirePrincipal();
    const links = await deps.store.listLinks(principal.tenantId, principal.userId);
    // 外の利用者 ID は出さない。どこの・いつのものかだけ
    return {
      items: links.map((l) => ({
        id: l.id,
        provider: l.provider,
        posting_policy: l.postingPolicy,
        created_at: l.createdAt,
        last_seen_at: l.lastSeenAt,
      })),
    };
  });

  app.patch<{ Params: { linkId: string } }>(
    '/v1/channels/links/:linkId',
    async (request, reply) => {
      const principal = requirePrincipal();
      const body = z.object({ posting_policy: PostingPolicy }).parse(request.body ?? {});
      const ok = await deps.store.setPostingPolicy(
        principal.tenantId,
        principal.userId,
        request.params.linkId,
        body.posting_policy,
      );
      if (!ok) throw new GenieError('common.not_found', 'no such link');
      return reply.status(204).send();
    },
  );

  app.delete<{ Params: { linkId: string } }>(
    '/v1/channels/links/:linkId',
    async (request, reply) => {
      const principal = requirePrincipal();
      const ok = await deps.service.unlink(
        principal.tenantId,
        principal.userId,
        request.params.linkId,
      );
      if (!ok) throw new GenieError('common.not_found', 'no such link');
      return reply.status(204).send();
    },
  );
}

function rawBody(body: unknown): Buffer {
  if (Buffer.isBuffer(body)) return body;
  throw new GenieError('common.validation_failed', 'a raw body is required');
}

function header(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function parseJson(raw: Buffer): unknown {
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw new GenieError('common.validation_failed', 'invalid json');
  }
}

/**
 * 仕事のホームのページ（src/work-home.ts・work-page.ts）。
 *
 *   GET /v1/channels/work/:token                 ページ（読むだけ）
 *   GET /v1/channels/work/:token/state           ホームの中身（JSON。ページが 15 秒ごとに読む）
 *   GET /v1/channels/work/:token/item/s/:id      Claude Code のセッションの台帳（頼みの頭は落とす）
 *   GET /v1/channels/work/:token/item/t/:id      Genie の仕事の台帳
 *   GET /v1/channels/work/:token/rules           Claude Code の承認ルール（継続許可）と、最近の承認の記録
 *   POST /v1/channels/work/:token/rules/:id/revoke  承認ルールを取り消す（このページで変えられるのはこれだけ）
 *   LINE の中では、計画ボードの LIFF の入口（/v1/channels/board?liff.state=/w/<リンク>）から移ってくる
 *
 * サインインの代わりにリンクの秘密（24 バイトの乱数、30 日。残すのはハッシュ）で守る。台帳は、
 * リンクの本人のものしか返さない（ほかの人の id を入れても 404）。
 */
import type { App } from '../fastify.js';
import type { AgentApprovals } from '../agent-approvals.js';
import type { WorkDesk } from '../work-desk.js';
import { composeHome, ledgerForPage, type WorkLinkStore } from '../work-home.js';
import { workPage } from '../work-page.js';

const TOKEN = /^[A-Za-z0-9_-]{32}$/;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const pageHeaders = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex',
};

export function registerWorkHomeRoutes(
  app: App,
  deps: {
    readonly desk: WorkDesk;
    readonly links: WorkLinkStore;
    /** Claude Code の承認（無ければ承認ルールの道は生やさない）。 */
    readonly approvals?: AgentApprovals;
  },
): void {
  const config = {
    auth: false,
    rateLimit: { limit: 120, windowMs: 60_000, by: 'ip', bucket: 'channel-work' },
  } as const;
  const owner = (token: string) =>
    TOKEN.test(token) ? deps.links.byToken(token) : Promise.resolve(null);

  app.get<{ Params: { token: string } }>(
    '/v1/channels/work/:token',
    { config },
    async (request, reply) => {
      const who = await owner(request.params.token);
      return reply
        .status(who ? 200 : 410)
        .headers({ ...pageHeaders, 'content-type': 'text/html; charset=utf-8' })
        .send(workPage());
    },
  );

  app.get<{ Params: { token: string } }>(
    '/v1/channels/work/:token/state',
    { config },
    async (request, reply) => {
      const who = await owner(request.params.token);
      if (!who) return reply.status(410).headers(pageHeaders).send({ error: 'gone' });
      return reply
        .headers(pageHeaders)
        .send(composeHome(await deps.desk.gather(who.tenantId, who.userId)));
    },
  );

  app.get<{ Params: { token: string; kind: string; id: string } }>(
    '/v1/channels/work/:token/item/:kind/:id',
    { config },
    async (request, reply) => {
      const who = await owner(request.params.token);
      if (!who) return reply.status(410).headers(pageHeaders).send({ error: 'gone' });
      const { kind, id } = request.params;
      const ledger = !ID.test(id)
        ? null
        : kind === 's'
          ? await deps.desk.ledger.forSession(who.tenantId, who.userId, id)
          : kind === 't'
            ? await deps.desk.ledger.forTask(who.tenantId, who.userId, id)
            : null;
      if (!ledger) return reply.status(404).headers(pageHeaders).send({ error: 'not_found' });
      return reply.headers(pageHeaders).send(ledgerForPage(ledger));
    },
  );

  const approvals = deps.approvals;
  if (!approvals) return;

  app.get<{ Params: { token: string } }>(
    '/v1/channels/work/:token/rules',
    { config },
    async (request, reply) => {
      const who = await owner(request.params.token);
      if (!who) return reply.status(410).headers(pageHeaders).send({ error: 'gone' });
      const [rules, history] = await Promise.all([
        approvals.rules(who.tenantId, who.userId),
        approvals.history(who.tenantId, who.userId, 30),
      ]);
      return reply.headers(pageHeaders).send({
        rules: rules.map((r) => ({
          id: r.id,
          scope: r.scope,
          project: r.project,
          tool: r.tool,
          label: r.label,
          match: r.match,
          useCount: r.useCount,
          lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
          createdAt: r.createdAt.toISOString(),
        })),
        // 中身（コマンド・ファイル）は残していないので、種類・道具・どう答えたか・結果だけ
        history: history.map((h) => ({
          at: new Date(h.created_at).toISOString(),
          tool: h.tool_name,
          operation: OPERATION_TEXT[h.operation ?? ''] ?? h.operation ?? '',
          risk: h.risk,
          answer: answerText(h.state, h.with_instruction),
          auto: h.state === 'auto_allowed',
          result:
            h.result === 'executed' ? '実行を確認' : h.result === 'failed' ? '実行して失敗' : null,
        })),
      });
    },
  );

  app.post<{ Params: { token: string; id: string } }>(
    '/v1/channels/work/:token/rules/:id/revoke',
    { config },
    async (request, reply) => {
      const who = await owner(request.params.token);
      if (!who) return reply.status(410).headers(pageHeaders).send({ error: 'gone' });
      if (!ID.test(request.params.id))
        return reply.status(404).headers(pageHeaders).send({ error: 'not_found' });
      const n = await approvals.revoke(who.tenantId, who.userId, request.params.id);
      return reply
        .status(n > 0 ? 204 : 404)
        .headers(pageHeaders)
        .send();
    },
  );
}

const OPERATION_TEXT: Record<string, string> = {
  read: '読むだけのコマンド',
  run_checks: 'テスト・ビルド・確認',
  create_file: 'ファイルを作成',
  edit_file: 'ファイルを書き換え',
  write_file: 'ファイルを作成・上書き',
  install_packages: 'パッケージを入れる',
  web_read: 'ウェブを読む',
  tool: '道具を使う',
  command: 'コマンド',
  git_push: 'リモートへ送る',
  publish: '公開',
  deploy: 'デプロイ',
  destructive: '消す・戻せない操作',
  privileged: '管理者の権限',
  permissions: '権限の変更',
  send_out: '外へ送る',
  payment: '決済',
  secrets: '秘密に触る',
  agent_settings: 'Claude Code の設定',
  outside_project: 'プロジェクトの外',
};

function answerText(state: string, withInstruction: boolean): string {
  switch (state) {
    case 'auto_allowed':
      return '自動で許可（承認ルール）';
    case 'allowed':
      return 'LINE で承認';
    case 'denied':
      return withInstruction ? 'LINE で止めて指示' : 'LINE で拒否';
    case 'answered_on_mac':
      return 'Mac で答えた';
    case 'expired':
      return '期限切れ（Mac で答える）';
    case 'ended':
      return 'LINE に出せず（Mac で答える）';
    default:
      return '答えを待っている';
  }
}

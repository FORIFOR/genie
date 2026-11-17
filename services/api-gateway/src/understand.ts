/**
 * 写真・外国語の文を読む（service-understand）を gateway に繋ぐ。
 *
 *   GENIE_UNDERSTAND_ANTHROPIC_API_KEY  あれば写真と外国語の文をモデルで読む（無ければ ANTHROPIC_API_KEY）。
 *                             どちらも無ければ写真には「まだ読めません」と答え、外国語の文はいつもどおり Genie に渡す。
 *                             専用の名前があるのは、ここだけを有料のモデルにするため（ANTHROPIC_API_KEY は
 *                             調べもの・議事録も使い始める）
 *   GENIE_UNDERSTAND_MODEL    読むモデル（既定 claude-opus-5-5）
 *   GENIE_TIMEZONE            今日の日付・月の区切り（予約と同じ。既定 Asia/Tokyo）
 *
 * モデルに渡すのは、送られたその 1 通（写真と添えた文）と今日の日付だけ。写真は残さない。
 */
import type { DbHandle } from '@genie/db';
import {
  AnthropicUnderstander,
  ExpenseStore,
  HouseholdStore,
  PendingStore,
  PollStore,
  SHARED_HELP,
  SharedSpaceService,
  ShoppingStore,
  TodoStore,
  UnderstandService,
} from '@genie/service-understand';
import type { Logger } from '@genie/telemetry';
import { restaurantTurn } from './restaurant.js';
import {
  GroupContextStore,
  groupAssistant,
  groupSettings,
  observeGroup,
  type GroupAssistantDeps,
} from './group-context.js';
import { syncSchedule } from './board.js';

export function understandServiceFromEnv(
  env: NodeJS.ProcessEnv,
  deps: { readonly db: DbHandle; readonly logger: Logger; readonly timeZone: string },
): UnderstandService {
  const apiKey =
    env['GENIE_UNDERSTAND_ANTHROPIC_API_KEY']?.trim() || env['ANTHROPIC_API_KEY']?.trim() || null;
  const model = env['GENIE_UNDERSTAND_MODEL']?.trim() || undefined;
  return new UnderstandService({
    understander: apiKey
      ? new AnthropicUnderstander({ apiKey, ...(model ? { model } : {}) })
      : null,
    expenses: new ExpenseStore(deps.db),
    timeZone: deps.timeZone,
    log: (event, detail) => deps.logger.info(detail, event),
    // 個人の買い物リスト・TODO（1:1 のトークと Task Dock）
    lists: sharedSpaceService(deps.db, deps.timeZone),
    // 確かめ中（「家計簿に付けますか？」）は DB に。再起動しても「はい」「修正する」が効く
    pending: new PendingStore(deps.db),
  });
}

export function sharedSpaceService(db: DbHandle, timeZone: string): SharedSpaceService {
  return new SharedSpaceService({
    shopping: new ShoppingStore(db),
    todos: new TodoStore(db),
    polls: new PollStore(db),
    households: new HouseholdStore(db),
    timeZone,
  });
}

/**
 * 家族・夫婦のグループ（共有スペース）を、チャネルの `shared` として束ねる。
 *
 * グループの発言は handleTurn に渡さない（持ち主のメール・予定・ファイルに触れない）。
 * 読むのは共有スペースの言い方（買い物・TODO・日程）→ 共有の家計簿 → 外国語の文の訳、の順。
 * 写真は、自動で読むと決めたグループのレシートだけを付ける。
 */
export function householdChannels(deps: {
  readonly db: DbHandle;
  readonly understand: UnderstandService;
  readonly timeZone: string;
  /** グループの目的（お店探しの途中など）を持つ会話を作る。無ければ場所探しはしない。 */
  readonly conversations?: Pick<import('@genie/service-conversation').ConversationService, 'start'>;
  /** グループでのお店・場所探し（restaurant.ts）。 */
  readonly restaurants?: import('./restaurant.js').RestaurantDeps;
  /** グループの計画（Action Board）。場所探し・日程調整をボードに映す。 */
  readonly boards?: GroupAssistantDeps['boards'];
  readonly now?: () => Date;
}) {
  const households = new HouseholdStore(deps.db);
  const shared = sharedSpaceService(deps.db, deps.timeZone);
  const context = new GroupContextStore(deps.db);
  const now = () => deps.now?.() ?? new Date();
  const assistant: GroupAssistantDeps = {
    store: context,
    ...(deps.restaurants && deps.conversations ? { restaurants: deps.restaurants } : {}),
    reply: (input) => deps.understand.groupReply(input),
    conversationFor: async (space) => {
      const current = await context.settings(space.tenantId, space.householdId);
      if (current.conversationId) return current.conversationId;
      const id = (
        await deps.conversations!.start(space.tenantId, space.ownerUserId, {
          title: 'LINE のグループ',
        })
      ).id;
      await context.set(space.tenantId, space.householdId, { conversationId: id });
      return id;
    },
    timeZone: deps.timeZone,
    now,
    ...(deps.boards ? { boards: deps.boards } : {}),
  };
  return {
    // 招かれたグループは、呼ばれた発言だけを使う（会話を覚えるのは、グループで「会話の文脈を使う」と決めてから）
    enable: async (owner: { tenantId: string; userId: string }, name: string) =>
      (await households.create(owner.tenantId, owner.userId, name)).id,
    observe: (
      space: { tenantId: string; householdId: string },
      message: Parameters<typeof observeGroup>[2],
    ) => observeGroup(context, space, message),
    forget: (space: { tenantId: string; householdId: string }, messageId: string) =>
      context.forget(space.tenantId, space.householdId, messageId, now()),
    message: async (
      ctx: {
        tenantId: string;
        userId: string;
        householdId: string;
        speaker: { id: string; name: string | null };
      },
      input: {
        readonly text: string;
        readonly images: readonly { readonly mediaType: string; readonly data: Uint8Array }[];
        readonly mentioned: boolean;
      },
    ): Promise<string | { text: string; card?: string; choices?: readonly string[] } | null> => {
      const principal = {
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        householdId: ctx.householdId,
      };
      // 確かめ中の案・直前に付けたものは、グループごとに持つ。確かめ中のことは会話（UUID）に結びつけて
      // 残すので、グループの会話を使う（2026-10-28: 「household:<ID>」を渡し、呼ぶたびに失敗していた）
      const groupConversation = async (): Promise<string | null> =>
        deps.conversations
          ? assistant.conversationFor({
              tenantId: ctx.tenantId,
              householdId: ctx.householdId,
              ownerUserId: ctx.userId,
            })
          : null;
      if (input.images.length > 0) {
        const household = await households.get(ctx.tenantId, ctx.householdId);
        if (!input.mentioned && !household?.autoReceipts) return null;
        const key = await groupConversation();
        if (!key) return null;
        const out = await deps.understand.inbound(principal, key, {
          text: input.text,
          images: input.images,
          source: 'line',
          recordedBy: ctx.speaker.name,
          shared: input.mentioned ? 'mentioned' : 'receipts',
        });
        return out?.kind === 'reply' ? out.text : null;
      }
      if (!input.mentioned) return null;
      // 覚える・止める・忘れる（「@Genie 一時停止」「@Genie 忘れて」「@Genie 覚えるのは24時間」）
      const setting = await groupSettings(context, ctx, input.text, now());
      if (setting)
        return { text: setting.text, ...(setting.choices ? { choices: setting.choices } : {}) };
      const list = await shared.handle(ctx, input.text);
      if (list) {
        // 日程調整（候補を出した・答えた・決めた）は、みんなの計画（ボード）にも映す
        if (deps.boards)
          await syncSchedule(deps.boards.store, ctx, deps.db, now()).catch(() => null);
        return list;
      }
      const key = await groupConversation();
      const book = key ? await deps.understand.handle(principal, key, input.text) : null;
      if (book) return book.answer;
      const read = key
        ? await deps.understand.inbound(principal, key, {
            text: input.text,
            images: [],
            source: 'line',
            shared: 'mentioned',
          })
        : null;
      if (read?.kind === 'reply') return read.text;
      // それ以外は、このグループの会話を踏まえて答える（場所・お店は実際に探す）。個人の予定・メールは使わない
      const helped = await groupAssistant(
        assistant,
        { ...ctx, ownerUserId: ctx.userId },
        input.text,
      ).catch(() => null);
      if (typeof helped === 'string') return helped;
      if (helped)
        return {
          text: helped.answer,
          ...(helped.card ? { card: helped.card } : {}),
          ...(helped.choices?.length ? { choices: helped.choices } : {}),
        };
      return `ごめんなさい、このグループでは分かりませんでした。\n${SHARED_HELP}`;
    },
  };
}

/**
 * 1:1 のトーク・通話・Task Dock の決まった言い方（handleTurn の `understand`）。
 *
 *   「家族の家計簿を見せて」「家族の買い物リスト」 → 本人が使い始めた共有スペース（グループ）の家計簿・リスト
 *   「さっきの結果を家族のグループに送って」     → 送る前に「送ってよいですか」と確かめ、はいで送る
 *   それ以外                                    → 写真・家計簿・個人のリスト（UnderstandService）
 *
 * **グループへ送るのは外への送信**なので、必ず本人の「はい」を待つ（通話でも同じ）。
 */
/** 1 対 1 でできること（「使い方」の答え）。言い方は、それぞれ実際に受けている言い方。 */
export const PERSONAL_HELP = [
  'Genie にできることです（このトークに送るだけで使えます）。',
  '・仕事: 「今の作業どうなってる？」「仕事のホームを開いて」「〇〇は来週まで保留」',
  '・電話: 「電話して」で Genie と声で話せます',
  '・予定: 「今日の予定を教えて」、出た一覧のあとで「打ち合わせを1時間早めて」',
  '・調べもの: 「新橋でいい店ある？」「明日の天気は？」「<URL> を読んで要約して」',
  '外へ送る・予約するなどは、確かめてから行います。',
].join('\n');

export function personalCommands(deps: {
  readonly db: DbHandle;
  readonly understand: UnderstandService;
  readonly timeZone: string;
  /** グループへ送る口（チャネルを組んだあとで入る）。 */
  readonly groups: {
    current: null | {
      postToGroup(tenantId: string, ownerUserId: string, text: string): Promise<number>;
      lastSaid(tenantId: string, conversationId: string): Promise<string | null>;
    };
  };
  /** 今月の LINE の通話の使った分と上限（「どのくらい使った？」）。無ければ答えない。 */
  readonly callUsage?: (principal: { tenantId: string; userId: string }) => Promise<{
    readonly usedSeconds: number;
    readonly monthlyMinutes: number;
  } | null>;
  /** お店探しから予約の手前まで（restaurant.ts）。 */
  readonly restaurants?: import('./restaurant.js').RestaurantDeps;
  /** opencode のセッションの見守り（「このセッションを10分ごとに見て、止まっていたら続けさせて」）。 */
  readonly watches?: Pick<import('./opencode-watch.js').OpencodeWatchService, 'command'>;
  /** 仕事の見通し（「今の作業どうなってる？」・保留・「これが終わったら〇〇して」）。 */
  readonly desk?: Pick<import('./work-desk.js').WorkDesk, 'answer'>;
}) {
  const households = new HouseholdStore(deps.db);
  const shared = sharedSpaceService(deps.db, deps.timeZone);
  const groupContext = new GroupContextStore(deps.db);
  /** 通話の中で Genie が声で答えたもの（LINE には送っていないので、ここで覚える）。 */
  const spoken = new Map<string, { text: string; at: number }>();
  const pending = new Map<string, { text: string; expiresAt: number }>();
  const FAMILY = /^\s*(?:家族|夫婦|共有|うち|わが家|我が家)の\s*/;
  const SEND =
    /^\s*(?:(.+?)(?:を|は))?\s*(?:妻|夫|嫁|家族|みんな|共有|夫婦)?(?:との|の)?\s*(?:LINE|ライン)?\s*グループ(?:に|へ)\s*(?:送って|送っておいて|共有して|流して|送信して)(?:おいて|ください)?[。.！!\s]*$/;
  const ABOUT_LAST =
    /^(?:さっきの|今の|いまの|この|その)?\s*(?:結果|内容|答え|それ|これ|まとめ|案|予算案|計画)?$/;
  const YES = /^\s*(?:はい|うん|お願い(?:します)?|送って|いいよ|ok|yes)[。.!！\s]*$/i;
  const NO = /^\s*(?:いいえ|いや|やめて|送らないで|キャンセル|no)[。.!！\s]*$/i;
  // 1 対 1 で「ボード」（2026-10-28: 1 対 1 で「@Genie ボード」と送って何も出なかった）。ボードはグループごと
  const BOARD =
    /^\s*(?:@\S+\s*)?(?:ボード|みんなの計画)(?:を?(?:見せて|見る|開いて|開く|出して|教えて))?\s*[？?。]?\s*$/;
  // 1 対 1 の「使い方」（リッチメニューの「使い方」もこれを送る）。モデルに任せず、いつも同じ答え
  const HELP = /^\s*(?:@\S+\s*)?(?:使い方|つかいかた|ヘルプ|help|何ができる(?:の)?)\s*[？?。]?\s*$/i;
  const USAGE =
    /(?:クレジット|使用量|利用量|使った量|料金|課金).*(?:使|どのくらい|いくら|何分|教えて|？|\?)|(?:通話|電話).*(?:何分|残り|どのくらい)/;

  return {
    /** 通話で声で答えたことを覚える（「それをグループに送って」の「それ」）。 */
    rememberSpoken(conversationId: string, text: string) {
      spoken.set(conversationId, { text, at: Date.now() });
    },
    async handle(
      principal: { tenantId: string; userId: string },
      conversationId: string,
      text: string,
    ): Promise<{
      answer: string;
      needsClarification: boolean;
      request?: string;
      card?: string;
      choices?: readonly string[];
    } | null> {
      // 使った量を聞いている（2026-10-25 のログ: 「どのくらいのクレジットを使いましたか？」に答えられなかった）。
      // 質問なので「承知しました」は付けない
      if (deps.callUsage && USAGE.test(text)) {
        const usage = await deps.callUsage(principal);
        if (usage) {
          const used = Math.ceil(usage.usedSeconds / 60);
          return {
            answer: [
              `今月の LINE の通話は ${String(used)} 分使いました（上限 ${String(usage.monthlyMinutes)} 分、残り ${String(Math.max(0, usage.monthlyMinutes - used))} 分）。`,
              'Claude・Gemini の API の料金そのものは Genie からは見えません。Anthropic Console と Google AI Studio の利用状況で確かめてください。',
            ].join('\n'),
            needsClarification: false,
          };
        }
      }
      if (HELP.test(text)) return { answer: PERSONAL_HELP, needsClarification: false };
      if (BOARD.test(text))
        return {
          answer:
            'ボード（みんなの計画）はグループごとに作ります。Genie がいるグループで場所探しや日程調整をすると作られ、そのグループで「@Genie ボード」と送るとリンクを出します。',
          needsClarification: false,
        };
      // お店探し（「新橋でいい店ある？」→「今日18時」→「2人」→「予約したい」）。目的を覚えて進める
      if (deps.restaurants) {
        const shop = await restaurantTurn(deps.restaurants, principal, conversationId, text);
        if (shop) return { ...shop, choices: shop.choices ?? [] };
      }
      const watched = await deps.watches?.command(principal, conversationId, text);
      if (watched) return { answer: watched, needsClarification: false };
      const desk = await deps.desk?.answer(principal, conversationId, text);
      if (desk)
        return {
          answer: desk.text,
          needsClarification: false,
          ...(desk.card ? { card: desk.card } : {}),
        };

      const waiting = pending.get(conversationId);
      if (waiting && waiting.expiresAt > Date.now()) {
        if (YES.test(text)) {
          pending.delete(conversationId);
          const sent = await deps.groups.current?.postToGroup(
            principal.tenantId,
            principal.userId,
            waiting.text,
          );
          return {
            answer: sent
              ? 'グループに送りました。'
              : 'グループに送れませんでした（使い始めたグループが無いか、LINE につながっていません）。',
            needsClarification: false,
          };
        }
        if (NO.test(text)) {
          pending.delete(conversationId);
          return { answer: 'グループには送りません。', needsClarification: false };
        }
      }

      const send = SEND.exec(text);
      if (send) {
        const owned = await households.forOwner(principal.tenantId, principal.userId);
        if (owned.length === 0)
          return {
            answer:
              'まだ共有のグループがありません。LINE のグループで「@Genie このグループで使う」と送ると使えます。',
            needsClarification: false,
          };
        const said = (send[1] ?? '')
          .trim()
          .replace(/^[「『"“]+|[」』"”]+$/g, '')
          .trim();
        let body: string | null = said && !ABOUT_LAST.test(said) ? said : null;
        if (!body) {
          const voice = spoken.get(conversationId);
          body =
            voice && Date.now() - voice.at < 30 * 60_000
              ? voice.text
              : ((await deps.groups.current?.lastSaid(principal.tenantId, conversationId)) ?? null);
        }
        if (!body)
          return {
            answer: 'グループに送る内容が見つかりません。送る内容を言ってください。',
            needsClarification: true,
          };
        pending.set(conversationId, { text: body, expiresAt: Date.now() + 10 * 60_000 });
        const preview = body.length > 80 ? `${body.slice(0, 80)}…` : body;
        return {
          answer: `「${preview}」を家族のグループに送ります。よろしいですか？（はい / いいえ）`,
          needsClarification: true,
        };
      }

      if (FAMILY.test(text)) {
        const owned = await households.forOwner(principal.tenantId, principal.userId);
        const household = owned[0];
        if (!household)
          return {
            answer:
              'まだ共有のグループがありません。LINE のグループで「@Genie このグループで使う」と送ると使えます。',
            needsClarification: false,
          };
        const rest = text.replace(FAMILY, '');
        const scoped = { ...principal, householdId: household.id };
        const listed = await shared.handle({ ...scoped, speaker: null }, rest);
        if (listed) return { answer: listed, needsClarification: false };
        // 確かめ中のことは会話（UUID）に結びつける。グループの会話がまだ無ければ家計簿は読まない
        const groupConversation = (await groupContext.settings(principal.tenantId, household.id))
          .conversationId;
        const book = groupConversation
          ? await deps.understand.handle(scoped, groupConversation, rest)
          : null;
        if (book) return book;
      }
      return deps.understand.handle(principal, conversationId, text);
    },
  };
}

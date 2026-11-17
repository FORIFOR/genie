/**
 * Action Board（本人の戦略 2026-10-28 の 02）。LINE のグループの会話から作る、話題ごとの計画。
 *
 *   会話（「土曜」「夕方」「新宿か渋谷」）→ 呼ばれて探す → ボードに条件・候補・決まったこと・まだのことを置く
 *   日程調整（「旅行の日程調整 12/5 12/6」→「決めて」）も同じボードに載る
 *   ボードはリンク（30 日・読むだけ）で開く。何が起きたかを時系列で残す（Action Timeline の始まり）
 *
 * ページ（board-page.ts）に出すのは計画の名前・条件・候補（Google マップの公開情報）・決まったこと・人数の数だけ。
 * 発言の本文・参加者の名前・持ち主の個人のものは、ここには入れない。
 */
import { createHash, randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import { uuidv7 } from '@genie/contracts';
import { withIdentity, withTenant, type DbHandle } from '@genie/db';
import type { Place } from './places.js';
import type { RestaurantSlots } from './restaurant.js';

const LINK_DAYS = 30;
const hash = (token: string) => createHash('sha256').update(token).digest('hex');

export interface BoardCandidate {
  readonly id: string;
  readonly name: string;
  readonly kind: string | null;
  readonly rating: number | null;
  readonly ratingCount: number | null;
  readonly address: string | null;
  readonly mapsUri: string | null;
  readonly openAt: boolean | null;
}

export interface BoardState {
  readonly area?: string;
  /** 会話に出た場所の候補（「新宿か渋谷」）。希望で、決定ではない。 */
  readonly areas?: readonly string[];
  readonly genre?: string;
  readonly date?: string;
  readonly time?: string;
  readonly party?: number;
  /** 人数は会話の人数から仮に置いた。 */
  readonly partyAssumed?: boolean;
  readonly budget?: number;
  readonly candidates?: readonly BoardCandidate[];
  readonly chosen?: string;
  readonly pollId?: string;
  readonly pollDecided?: string;
}

export interface Board {
  readonly id: string;
  readonly tenantId: string;
  readonly householdId: string;
  readonly title: string;
  readonly status: 'planning' | 'decided' | 'closed';
  readonly state: BoardState;
  readonly createdAt: Date;
}

export type BoardEventKind = 'searched' | 'chosen' | 'decided' | 'condition' | 'opened' | 'closed';

/** ページに渡す形（名前・本文は入れない）。 */
export interface BoardView {
  readonly title: string;
  readonly status: Board['status'];
  readonly wants: readonly string[];
  readonly decided: readonly string[];
  readonly open: readonly string[];
  readonly candidates: readonly (BoardCandidate & { readonly chosen: boolean })[];
  readonly schedule: null | {
    readonly title: string;
    readonly voters: number;
    readonly dates: readonly {
      readonly date: string;
      readonly label: string;
      readonly yes: number;
    }[];
    readonly decided: string | null;
  };
  readonly events: readonly { readonly at: string; readonly text: string }[];
  readonly updatedAt: string;
}

const WEEK = ['日', '月', '火', '水', '木', '金', '土'];
export function dateLabel(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return `${String(m)}/${String(d)}（${WEEK[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]!}）`;
}

/** まだ決まっていないこと（状態から決める。作り話はしない）。 */
export function openItems(state: BoardState, schedule: BoardView['schedule']): string[] {
  const open: string[] = [];
  if (!state.chosen)
    open.push(state.candidates?.length ? '行く場所を候補から決める' : '行く場所を探す');
  if (schedule && !schedule.decided) open.push('日程を決める（候補に答える）');
  else if (!schedule && !state.date) open.push('日にちを決める');
  if (state.partyAssumed) open.push(`人数を確かめる（いまは ${String(state.party)} 人で仮置き）`);
  else if (!state.party) open.push('人数を決める');
  if (state.chosen) open.push('予約する（Genie はまだ予約していません）');
  return open;
}

function rowToBoard(row: {
  id: string;
  tenant_id: string;
  household_id: string;
  title: string;
  status: string;
  state: unknown;
  created_at: Date | string;
}): Board {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    householdId: row.household_id,
    title: row.title,
    status: row.status as Board['status'],
    state: (row.state ?? {}) as BoardState,
    createdAt: new Date(row.created_at),
  };
}

export class BoardStore {
  constructor(private readonly db: DbHandle) {}

  /** グループに開いている計画。無ければ null。 */
  async current(tenantId: string, householdId: string): Promise<Board | null> {
    const row = await withTenant(this.db, tenantId, (tx) =>
      tx
        .selectFrom('group_boards')
        .selectAll()
        .where('household_id', '=', householdId)
        .where('status', '<>', 'closed')
        .executeTakeFirst(),
    );
    return row ? rowToBoard(row) : null;
  }

  async create(tenantId: string, householdId: string, title: string, now: Date): Promise<Board> {
    const row = await withTenant(this.db, tenantId, (tx) =>
      tx
        .insertInto('group_boards')
        .values({
          id: uuidv7(),
          tenant_id: tenantId,
          household_id: householdId,
          kind: 'outing',
          title: title.slice(0, 80),
          state: JSON.stringify({}),
          created_at: now,
          updated_at: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow(),
    );
    return rowToBoard(row);
  }

  async save(
    board: Board,
    patch: { title?: string; status?: Board['status']; state?: BoardState },
    now: Date,
  ): Promise<void> {
    await withTenant(this.db, board.tenantId, (tx) =>
      tx
        .updateTable('group_boards')
        .set({
          ...(patch.title ? { title: patch.title.slice(0, 80) } : {}),
          ...(patch.status ? { status: patch.status } : {}),
          ...(patch.state ? { state: JSON.stringify(patch.state) } : {}),
          updated_at: now,
        })
        .where('id', '=', board.id)
        .execute(),
    );
  }

  async event(board: Board, kind: BoardEventKind, text: string, now: Date): Promise<void> {
    await withTenant(this.db, board.tenantId, (tx) =>
      tx
        .insertInto('group_board_events')
        .values({
          id: uuidv7(),
          tenant_id: board.tenantId,
          board_id: board.id,
          kind,
          text: text.slice(0, 200),
          at: now,
        })
        .execute(),
    );
  }

  /** ボードを見るリンクの秘密（平文は返すだけ。残すのはハッシュ）。 */
  async issueLink(board: Board, now: Date): Promise<string> {
    const token = randomBytes(24).toString('base64url');
    await withTenant(this.db, board.tenantId, (tx) =>
      tx
        .insertInto('group_board_links')
        .values({
          token_hash: hash(token),
          tenant_id: board.tenantId,
          board_id: board.id,
          expires_at: new Date(now.getTime() + LINK_DAYS * 86_400_000),
        })
        .execute(),
    );
    return token;
  }

  /** リンクから計画を引く（ページはサインインしないので、テナントはリンクから決まる。中身はそのテナントの中で読む）。 */
  async byToken(token: string): Promise<Board | null> {
    const link = await withIdentity(this.db, (tx) =>
      tx
        .selectFrom('group_board_links')
        .select(['tenant_id', 'board_id'])
        .where('token_hash', '=', hash(token))
        .where('expires_at', '>', sql<Date>`now()`)
        .executeTakeFirst(),
    );
    if (!link) return null;
    const row = await withTenant(this.db, link.tenant_id, (tx) =>
      tx.selectFrom('group_boards').selectAll().where('id', '=', link.board_id).executeTakeFirst(),
    );
    return row ? rowToBoard(row) : null;
  }

  /** ページに出す形。日程の候補は、計画を作ったあとの日程調整を（答えた人の数だけ）載せる。 */
  async view(board: Board): Promise<BoardView> {
    return withTenant(this.db, board.tenantId, async (tx) => {
      const events = await tx
        .selectFrom('group_board_events')
        .select(['text', 'at'])
        .where('board_id', '=', board.id)
        .orderBy('at', 'desc')
        .limit(20)
        .execute();
      const updated = await tx
        .selectFrom('group_boards')
        .select('updated_at')
        .where('id', '=', board.id)
        .executeTakeFirstOrThrow();
      let schedule: BoardView['schedule'] = null;
      if (board.state.pollId) {
        const poll = await tx
          .selectFrom('date_polls')
          .select(['title', 'candidates', 'decided'])
          .where('id', '=', board.state.pollId)
          .executeTakeFirst();
        if (poll) {
          const votes = await tx
            .selectFrom('date_poll_votes')
            .select('available')
            .where('poll_id', '=', board.state.pollId)
            .execute();
          const candidates = poll.candidates as unknown as string[];
          schedule = {
            title: poll.title,
            voters: votes.length,
            dates: candidates.map((date) => ({
              date,
              label: dateLabel(date),
              yes: votes.filter((v) => (v.available as unknown as string[]).includes(date)).length,
            })),
            decided: poll.decided ?? null,
          };
        }
      }
      const s = board.state;
      const chosen = s.candidates?.find((c) => c.id === s.chosen) ?? null;
      const wants: string[] = [];
      if (s.areas && s.areas.length > 1) wants.push(`場所: ${s.areas.join('か')}（希望）`);
      else if (s.area && !chosen) wants.push(`場所: ${s.area}`);
      if (s.genre) wants.push(s.genre === '遊べるスポット' ? '遊べる場所' : s.genre);
      if ((s.date || s.time) && !schedule?.decided)
        wants.push(
          `日時: ${[s.date ? dateLabel(s.date) : '', s.time ?? ''].filter(Boolean).join(' ')}`,
        );
      if (s.party) wants.push(`${String(s.party)} 人${s.partyAssumed ? '（仮）' : ''}`);
      if (s.budget) wants.push(`予算 ¥${s.budget.toLocaleString('ja-JP')}/人`);
      const decided: string[] = [];
      if (chosen) decided.push(`場所: ${chosen.name}`);
      if (schedule?.decided) decided.push(`日程: ${dateLabel(schedule.decided)}`);
      return {
        title: board.title,
        status: board.status,
        wants,
        decided,
        open: openItems(s, schedule),
        candidates: (s.candidates ?? []).map((c) => ({ ...c, chosen: c.id === s.chosen })),
        schedule,
        events: events.map((e) => ({ at: new Date(e.at).toISOString(), text: e.text })),
        updatedAt: new Date(updated.updated_at).toISOString(),
      };
    });
  }
}

const candidateOf = (p: Place): BoardCandidate => ({
  id: p.id,
  name: p.name,
  kind: p.kind,
  rating: p.rating,
  ratingCount: p.ratingCount,
  address: p.address,
  mapsUri: p.mapsUri,
  openAt: p.openAt,
});

/** 計画の名前（「新宿でお出かけ」「渋谷で焼肉」）。 */
function titleFor(slots: RestaurantSlots): string {
  if (!slots.area) return 'みんなの計画';
  if (!slots.genre || slots.genre === '遊べるスポット') return `${slots.area}でお出かけ`;
  return `${slots.area}で${slots.genre}`;
}

export interface BoardSpace {
  readonly tenantId: string;
  readonly householdId: string;
}

/**
 * グループの場所探しの結果を、ボードに映す。変わったことだけを時系列に残す。
 * 返すのは計画（リンクを付けるため）。
 */
export async function syncOuting(
  store: BoardStore,
  space: BoardSpace,
  goal: {
    slots: RestaurantSlots;
    results: readonly Place[];
    areas: readonly string[];
    partyAssumed: boolean;
  },
  now: Date,
): Promise<Board> {
  let board = await store.current(space.tenantId, space.householdId);
  const title = titleFor(goal.slots);
  if (!board) {
    board = await store.create(space.tenantId, space.householdId, title, now);
    await store.event(board, 'opened', `「${title}」の計画を作りました`, now);
  }
  const before = board.state;
  const s = goal.slots;
  const state: BoardState = {
    ...before,
    ...(s.area ? { area: s.area } : {}),
    ...(goal.areas.length > 0 ? { areas: [...goal.areas] } : {}),
    ...(s.genre ? { genre: s.genre } : {}),
    ...(s.date ? { date: s.date } : {}),
    ...(s.time ? { time: s.time } : {}),
    // 人数: 会話の人数で仮に置いたときだけ「仮」。同じ人数のままなら前の印を引き継ぎ、言い直されたら仮ではない
    ...(s.party
      ? {
          party: s.party,
          partyAssumed:
            goal.partyAssumed || (before.party === s.party && before.partyAssumed === true),
        }
      : {}),
    ...(s.budget ? { budget: s.budget } : {}),
    candidates: goal.results.map(candidateOf),
    ...(s.chosen ? { chosen: s.chosen } : {}),
  };

  const ids = (list?: readonly { id: string }[]) => (list ?? []).map((c) => c.id).join(',');
  if (ids(before.candidates) !== ids(state.candidates) && (state.candidates?.length ?? 0) > 0)
    await store.event(
      board,
      'searched',
      `Genie が${state.area ?? ''}で ${String(state.candidates!.length)} 件の候補を探しました`,
      now,
    );
  const conditionChanged = (['date', 'time', 'party', 'budget', 'genre'] as const).some(
    (k) => before[k] !== undefined && state[k] !== before[k],
  );
  if (conditionChanged) await store.event(board, 'condition', '条件が変わりました', now);
  if (state.chosen && state.chosen !== before.chosen) {
    const name = state.candidates?.find((c) => c.id === state.chosen)?.name;
    if (name) await store.event(board, 'chosen', `行く場所を「${name}」にしました`, now);
  }
  const decided = Boolean(state.chosen) && (Boolean(state.pollDecided) || !state.pollId);
  await store.save(
    board,
    {
      state,
      ...(board.title === 'みんなの計画' || !before.area ? { title } : {}),
      status: decided ? 'decided' : 'planning',
    },
    now,
  );
  return { ...board, state };
}

/**
 * グループの日程調整を、ボードに映す（候補を出した・決めた）。開いている計画が無ければ、日程調整の名前で作る。
 * 日程調整がまだ無ければ何もしない。
 */
export async function syncSchedule(
  store: BoardStore,
  space: BoardSpace,
  db: DbHandle,
  now: Date,
): Promise<Board | null> {
  const poll = await withTenant(db, space.tenantId, (tx) =>
    tx
      .selectFrom('date_polls')
      .select(['id', 'title', 'decided', 'created_at'])
      .where('household_id', '=', space.householdId)
      .orderBy('created_at', 'desc')
      .executeTakeFirst(),
  );
  if (!poll) return null;
  let board = await store.current(space.tenantId, space.householdId);
  if (board && board.state.pollId !== poll.id && new Date(poll.created_at) < board.createdAt)
    return board;
  if (!board) {
    board = await store.create(space.tenantId, space.householdId, `${poll.title}の計画`, now);
    await store.event(board, 'opened', `「${poll.title}」の計画を作りました`, now);
  }
  const before = board.state;
  const state: BoardState = {
    ...before,
    pollId: poll.id,
    ...(poll.decided ? { pollDecided: poll.decided } : {}),
  };
  if (before.pollId !== poll.id)
    await store.event(board, 'condition', `日程の候補を出しました（「${poll.title}」）`, now);
  if (poll.decided && before.pollDecided !== poll.decided)
    await store.event(board, 'decided', `日程を ${dateLabel(poll.decided)} に決めました`, now);
  const decided = Boolean(state.pollDecided) && (Boolean(state.chosen) || !state.candidates);
  await store.save(board, { state, status: decided ? 'decided' : 'planning' }, now);
  return { ...board, state };
}

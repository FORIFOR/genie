/**
 * @genie/service-vocabulary
 *
 * 個人の辞書（置き換え）。音声入力で「こう聞こえたら、こう書く」を会話で登録し、Mac が使う。
 *
 *   「辞書に登録: ジーニーは Genie」          → ジーニー → Genie
 *   「『カレンダーリンク』と言ったら『https://…』と入れて」 → 決まった文
 *   「スーパーインターンを辞書に登録して」      → 認識の手がかりだけ
 *   「辞書を見せて」「辞書からジーニーを消して」
 *
 * 予約の言い方と同じく、**決まった言い方だけ**を読む。「この文を英語に変えて」のような普通の頼みを
 * 辞書の登録と読まないように、登録は「辞書」という語か、かぎ括弧か、「と言ったら」があるときだけ。
 */
import { uuidv7 } from '@genie/contracts';
import { withTenant, type DbHandle } from '@genie/db';
import { sql } from 'kysely';

export interface VocabularyEntry {
  readonly id: string;
  readonly spoken: string;
  readonly written: string;
  readonly createdAt: string;
}

/** 1 人が持てる数。Apple の contextualStrings も 100 前後までが目安。 */
export const MAX_VOCABULARY = 300;

export type VocabularyCommand =
  | { readonly kind: 'add'; readonly spoken: string; readonly written: string }
  | { readonly kind: 'list' }
  | { readonly kind: 'remove'; readonly spoken: string };

const Q = '[「『"“]';
const QE = '[」』"”]';
const term = (name: string) => `${Q}?(?<${name}>[^「」『』"“”]{1,100}?)${QE}?`;
const END = '(?:ください|下さい|ね|おいて)?[。．.！!\\s]*$';

/** 「辞書に登録: X は Y」「辞書に X は Y で登録して」など（「辞書」があるもの）。 */
const DICT_PAIR = new RegExp(
  `^\\s*(?:辞書|単語帳)(?:に|へ)?\\s*(?:登録|追加)(?:して)?\\s*[:：、,]?\\s*${term('spoken')}\\s*(?:は|を|→|->)\\s*${term('written')}\\s*(?:と|で|に)?\\s*(?:書いて|書く|表記|入れて|して)?${END}`,
);
const DICT_PAIR_AFTER = new RegExp(
  `^\\s*${term('spoken')}\\s*(?:は|を)\\s*${term('written')}\\s*(?:と|で|に)\\s*(?:書くように|書くよう|表記するように|入れるように|置き換えるように)?\\s*(?:辞書|単語帳)(?:に|へ)\\s*(?:登録|追加)して${END}`,
);
/** かぎ括弧つき: 「X」は「Y」と書いて / 「X」を「Y」に置き換えて */
const QUOTED_PAIR = new RegExp(
  `^\\s*${Q}(?<spoken>[^「」『』"“”]{1,100})${QE}\\s*(?:は|を)\\s*${Q}(?<written>[^「」『』"“”]{1,500})${QE}\\s*(?:と|に)\\s*(?:書いて|表記して|入れて|置き換えて|変換して)${END}`,
);
/** X と言ったら Y と入れて（決まった文）。 */
const SNIPPET = new RegExp(
  `^\\s*${term('spoken')}\\s*と(?:言ったら|いったら|話したら)\\s*${Q}?(?<written>[^「」『』"“”]{1,500}?)${QE}?\\s*(?:と|を)\\s*(?:入れて|書いて|入力して)${END}`,
);
/** X を辞書に登録して（認識の手がかりだけ）。 */
const HINT = new RegExp(
  `^\\s*${term('spoken')}\\s*(?:を|も)\\s*(?:辞書|単語帳)(?:に|へ)\\s*(?:登録|追加)して${END}`,
);
const LIST =
  /^\s*(?:辞書|単語帳|置き換え)(?:の)?(?:一覧|リスト|中身)?(?:を)?(?:見せて|教えて|出して|確認して)?[。？?\s]*$/;
const REMOVE = new RegExp(
  `^\\s*(?:辞書|単語帳|置き換え)から\\s*${term('spoken')}\\s*(?:を)?\\s*(?:消して|削除して|外して)${END}`,
);

/** 辞書の操作なら読む。違えば null。 */
export function parseVocabularyCommand(text: string): VocabularyCommand | null {
  const t = text.trim();
  if (LIST.test(t)) return { kind: 'list' };
  const remove = REMOVE.exec(t);
  if (remove?.groups) return { kind: 'remove', spoken: clean(remove.groups['spoken']!) };
  for (const re of [QUOTED_PAIR, DICT_PAIR, DICT_PAIR_AFTER, SNIPPET]) {
    const m = re.exec(t);
    if (m?.groups) {
      const spoken = clean(m.groups['spoken']!);
      const written = clean(m.groups['written']!);
      if (spoken && written) return { kind: 'add', spoken, written };
    }
  }
  const hint = HINT.exec(t);
  if (hint?.groups) {
    const word = clean(hint.groups['spoken']!);
    if (word) return { kind: 'add', spoken: word, written: word };
  }
  return null;
}

const clean = (s: string) => s.replace(/^[\s「『"“]+|[\s」』"”]+$/g, '').trim();

/**
 * 置き換えを当てる（Mac と同じ規則。サーバで会議の文に当てるときも使う）。
 * 長い聞こえ方から順に。置き換えた結果を、もう一度置き換えない。
 */
export function applyVocabulary(
  text: string,
  entries: readonly Pick<VocabularyEntry, 'spoken' | 'written'>[],
): string {
  const rules = entries
    .filter((e) => e.spoken !== e.written && e.spoken.length > 0)
    .sort((a, b) => b.spoken.length - a.spoken.length);
  if (rules.length === 0) return text;
  const pattern = new RegExp(rules.map((r) => escapeRegExp(r.spoken)).join('|'), 'g');
  const lookup = new Map(rules.map((r) => [r.spoken, r.written]));
  return text.replace(pattern, (m) => lookup.get(m) ?? m);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class VocabularyStore {
  constructor(private readonly db: DbHandle) {}

  async list(tenantId: string, userId: string): Promise<VocabularyEntry[]> {
    return withTenant(this.db, tenantId, async (tx) => {
      const rows = await tx
        .selectFrom('user_vocabulary')
        .selectAll()
        .where('user_id', '=', userId)
        .orderBy('created_at')
        .limit(MAX_VOCABULARY)
        .execute();
      return rows.map((r) => ({
        id: r.id,
        spoken: r.spoken,
        written: r.written,
        createdAt: r.created_at.toISOString(),
      }));
    });
  }

  /** 登録する。同じ聞こえ方は書き方を上書きする。上限を超えるなら 'full'。 */
  async upsert(
    tenantId: string,
    userId: string,
    spoken: string,
    written: string,
  ): Promise<'added' | 'updated' | 'full'> {
    return withTenant(this.db, tenantId, async (tx) => {
      const existing = await tx
        .selectFrom('user_vocabulary')
        .select('id')
        .where('user_id', '=', userId)
        .where('spoken', '=', spoken)
        .executeTakeFirst();
      if (existing) {
        await tx
          .updateTable('user_vocabulary')
          .set({ written, updated_at: sql`now()` })
          .where('id', '=', existing.id)
          .execute();
        return 'updated';
      }
      const count = await tx
        .selectFrom('user_vocabulary')
        .select(sql<string>`count(*)`.as('n'))
        .where('user_id', '=', userId)
        .executeTakeFirstOrThrow();
      if (Number(count.n) >= MAX_VOCABULARY) return 'full';
      await tx
        .insertInto('user_vocabulary')
        .values({ id: uuidv7(), tenant_id: tenantId, user_id: userId, spoken, written })
        .execute();
      return 'added';
    });
  }

  async remove(tenantId: string, userId: string, spokenOrId: string): Promise<boolean> {
    return withTenant(this.db, tenantId, async (tx) => {
      const isId = /^[0-9a-f-]{36}$/i.test(spokenOrId);
      const result = await tx
        .deleteFrom('user_vocabulary')
        .where('user_id', '=', userId)
        .where(isId ? 'id' : 'spoken', '=', spokenOrId)
        .executeTakeFirst();
      return Number(result.numDeletedRows) > 0;
    });
  }
}

/** 会話で辞書を扱う（handleTurn の `vocabulary`）。 */
export class VocabularyService {
  constructor(readonly store: VocabularyStore) {}

  async handle(
    principal: { tenantId: string; userId: string },
    _conversationId: string,
    text: string,
  ): Promise<{ answer: string; needsClarification: boolean } | null> {
    const command = parseVocabularyCommand(text);
    if (!command) return null;
    const { tenantId, userId } = principal;
    switch (command.kind) {
      case 'list': {
        const entries = await this.store.list(tenantId, userId);
        if (entries.length === 0)
          return {
            answer:
              '辞書は空です。「辞書に登録: ジーニーは Genie」のように言うと、音声入力でそう書きます。',
            needsClarification: false,
          };
        const lines = entries
          .slice(0, 30)
          .map((e) =>
            e.spoken === e.written
              ? `・${e.spoken}（聞き取りの手がかり）`
              : `・${e.spoken} → ${e.written.length > 60 ? `${e.written.slice(0, 60)}…` : e.written}`,
          );
        return {
          answer: [
            `辞書（${String(entries.length)} 件）`,
            ...lines,
            entries.length > 30 ? `ほか ${String(entries.length - 30)} 件。` : '',
          ]
            .filter(Boolean)
            .join('\n'),
          needsClarification: false,
        };
      }
      case 'remove': {
        const removed = await this.store.remove(tenantId, userId, command.spoken);
        return {
          answer: removed
            ? `辞書から「${command.spoken}」を消しました。`
            : `辞書に「${command.spoken}」はありません。`,
          needsClarification: false,
        };
      }
      case 'add': {
        const result = await this.store.upsert(tenantId, userId, command.spoken, command.written);
        if (result === 'full')
          return {
            answer: `辞書がいっぱいです（${String(MAX_VOCABULARY)} 件）。使わないものを消してから登録してください。`,
            needsClarification: false,
          };
        const what =
          command.spoken === command.written
            ? `「${command.spoken}」を聞き取りの手がかりに登録しました。`
            : `「${command.spoken}」と聞こえたら「${command.written}」と書きます。`;
        return {
          answer: `${result === 'updated' ? '辞書を書き換えました。' : '辞書に登録しました。'}${what}やめるときは「辞書から${command.spoken}を消して」。`,
          needsClarification: false,
        };
      }
    }
  }
}

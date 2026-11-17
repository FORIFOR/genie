/** 共有スペースの表の代わり（DB を使わない単体の試験用）。 */
import type { ListScope } from '../src/index.js';

export { SharedSpaceService, dayLabel, parseDates } from '../src/index.js';

export interface DatePollLike {
  id: string;
  title: string;
  candidates: string[];
}

const same = (a: string, b: string) =>
  a.normalize('NFKC') === b.normalize('NFKC') || a.includes(b) || b.includes(a);

export class FakeLists {
  items: { id: string; name: string; boughtBy: string | null }[] = [];
  todos: { id: string; title: string; assignee: string | null; done: boolean }[] = [];
  polls: (DatePollLike & {
    open: boolean;
    votes: Map<string, { name: string | null; dates: string[] }>;
  })[] = [];
  autoReceipts = false;

  async add(_s: ListScope, names: readonly string[]) {
    const added: string[] = [];
    for (const name of names) {
      if (this.items.some((i) => !i.boughtBy && i.name === name)) continue;
      this.items.push({ id: String(this.items.length), name, boughtBy: null });
      added.push(name);
    }
    return added;
  }
  async open() {
    return this.items
      .filter((i) => !i.boughtBy)
      .map((i) => ({ id: i.id, name: i.name, addedBy: null }));
  }
  async bought(_s: ListScope, names: readonly string[] | null, by: string | null) {
    const targets = this.items.filter(
      (i) => !i.boughtBy && (names === null || names.some((n) => same(i.name, n))),
    );
    for (const t of targets) t.boughtBy = by ?? '?';
    return targets.map((t) => t.name);
  }
  async setAutoReceipts(_t: string, _h: string, on: boolean) {
    this.autoReceipts = on;
  }

  todoStore = {
    add: async (_s: ListScope, title: string, assignee: string | null) => {
      const todo = { id: String(this.todos.length), title, assignee, done: false };
      this.todos.push(todo);
      return todo;
    },
    open: async () => this.todos.filter((t) => !t.done),
    find: async (_s: ListScope, title: string) =>
      this.todos.find((t) => !t.done && same(t.title, title)) ?? null,
    assign: async (_s: ListScope, id: string, assignee: string) => {
      this.todos.find((t) => t.id === id)!.assignee = assignee;
    },
    done: async (_s: ListScope, id: string) => {
      this.todos.find((t) => t.id === id)!.done = true;
    },
  };

  pollStore = {
    create: async (_t: string, _h: string, title: string, candidates: readonly string[]) => {
      for (const p of this.polls) p.open = false;
      const poll = {
        id: String(this.polls.length),
        title,
        candidates: [...candidates],
        open: true,
        votes: new Map(),
      };
      this.polls.push(poll);
      return poll;
    },
    open: async () => this.polls.find((p) => p.open) ?? null,
    vote: async (
      _t: string,
      pollId: string,
      voter: string,
      name: string | null,
      dates: readonly string[],
    ) => {
      this.polls.find((p) => p.id === pollId)!.votes.set(voter, { name, dates: [...dates] });
    },
    tally: async (_t: string, poll: { id: string; candidates: readonly string[] }) => {
      const p = this.polls.find((x) => x.id === poll.id)!;
      const votes = [...p.votes.entries()];
      return {
        rows: poll.candidates.map((date) => ({
          date,
          names: votes.filter(([, v]) => v.dates.includes(date)).map(([id, v]) => v.name ?? id),
        })),
        voters: votes.length,
      };
    },
    close: async (_t: string, pollId: string) => {
      this.polls.find((p) => p.id === pollId)!.open = false;
    },
  };
}

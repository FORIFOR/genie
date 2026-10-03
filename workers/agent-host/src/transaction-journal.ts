import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  canonicalSha256,
  TransactionSubmitArgs,
  type TradingFill,
  type TransactionReconcileArgs,
  OrderObservation,
} from '@genie/contracts';
import { TransactionFailure, validateObservationProgress } from './transaction-policy.js';

export interface TransactionAttempt {
  readonly version: 1;
  readonly args: TransactionSubmitArgs;
  readonly argsHash: string;
  readonly taskId: string;
  readonly approvalId: string;
  readonly attemptedAt: string;
}

/** The permanent exclusive claim is the authority: it is never deleted or renewed. */
export class TransactionJournal {
  constructor(readonly directory: string) {
    if (!isAbsolute(directory)) throw new TransactionFailure('invalid_journal');
  }
  async #root(): Promise<string> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid?.() ||
      stat.mode & 0o077
    )
      throw new TransactionFailure('invalid_journal');
    return realpath(this.directory);
  }
  async #key(identity: TransactionReconcileArgs): Promise<string> {
    return canonicalSha256({
      provider: identity.provider,
      mode: identity.mode,
      account: identity.account,
      orderKey: identity.orderKey,
    });
  }
  async #sync(root: string): Promise<void> {
    const handle = await open(root, constants.O_RDONLY);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  async find(identity: TransactionReconcileArgs): Promise<TransactionAttempt | null> {
    const root = await this.#root(),
      key = await this.#key(identity);
    let handle;
    try {
      handle = await open(
        join(root, `${key}.attempt.json`),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    try {
      const stat = await handle.stat();
      if (
        !stat.isFile() ||
        stat.uid !== process.getuid?.() ||
        stat.mode & 0o077 ||
        stat.size > 2_000_000
      )
        throw new TransactionFailure('invalid_journal');
      const row = JSON.parse(await handle.readFile('utf8')) as TransactionAttempt;
      const parsed = TransactionSubmitArgs.safeParse(row.args);
      if (
        row.version !== 1 ||
        !parsed.success ||
        !row.taskId ||
        !row.approvalId ||
        !Number.isFinite(Date.parse(row.attemptedAt)) ||
        row.argsHash !== (await canonicalSha256(parsed.data)) ||
        parsed.data.quoteHash !== (await canonicalSha256(parsed.data.quote)) ||
        (await this.#key(parsed.data.quote)) !== key
      )
        throw new TransactionFailure('invalid_journal');
      return { ...row, args: parsed.data };
    } finally {
      await handle.close();
    }
  }
  async claim(attempt: TransactionAttempt): Promise<boolean> {
    const root = await this.#root(),
      key = await this.#key(attempt.args.quote);
    const temporary = join(root, `.${key}.${randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(attempt));
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      try {
        await link(temporary, join(root, `${key}.attempt.json`));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
        throw error;
      }
      // No external input may happen before the complete attempt and directory
      // entry have both reached durable storage. A crash after claim only reconciles.
      await this.#sync(root);
      return true;
    } finally {
      await rm(temporary, { force: true });
    }
  }
  async record(identity: TransactionReconcileArgs, observation: OrderObservation): Promise<void> {
    const root = await this.#root(),
      key = await this.#key(identity);
    const temporary = join(root, `.${key}.${randomUUID()}.observation.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(observation));
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      // Exclusive sequential slots make progress checks linearizable across
      // processes, without a stale lock that a crash could leave behind.
      for (let retry = 0; retry < 30; retry++) {
        const files = (await readdir(root))
          .filter((name) => new RegExp(`^${key}\\.[0-9]{10}\\.observation\\.json$`).test(name))
          .sort();
        const latest = files.at(-1);
        let sequence = 0;
        if (latest) {
          sequence = Number(latest.slice(key.length + 1, key.length + 11)) + 1;
          const previous = await open(
            join(root, latest),
            constants.O_RDONLY | constants.O_NOFOLLOW,
          );
          try {
            const info = await previous.stat();
            if (
              !info.isFile() ||
              info.uid !== process.getuid?.() ||
              info.mode & 0o077 ||
              info.size > 2_000_000
            )
              throw new TransactionFailure('invalid_journal');
            validateObservationProgress(
              OrderObservation.parse(JSON.parse(await previous.readFile('utf8'))),
              observation,
            );
          } finally {
            await previous.close();
          }
        }
        if (sequence > 9_999_999_999) throw new TransactionFailure('invalid_journal');
        try {
          await link(
            temporary,
            join(root, `${key}.${String(sequence).padStart(10, '0')}.observation.json`),
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
          throw error;
        }
        await this.#sync(root);
        return;
      }
      throw new TransactionFailure('journal_busy');
    } finally {
      await rm(temporary, { force: true });
    }
  }

  /**
   * 模擬取引で約定した記録（デイトレードの歯止めの材料）。
   * 試行の記録と、その最新の照合結果だけから作る。照合が無い試行は約定に数えない。
   */
  async stockFills(): Promise<TradingFill[]> {
    const root = await this.#root();
    const names = await readdir(root);
    const fills: TradingFill[] = [];
    for (const name of names.filter((n) => n.endsWith('.attempt.json'))) {
      const key = name.slice(0, -'.attempt.json'.length);
      let attempt: TransactionAttempt | null;
      try {
        const raw = JSON.parse(await readFile(join(root, name), 'utf8')) as TransactionAttempt;
        attempt = await this.find(raw.args.quote);
      } catch {
        throw new TransactionFailure('invalid_journal');
      }
      const stock = attempt?.args.quote.stock;
      if (!attempt || attempt.args.quote.kind !== 'stock_paper' || !stock) continue;
      const latest = names
        .filter((n) => new RegExp(`^${key}\\.[0-9]{10}\\.observation\\.json$`).test(n))
        .sort()
        .at(-1);
      if (!latest) continue;
      const handle = await open(join(root, latest), constants.O_RDONLY | constants.O_NOFOLLOW);
      let observation: OrderObservation;
      try {
        const info = await handle.stat();
        if (
          !info.isFile() ||
          info.uid !== process.getuid?.() ||
          info.mode & 0o077 ||
          info.size > 2_000_000
        )
          throw new TransactionFailure('invalid_journal');
        observation = OrderObservation.parse(JSON.parse(await handle.readFile('utf8')));
      } finally {
        await handle.close();
      }
      for (const fill of observation.fills ?? [])
        fills.push({
          symbol: stock.symbol,
          side: stock.side,
          quantity: fill.quantity,
          priceMinor: fill.priceMinor,
          // 注文を出した順に数える（約定の照合時刻は、照合し直すたびに変わる）
          at: attempt.attemptedAt,
        });
    }
    return fills;
  }
}

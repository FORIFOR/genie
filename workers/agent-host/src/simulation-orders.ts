/** Explicitly opt-in, local simulation. This adapter never contacts a restaurant or broker. */
import { mkdir, lstat, open, realpath, link, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  canonicalSha256,
  OrderObservation,
  TransactionIntent,
  TransactionQuote,
  type TransactionQuote as Quote,
  type OrderObservation as Observation,
} from '@genie/contracts';
import type { TransactionAdapter } from './transaction-adapter.js';

export interface SimulationCheckout {
  readonly directory: string;
  readonly quote: Quote;
  readonly quoteHash: string;
  readonly candidate: Observation;
  readonly authorizationExpiresAt: number;
}

export interface SimulationOrdersConfig {
  readonly root: string;
  /** Opens the owned simulation window and performs native input after normal target consent. */
  readonly confirm: (checkout: SimulationCheckout, signal: AbortSignal) => Promise<void>;
  readonly now?: () => Date;
}

const CATALOG: Record<string, { label: string; unitMinor: number; options: readonly string[] }> = {
  'demo-burger': { label: '模擬バーガー', unitMinor: 500, options: ['セットなし'] },
  'demo-pizza': { label: '模擬マルゲリータ', unitMinor: 1200, options: ['M', 'レギュラー生地'] },
};

async function privateDirectory(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error('simulation_absolute_path_required');
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    stat.mode & 0o077
  )
    throw new Error('simulation_private_directory_required');
  return realpath(path);
}

async function readPrivate(path: string): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      stat.mode & 0o077 ||
      stat.size > 1_000_000
    )
      throw new Error('simulation_invalid_file');
    return JSON.parse(await file.readFile('utf8'));
  } finally {
    await file.close();
  }
}

async function writeOnce(path: string, value: unknown): Promise<boolean> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    try {
      await link(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
    const parent = await open(dirname(path), 'r');
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
    return true;
  } finally {
    await unlink(temporary);
  }
}

export class SimulationOrders implements TransactionAdapter {
  readonly provider = 'genie.simulation';
  readonly mode = 'simulation' as const;
  readonly kinds = ['delivery', 'stock_paper'] as const;
  readonly #now: () => Date;
  constructor(readonly config: SimulationOrdersConfig) {
    this.#now = config.now ?? (() => new Date());
  }

  async #directory(account: string, orderKey: string): Promise<string> {
    const root = await privateDirectory(this.config.root);
    return privateDirectory(join(root, await canonicalSha256({ account, orderKey })));
  }

  async prepare(raw: TransactionIntent, signal: AbortSignal): Promise<Quote> {
    signal.throwIfAborted();
    const intent = TransactionIntent.parse(raw);
    if (
      intent.provider !== this.provider ||
      intent.mode !== 'simulation' ||
      intent.currency !== 'JPY' ||
      intent.account !== 'demo-account' ||
      intent.paymentMethodRef !== 'demo-no-charge' ||
      intent.destination.id !== 'demo-destination'
    )
      throw new Error('simulation_fixture_identity_required');
    const directory = await this.#directory(intent.account, intent.orderKey);
    const intentHash = await canonicalSha256(intent);
    const items = intent.items.map((item) => {
      if (intent.kind === 'stock_paper') {
        const stock = intent.stock!;
        if (
          intent.items.length !== 1 ||
          stock.symbol !== 'GENIE.TEST' ||
          stock.market !== 'SIM' ||
          item.id !== stock.symbol ||
          item.quantity !== stock.quantity ||
          item.options.length
        )
          throw new Error('simulation_unknown_stock');
        const unitMinor = stock.orderType === 'LIMIT' ? stock.limitPriceMinor! : 100;
        return { ...item, unitMinor, lineMinor: unitMinor * item.quantity };
      }
      const entry = CATALOG[item.id];
      if (
        !entry ||
        entry.label !== item.label ||
        JSON.stringify(item.options) !== JSON.stringify(entry.options)
      )
        throw new Error('simulation_unknown_item');
      return { ...item, unitMinor: entry.unitMinor, lineMinor: entry.unitMinor * item.quantity };
    });
    const subtotalMinor = items.reduce((sum, item) => sum + item.lineMinor, 0);
    const feeMinor = intent.kind === 'delivery' ? 300 : 0;
    const { maxTotalMinor: _max, ...content } = intent;
    const quote = TransactionQuote.parse({
      ...content,
      items,
      quoteId: `sim-quote-${randomUUID()}`,
      totals: {
        subtotalMinor,
        taxMinor: 0,
        feeMinor,
        tipMinor: 0,
        totalMinor: subtotalMinor + feeMinor,
      },
      expiresAt: new Date(this.#now().getTime() + 15 * 60_000).toISOString(),
    });
    signal.throwIfAborted();
    const path = join(directory, 'quote.json');
    await writeOnce(path, { intentHash, quote });
    const stored = (await readPrivate(path)) as { intentHash: unknown; quote: unknown };
    if (stored.intentHash !== intentHash) throw new Error('simulation_order_key_conflict');
    return TransactionQuote.parse(stored.quote);
  }

  async inspect(quote: Quote, signal: AbortSignal): Promise<Quote> {
    signal.throwIfAborted();
    const directory = await this.#directory(quote.account, quote.orderKey);
    const stored = (await readPrivate(join(directory, 'quote.json'))) as { quote: unknown };
    return TransactionQuote.parse(stored.quote);
  }

  async submit(
    quote: Quote,
    orderKey: string,
    signal: AbortSignal,
    authorizationExpiresAt: number,
  ): Promise<Observation> {
    signal.throwIfAborted();
    if (quote.orderKey !== orderKey) throw new Error('simulation_identity_mismatch');
    const existing = await this.reconcile(quote, orderKey, signal);
    if (existing) return existing;
    const directory = await this.#directory(quote.account, orderKey);
    const quoteHash = await canonicalSha256(quote);
    const candidate = OrderObservation.parse({
      provider: this.provider,
      mode: this.mode,
      account: quote.account,
      orderKey,
      quoteHash,
      providerOrderId: `SIM-${randomUUID()}`,
      observedAt: this.#now().toISOString(),
      status: quote.kind === 'stock_paper' ? 'filled' : 'accepted',
      details: {
        currency: quote.currency,
        totalMinor: quote.totals.totalMinor,
        destinationId: quote.destination.id,
        paymentMethodRef: quote.paymentMethodRef,
        ...(quote.requestedTime ? { requestedTime: quote.requestedTime } : {}),
        ...(quote.stock ? { stock: quote.stock } : {}),
        items: quote.items,
      },
      ...(quote.stock
        ? {
            fills: [
              {
                executionId: `SIM-FILL-${randomUUID()}`,
                quantity: quote.stock.quantity,
                priceMinor: quote.items[0]!.unitMinor,
              },
            ],
          }
        : {}),
    });
    const checkout = { directory, quote, quoteHash, candidate, authorizationExpiresAt };
    await writeOnce(join(directory, 'checkout.json'), checkout);
    // Only the explicit UI implementation creates receipt.json. Preparing a quote never orders.
    await this.config.confirm(checkout, signal);
    const result = await this.reconcile(quote, orderKey, signal);
    if (!result) throw new Error('simulation_result_unknown');
    return result;
  }

  async reconcile(
    quote: Quote,
    orderKey: string,
    signal: AbortSignal,
  ): Promise<Observation | null> {
    signal.throwIfAborted();
    if (quote.orderKey !== orderKey) throw new Error('simulation_identity_mismatch');
    const directory = await this.#directory(quote.account, orderKey);
    try {
      return OrderObservation.parse(await readPrivate(join(directory, 'receipt.json')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
}

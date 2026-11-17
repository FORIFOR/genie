import { TransactionIntent } from './transaction.js';

/** Fixed fictional examples shared by the preview entry points. Never maps a live request to a demo. */
export type SimulationOrderKind = 'pizza' | 'burger' | 'stock';
export function simulationOrderIntent(
  kind: SimulationOrderKind,
  orderKey: string,
): TransactionIntent {
  if (!['pizza', 'burger', 'stock'].includes(kind)) throw new Error('Unknown simulation kind');
  const paper = kind === 'stock';
  return TransactionIntent.parse({
    kind: paper ? 'stock_paper' : 'delivery',
    mode: 'simulation',
    provider: 'genie.simulation',
    account: 'demo-account',
    orderKey,
    currency: 'JPY',
    paymentMethodRef: 'demo-no-charge',
    destination: {
      id: 'demo-destination',
      label: paper ? '模擬口座（資金移動なし）' : '模擬配送先（配達なし）',
    },
    items: [
      {
        id: paper ? 'GENIE.TEST' : `demo-${kind}`,
        label: paper
          ? '模擬株式 GENIE.TEST'
          : kind === 'pizza'
            ? '模擬マルゲリータ'
            : '模擬バーガー',
        quantity: paper ? 2 : 1,
        options: paper ? [] : kind === 'pizza' ? ['M', 'レギュラー生地'] : ['セットなし'],
      },
    ],
    maxTotalMinor: paper ? 200 : kind === 'pizza' ? 1500 : 800,
    ...(paper
      ? {
          stock: {
            symbol: 'GENIE.TEST',
            market: 'SIM',
            side: 'BUY',
            quantity: 2,
            orderType: 'LIMIT',
            limitPriceMinor: 100,
            timeInForce: 'DAY',
          },
        }
      : { requestedTime: 'asap' }),
  });
}

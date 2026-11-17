import type { SimulationOrderKind } from '@genie/contracts';

/** Only the entire explicit demo request matches. Quoted text, negation, conditions and real merchants don't. */
export function simulationOrderRequest(text: string): SimulationOrderKind | null {
  const match = /^模擬(ピザ|バーガー|株)(?:を)?注文して(?:ください)?[。！!]?$/u.exec(text.trim());
  return match
    ? ({ ピザ: 'pizza', バーガー: 'burger', 株: 'stock' } as const)[
        match[1] as 'ピザ' | 'バーガー' | '株'
      ]
    : null;
}

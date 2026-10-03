import { describe, expect, it } from 'vitest';
import { simulationOrderIntent } from '@genie/contracts';
import { simulationOrderRequest } from '../src/transaction-request.js';
import { routeLane } from '../src/lane.js';

describe('explicit fictional order requests', () => {
  it.each(['ピザ', 'バーガー', '株'])(
    'routes an explicit %s simulation to action with stable identity',
    (item) => {
      const text = `模擬${item}を注文してください。`;
      const kind = simulationOrderRequest(text)!;
      expect(kind).not.toBeNull();
      expect(routeLane({ text, modality: 'text' }).lane).toBe('action');
      const intent = simulationOrderIntent(kind, 'turn:stable');
      expect(intent).toMatchObject({
        mode: 'simulation',
        provider: 'genie.simulation',
        orderKey: 'turn:stable',
      });
      expect(simulationOrderIntent(kind, 'turn:stable')).toEqual(intent);
    },
  );
  it.each([
    'ピザを注文して',
    'マクドナルドを注文して',
    '株を注文して',
    '模擬ピザを注文しないで',
    '模擬ピザを注文してはいけない',
    '模擬ピザを注文してという文を書いて',
    '「模擬ピザを注文して」',
    '模擬ピザを注文して。予算は100円',
    '模擬ピザを注文して、2枚にして',
    '模擬ピザを注文する方法を教えて',
  ])('does not silently replace this request with a fixed demo: %s', (text) => {
    expect(simulationOrderRequest(text)).toBeNull();
  });
  it('keeps meeting and named agent precedence', () => {
    expect(
      routeLane({ text: '模擬ピザを注文して', modality: 'text', meetingActive: true }).lane,
    ).toBe('meeting');
    expect(
      routeLane({ text: '模擬ピザを注文して', modality: 'text', namedAgent: 'other' }).lane,
    ).toBe('specialist-agent');
  });
});

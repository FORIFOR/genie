import { describe, expect, it } from 'vitest';
import { checkoutAssistanceRequest } from '../src/checkout-request.js';
import { routeLane } from '../src/lane.js';

describe('official checkout handoff requests', () => {
  it.each([
    ['マックデリバリーを注文して', 'mcdelivery_jp'],
    ['マクドナルドで注文してください。', 'mcdelivery_jp'],
    ['マックの注文画面を開いて', 'mcdelivery_jp'],
    ['マクドナルドの注文画面を開いて', 'mcdelivery_jp'],
    ['マクドナルドの注文サイトを開いてください', 'mcdelivery_jp'],
    ['ドミノ・ピザを注文して！', 'dominos_jp'],
    ['ドミノでピザを注文してください', 'dominos_jp'],
    ["Domino'sの注文画面を開いて", 'dominos_jp'],
  ])('routes %s to a handoff, without inventing terms', (text, service) => {
    expect(checkoutAssistanceRequest(text)).toBe(service);
    expect(routeLane({ text, modality: 'text' })).toMatchObject({
      lane: 'action',
      reason: 'official checkout site handoff, not an order',
    });
  });
  it.each([
    '「マクドナルドの注文画面を開いて」',
    '『ドミノの注文サイトを開いて』',
    '"マックの注文画面を開いて"',
    'マクドナルドの注文画面を開いてという文を書いて',
    '「ドミノの注文サイトを開いて」という文章を書いてください',
    'マクドナルドの注文画面を開いてはいけない',
    'マクドナルドの注文画面を開く方法を教えて',
  ])('does not turn quoted or explanatory site requests into generic automation: %s', (text) => {
    expect(checkoutAssistanceRequest(text)).toBeNull();
    expect(routeLane({ text, modality: 'text' }).lane).toBe('chat');
  });
  it.each([
    'マクドナルドを注文しないで',
    'ドミノを注文してはいけない',
    'マクドナルドを注文してという文を書いて',
    '「ドミノを注文して」',
    'マクドナルドを注文する方法を教えて',
    'ドミノは注文できますか？',
    'マックを注文して？',
    'マックを注文して。予算は100円',
    'ドミノでピザを注文して、2枚にして',
    'マックを注文して https://evil.example',
    'ピザを注文して',
    '模擬ピザを注文して',
    '株を注文して',
  ])('does not dispatch an inferred or partial request: %s', (text) => {
    expect(checkoutAssistanceRequest(text)).toBeNull();
  });
  it('preserves meeting and named agent routing precedence', () => {
    expect(
      routeLane({ text: 'ドミノを注文して', modality: 'text', meetingActive: true }).lane,
    ).toBe('meeting');
    expect(
      routeLane({ text: 'ドミノを注文して', modality: 'text', namedAgent: 'other' }).lane,
    ).toBe('specialist-agent');
  });
});

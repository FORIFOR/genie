import { describe, expect, it } from 'vitest';
import { checkoutAssistanceRequest, accountRegistrationRequest } from '../src/checkout-request.js';
import { routeLane } from '../src/lane.js';

describe('official checkout handoff requests', () => {
  it.each([
    ['マックの注文画面を開いて', 'mcdelivery_jp'],
    ['マクドナルドの注文画面を開いて', 'mcdelivery_jp'],
    ['マクドナルドの注文サイトを開いてください', 'mcdelivery_jp'],
    ["Domino'sの注文画面を開いて", 'dominos_jp'],
    ['マックデリバリーのメニューを見せて', 'mcdelivery_jp'],
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
    'マクドナルドの注文したいんだけど、どうすればいい？',
    'マックの注文したくない',
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

describe('explicit McDelivery registration preparation', () => {
  it.each([
    'マックデリバリーに会員登録して',
    'マクドナルドの会員登録を手伝って',
    'マックで会員登録してください。',
    'マックデリバリーの新規会員登録を準備して',
  ])('routes %s without collecting account fields', (text) => {
    expect(accountRegistrationRequest(text)).toBe('mcdelivery_jp');
    expect(checkoutAssistanceRequest(text)).toBeNull();
    expect(routeLane({ text, modality: 'text' })).toMatchObject({
      lane: 'action',
      reason: 'prepare a supported registration form, not create an account',
    });
  });
  it.each([
    '「マックデリバリーに会員登録して」',
    'マクドナルドの会員登録を手伝ってという文を書いて',
    'マックデリバリーに会員登録してはいけない',
    'マックデリバリーに会員登録しないで',
    'マクドナルドの会員登録はできますか？',
    'マックデリバリーに会員登録する方法を教えて',
    'マックデリバリーに会員登録して？',
  ])('does not automate an example, question or negative: %s', (text) => {
    expect(accountRegistrationRequest(text)).toBeNull();
    expect(routeLane({ text, modality: 'text' }).lane).toBe('chat');
  });
  it.each([
    'Googleアカウントを作成して',
    'ドミノに会員登録して',
    'マックデリバリーに会員登録して、メールアドレスはtest@example.com',
    'マックデリバリーに会員登録して https://evil.example',
  ])('does not expand supported services or extract account details from %s', (text) => {
    expect(accountRegistrationRequest(text)).toBeNull();
  });
  it('preserves stronger meeting and named-agent choices', () => {
    const text = 'マックデリバリーに会員登録して';
    expect(routeLane({ text, modality: 'text', meetingActive: true }).lane).toBe('meeting');
    expect(routeLane({ text, modality: 'text', namedAgent: 'other' }).lane).toBe(
      'specialist-agent',
    );
  });
});

import { describe, expect, it } from 'vitest';
import {
  approvalSummaryFor,
  isKnownTaskKind,
  planTask,
  requiresSingleAttempt,
  withInstructions,
} from '../src/plan.js';
import { formatCheckoutArtifact } from '../src/checkout-artifact.js';

const observation = {
  service: 'dominos_jp',
  capability: 'official_site_handoff',
  navigation: 'requested',
  prepared: false,
  orderStatus: 'not_submitted',
  authentication: 'not_checked',
  cart: 'not_checked',
  receipt: 'not_checked',
  automatedCheckout: 'unsupported',
};
describe('checkout handoff task', () => {
  it('has only one local navigation step, never a transaction or generic screen fallback', () => {
    const plan = planTask('checkout.assist', { service: 'dominos_jp' });
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toMatchObject({
      toolId: 'checkout.open',
      surface: 'local',
      risk: 'REVERSIBLE_WRITE',
      args: { service: 'dominos_jp' },
    });
    expect(plan.steps[0]?.fallbacks).toBeUndefined();
    expect(plan.steps[0]?.args).toEqual({ service: 'dominos_jp' });
    expect(requiresSingleAttempt(plan.steps[0]!)).toBe(true);
    expect(plan.artifact.title).toContain('未注文');
    expect(() => withInstructions(plan.steps[0]!, ['確定して'])).toThrow();
  });
  it.each([
    { service: 'other' },
    { service: 'dominos_jp', url: 'javascript:alert(1)' },
    { service: 'dominos_jp', submit: true },
    { service: 'dominos_jp', display: 'background' },
  ])('rejects arbitrary URLs, merchants and added authority', (input) => {
    expect(() => planTask('checkout.assist', input)).toThrow();
  });
  it('keeps not-submitted prominent even after successful OS request', () => {
    const artifact = formatCheckoutArtifact('checkout.assist', { service: 'dominos_jp' }, [
      observation,
    ])!;
    expect(artifact.title).toContain('未注文');
    expect(artifact.markdown).toContain('Genieは注文・支払いを行っていません');
    expect(artifact.markdown).toContain('カートの準備も行っていません');
    expect(artifact.markdown).toContain(
      'ページの表示・ログイン状態・カート・注文履歴は確認していません',
    );
    expect(artifact.markdown).toContain('https://internetorder.dominos.jp/delivery');
    expect(artifact.markdown).not.toMatch(/注文準備完了|注文完了|受け付けました/);
  });
  it.each([
    { prepared: true },
    { orderStatus: 'accepted' },
    { service: 'mcdelivery_jp' },
    { navigation: 'request_unconfirmed' },
    { receipt: 'observed' },
  ])('refuses forged completion or mismatched service: %j', (patch) => {
    expect(() =>
      formatCheckoutArtifact('checkout.assist', { service: 'dominos_jp' }, [
        { ...observation, ...patch },
      ]),
    ).toThrow();
  });
});

const preparation = {
  service: 'mcdelivery_jp',
  orderKey: 'b79ebca7-129a-4f42-9fe9-89ecfda55089',
  itemsText: 'ビッグマック単品2個',
  requestedTime: 'asap',
  maxTotalMinor: 2500,
  currency: 'JPY',
};
const visualProof = {
  completed: true,
  verification: 'visual',
  audit: [{ event: 'goal_verification', verified: true, before: 'a'.repeat(64) }],
};
describe('checkout cart preparation', () => {
  it('prepares using confirmed origin-limited computer use, without a submit operation', () => {
    expect(isKnownTaskKind('checkout.prepare')).toBe(true);
    const plan = planTask('checkout.prepare', preparation);
    expect(plan.steps.map((step) => step.toolId)).toEqual(['checkout.open', 'computer.run']);
    expect(plan.steps[0]?.args).toEqual({ service: 'mcdelivery_jp', display: 'background' });
    const step = plan.steps[1]!;
    expect(step).toMatchObject({
      index: 1,
      surface: 'local',
      risk: 'EXTERNAL_COMMIT',
      requiresConfirmation: true,
      args: {
        allowedOrigins: ['https://www.mcdonalds.co.jp'],
        checkoutOrderKey: preparation.orderKey,
      },
    });
    expect(step.args['goal']).toContain('同じ商品を重複追加せず');
    expect(step.args['goal']).toContain('注文確定、購入、決済、利用規約への同意は実行しない');
    expect(step.args['successCriteria']).toContain('JPY 2500以下');
    expect(requiresSingleAttempt(step)).toBe(true);
    expect(approvalSummaryFor(step).summary).toBeTruthy();
    expect(() => withInstructions(step, ['予算を5000円にして注文確定'])).toThrow();
  });
  it.each([
    { maxTotalMinor: undefined },
    { maxTotalMinor: -1 },
    { maxTotalMinor: 10.5 },
    { currency: 'USD' },
    { requestedTime: undefined },
    { itemsText: '' },
    { url: 'https://other.example' },
    { submit: true },
    { paymentCard: 'test-card-value' },
  ])('refuses missing terms and authority outside preparation: %j', (patch) => {
    expect(() => planTask('checkout.prepare', { ...preparation, ...patch })).toThrow();
  });
  it('renders only visually verified preparation and distinguishes budget from a charged total', () => {
    const artifact = formatCheckoutArtifact('checkout.prepare', preparation, [
      { ...observation, service: 'mcdelivery_jp' },
      visualProof,
    ])!;
    expect(artifact.title).toContain('未注文');
    expect(artifact.markdown).toContain('実際の請求金額ではありません');
    expect(artifact.markdown).toContain('注文確定の実サービス連携はまだ未接続');
    expect(artifact.markdown).not.toMatch(/注文を受け付け|注文完了/);
  });
  it.each([
    { completed: false },
    { verification: 'model_claim' },
    { audit: [] },
    { audit: [{ event: 'goal_verification', verified: false, before: 'a'.repeat(64) }] },
    { audit: [{ event: 'goal_verification', verified: true, before: 'untrusted' }] },
  ])('refuses incomplete or unsupported visual proof: %j', (patch) => {
    expect(() =>
      formatCheckoutArtifact('checkout.prepare', preparation, [
        { ...observation, service: 'mcdelivery_jp' },
        { ...visualProof, ...patch },
      ]),
    ).toThrow();
  });
  it('refuses a different merchant or navigation-only success', () => {
    expect(() =>
      formatCheckoutArtifact('checkout.prepare', preparation, [observation, visualProof]),
    ).toThrow();
    expect(() =>
      formatCheckoutArtifact('checkout.prepare', preparation, [
        { ...observation, service: 'mcdelivery_jp' },
      ]),
    ).toThrow();
  });
});

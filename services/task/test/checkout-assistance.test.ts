import { describe, expect, it } from 'vitest';
import { planTask, requiresSingleAttempt, withInstructions } from '../src/plan.js';
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
    expect(requiresSingleAttempt(plan.steps[0]!)).toBe(true);
    expect(plan.artifact.title).toContain('未注文');
    expect(() => withInstructions(plan.steps[0]!, ['確定して'])).toThrow();
  });
  it.each([
    { service: 'other' },
    { service: 'dominos_jp', url: 'javascript:alert(1)' },
    { service: 'dominos_jp', submit: true },
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

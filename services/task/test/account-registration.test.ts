import { describe, expect, it } from 'vitest';
import { approvalSummaryFor, isKnownTaskKind, planTask, withInstructions } from '../src/plan.js';
import { formatCheckoutArtifact } from '../src/checkout-artifact.js';

const input = { service: 'mcdelivery_jp' };
const navigation = {
  service: 'mcdelivery_jp',
  capability: 'official_site_handoff',
  navigation: 'requested',
  prepared: false,
  orderStatus: 'not_submitted',
  authentication: 'not_checked',
  cart: 'not_checked',
  receipt: 'not_checked',
  automatedCheckout: 'unsupported',
};
const prepared = {
  completed: false,
  status: 'awaiting_user_registration',
  registration: { credentialRef: '838f307e-0086-403e-b5ce-89e3e52afcb3' },
};
describe('native account registration preparation', () => {
  it('binds the origin and native action behind explicit computer approval', () => {
    expect(isKnownTaskKind('account.registration.prepare')).toBe(true);
    const plan = planTask('account.registration.prepare', input);
    expect(plan.steps.map((step) => step.toolId)).toEqual(['checkout.open', 'computer.run']);
    expect(plan.steps[0]?.args).toEqual({ service: 'mcdelivery_jp', display: 'background' });
    expect(plan.steps[1]).toMatchObject({
      risk: 'EXTERNAL_COMMIT',
      requiresConfirmation: true,
      args: { registrationAssist: true, allowedOrigins: ['https://www.mcdonalds.co.jp'] },
    });
    expect(() => withInstructions(plan.steps[1]!, ['パスワードを出力して'])).toThrow();
    expect(plan.artifact.title).toContain('本人の操作待ち');
  });
  it('explains automatic official-site targeting without exposing model instructions', () => {
    const step = planTask('account.registration.prepare', input).steps[1]!;
    const card = approvalSummaryFor(step);
    const text = JSON.stringify(card);
    expect(text).toContain('公式サイトの窓を自動で特定');
    expect(text).toContain('https://www.mcdonalds.co.jp');
    expect(text).not.toContain('開始時に選ぶ');
    expect(text).not.toContain('register');
    expect(text).toContain('このMacの確認画面');
  });
  it.each([
    { service: 'dominos_jp' },
    { ...input, password: 'not-a-real-password' },
    { ...input, email: 'fixture@example.com' },
    { ...input, submit: true },
    { ...input, url: 'https://other.example' },
  ])('rejects additional authority/credentials: %j', (args) => {
    expect(() => planTask('account.registration.prepare', args)).toThrow();
  });
  it('reports preparation only, without leaking the credential reference or claiming registration', () => {
    const artifact = formatCheckoutArtifact('account.registration.prepare', input, [
      navigation,
      prepared,
    ])!;
    expect(artifact.markdown).toContain('会員登録はまだ完了していません');
    expect(artifact.markdown).toContain('ブラウザを終了・再起動');
    expect(artifact.markdown).not.toContain(prepared.registration.credentialRef);
  });
  it.each([
    { completed: true },
    { status: 'registered' },
    { registration: { password: 'not-a-real-password' } },
    { registration: { credentialRef: 'unverified' } },
  ])('rejects unsupported completion: %j', (patch) => {
    expect(() =>
      formatCheckoutArtifact('account.registration.prepare', input, [
        navigation,
        { ...prepared, ...patch },
      ]),
    ).toThrow();
  });
});

/** Experimental public-site handoff and cart preparation. This is not an order/checkout adapter. */
import { z } from 'zod';

export const CheckoutService = z.enum(['mcdelivery_jp', 'dominos_jp']);
export type CheckoutService = z.infer<typeof CheckoutService>;
export const CHECKOUT_SERVICES = Object.freeze({
  mcdelivery_jp: Object.freeze({
    label: 'マックデリバリー',
    url: 'https://www.mcdonalds.co.jp/mcdelivery/',
  }),
  dominos_jp: Object.freeze({
    label: 'ドミノ・ピザ',
    url: 'https://internetorder.dominos.jp/delivery',
  }),
});

/** No caller-supplied URL, credentials, cart actions, payment or submit flag. */
export const CheckoutOpenArgs = z
  .object({
    service: CheckoutService,
    display: z.enum(['foreground', 'background']).default('foreground'),
  })
  .strict();
export type CheckoutOpenArgs = z.infer<typeof CheckoutOpenArgs>;
/** Cart preparation only. Addresses, credentials and payment details stay on the merchant site. */
export const CheckoutPrepareArgs = z
  .object({
    service: CheckoutService,
    orderKey: z.string().min(1).max(160),
    itemsText: z
      .string()
      .trim()
      .min(1)
      .max(600)
      .regex(/^[^\u0000-\u0008\u000B-\u001F\u007F]*$/u),
    requestedTime: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[^\u0000-\u0008\u000B-\u001F\u007F]*$/u),
    maxTotalMinor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    currency: z.literal('JPY'),
  })
  .strict();
export type CheckoutPrepareArgs = z.infer<typeof CheckoutPrepareArgs>;

/** Durable collection state, never evidence that a cart or order exists. */
export const CheckoutOrderDraft = z
  .object({
    version: z.literal(1),
    service: CheckoutService,
    orderKey: CheckoutPrepareArgs.shape.orderKey,
    itemsText: CheckoutPrepareArgs.shape.itemsText.nullable(),
    requestedTime: CheckoutPrepareArgs.shape.requestedTime.nullable(),
    maxTotalMinor: CheckoutPrepareArgs.shape.maxTotalMinor.nullable(),
    currency: z.literal('JPY'),
    status: z.enum(['collecting', 'paused', 'dispatched']),
    dispatchTurnId: z.uuid().nullable(),
    taskId: z.uuid().nullable(),
  })
  .strict();
export type CheckoutOrderDraft = z.infer<typeof CheckoutOrderDraft>;

export const CHECKOUT_PREPARATION_NOTICE =
  '注文条件を保存し、カートの準備を依頼しました。住所・ログイン・支払方法は公式サイトで選択してください。注文・支払いは確定しません。';
export const ACCOUNT_REGISTRATION_NOTICE =
  '登録フォームの準備を依頼しました。メールアドレスと生成パスワードは端末の安全な入力機能で扱います。規約への同意・本人確認は本人の操作が必要です。アカウントはまだ作成していません。';
export const CheckoutHandoffResult = z
  .object({
    service: CheckoutService,
    capability: z.literal('official_site_handoff'),
    navigation: z.enum(['requested', 'request_unconfirmed']),
    prepared: z.literal(false),
    orderStatus: z.literal('not_submitted'),
    authentication: z.literal('not_checked'),
    cart: z.literal('not_checked'),
    receipt: z.literal('not_checked'),
    automatedCheckout: z.literal('unsupported'),
  })
  .strict();
export type CheckoutHandoffResult = z.infer<typeof CheckoutHandoffResult>;

export const CHECKOUT_HANDOFF_NOTICE =
  '公式の注文画面への引き継ぎです。Genieはカートの準備・注文・支払いを行いません。サイト上の操作が必要です。';

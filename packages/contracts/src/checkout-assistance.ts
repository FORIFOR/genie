/** Experimental public-site handoff. This is not an order/checkout adapter. */
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
export const CheckoutOpenArgs = z.object({ service: CheckoutService }).strict();
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

/** テナント / ユーザー / デバイス / セッション。実装仕様 §4。 */
import { z } from 'zod';
import { DeviceId, SessionId, TenantId, UserId } from './ids.js';
import { Semver, Timestamp } from './primitives.js';
import { ComplianceProfile } from './plugin.js';

export const TenantKind = z.enum(['personal', 'organization']);
export type TenantKind = z.infer<typeof TenantKind>;

export const Tenant = z.object({
  id: TenantId,
  name: z.string().max(200),
  kind: TenantKind,
  compliance_profile: ComplianceProfile,
  created_at: Timestamp,
});
export type Tenant = z.infer<typeof Tenant>;

export const MembershipRole = z.enum(['owner', 'admin', 'member']);
export type MembershipRole = z.infer<typeof MembershipRole>;

export const User = z.object({
  id: UserId,
  email: z.email(),
  display_name: z.string().max(200),
  created_at: Timestamp,
});
export type User = z.infer<typeof User>;

/** 利用者が持つ端末の種類。サインインで名乗れるのはこれだけ。 */
export const Platform = z.enum(['macos', 'windows', 'linux', 'web']);
export type Platform = z.infer<typeof Platform>;

/**
 * チャットの提供者（Slack / LINE）。チャネル連携（channel_links）の区分。
 *
 * 電話（Oathra）はここに入れない。電話は会話の入口であって、本人の端末ではない。
 */
export const ChannelProvider = z.enum(['slack', 'line']);
export type ChannelProvider = z.infer<typeof ChannelProvider>;

/**
 * devices 行の種類。端末（`Platform`）か、チャネル連携の**仮の端末**。
 *
 * チャネルから来た依頼にも `deviceId` が要る（`requirePrincipal`、監査の記録）。
 * 連携 1 件につき仮の端末を 1 つ登録し、連携を切るときに revoke する。
 * こうすると認証の作りを緩めずに済み、記録に「どこから来た依頼か」が残る。
 *
 * **サインインの要求（`DevTokenRequest` / `IdpSignInRequest`）は `Platform` のまま。**
 * クライアントがチャネルを名乗って端末を作れないようにする。
 */
export const DevicePlatform = z.enum([...Platform.options, ...ChannelProvider.options]);
export type DevicePlatform = z.infer<typeof DevicePlatform>;

export const isChannelDevice = (platform: DevicePlatform): platform is ChannelProvider =>
  (ChannelProvider.options as readonly string[]).includes(platform);

export const Device = z.object({
  id: DeviceId,
  tenant_id: TenantId,
  user_id: UserId,
  platform: DevicePlatform,
  name: z.string().max(200),
  app_version: Semver,
  last_seen_at: Timestamp.nullable(),
  created_at: Timestamp,
});
export type Device = z.infer<typeof Device>;

/** アクセストークンのクレーム。実装仕様 §4.2。 */
export const AccessTokenClaims = z.object({
  iss: z.string(),
  aud: z.string(),
  sub: UserId,
  tid: TenantId,
  did: DeviceId,
  scp: z.array(z.string()),
  jti: z.uuid(),
  iat: z.number().int(),
  exp: z.number().int(),
});
export type AccessTokenClaims = z.infer<typeof AccessTokenClaims>;

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
export const DEVICE_TOKEN_TTL_SECONDS = 24 * 60 * 60;

export const TokenResponse = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  /** host bridge 専用（aud: astra-host-bridge）。access token を bridge に使わせない。 */
  device_token: z.string(),
  expires_in: z.number().int().positive(),
  token_type: z.literal('Bearer'),
});
export type TokenResponse = z.infer<typeof TokenResponse>;

export const RefreshRequest = z.object({ refresh_token: z.string().min(1) });
export type RefreshRequest = z.infer<typeof RefreshRequest>;

/** 開発専用。ASTRA_ENV=development でのみルートを登録する（実装仕様 §4.3）。 */
export const DevTokenRequest = z.object({
  email: z.email(),
  display_name: z.string().max(200).default('Dev User'),
  device_name: z.string().max(200).default('dev-device'),
  platform: Platform.default('macos'),
  app_version: Semver.default('0.1.0'),
});
export type DevTokenRequest = z.infer<typeof DevTokenRequest>;

export const MeResponse = z.object({
  user: User,
  tenant: Tenant,
  device: Device,
  role: MembershipRole,
});
export type MeResponse = z.infer<typeof MeResponse>;

export const Session = z.object({
  id: SessionId,
  tenant_id: TenantId,
  user_id: UserId,
  device_id: DeviceId,
  expires_at: Timestamp,
  revoked_at: Timestamp.nullable(),
  created_at: Timestamp,
});
export type Session = z.infer<typeof Session>;

// ------------------------------------------------------------ external IdP

/**
 * 外部の身元提供者でのサインイン。deepnote-desktop の Google / Apple / LINE を、
 * Firebase を挟まずに Genie 自身の identity へ繋ぐ。
 *
 * 端末は提供者の **ID トークン**だけをサーバへ渡す。access / refresh token は渡さない
 * （Google の refresh token は connector 用で、Keychain の外へ出さない — 正本 §21）。
 */
export const IdentityProvider = z.enum(['google', 'apple', 'line']);
export type IdentityProvider = z.infer<typeof IdentityProvider>;

export const IdpSignInRequest = z.object({
  provider: IdentityProvider,
  /** 提供者が発行した ID トークン（JWT）。サーバが提供者の鍵で検証する。 */
  id_token: z.string().min(20).max(8192),
  /** Apple の native flow で使った生の nonce。無ければ null。 */
  nonce: z.string().max(200).nullable().default(null),
  /** Apple は初回しか名前を返さないので、端末が受け取ったものを添える。 */
  display_name: z.string().max(200).nullable().default(null),
  device_name: z.string().max(200).default('device'),
  platform: Platform.default('macos'),
  app_version: Semver.default('0.1.0'),
});
export type IdpSignInRequest = z.infer<typeof IdpSignInRequest>;

/** どの提供者で入れるか。**設定されていないものを「使える」と言わない。** */
export const AuthProvidersResponse = z.object({
  providers: z.array(
    z.object({
      id: IdentityProvider,
      configured: z.boolean(),
      /** 端末側が authorize URL を組むのに要る公開の client id（native client）。 */
      client_id: z.string().nullable().default(null),
      /** ブラウザ経由の relay（Apple web / LINE）。無ければ null。 */
      relay_path: z.string().nullable().default(null),
    }),
  ),
  /** 開発用の email サインインが開いているか。本番では false。 */
  dev_email: z.boolean(),
});
export type AuthProvidersResponse = z.infer<typeof AuthProvidersResponse>;

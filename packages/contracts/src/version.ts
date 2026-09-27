/**
 * 契約のバージョン。実装仕様 §3.8。
 *
 * - API のメジャー版 (`/v1`) と `API_VERSION` は対応する。
 * - 後方互換な追加（optional フィールド追加・enum 値追加）はマイナーを上げる。
 * - 破壊的変更はメジャーを上げ、同時に `API_VERSION` を切る。
 * - CI は破壊的変更検知時にこの値が上がっていることを検査する（実装仕様 §14.3-4）。
 */
export const CONTRACTS_VERSION = '0.47.0' as const;
export const API_VERSION = 'v1' as const;

/** アプリ本体の版。plugin manifest の `min_core_version` 判定に使う。 */
export const CORE_VERSION = '0.1.0' as const;

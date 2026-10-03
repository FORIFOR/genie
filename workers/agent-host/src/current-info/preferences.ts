/**
 * 既定の地域。Mac の設定が書く current-info.json を、聞かれるたびに読む。
 *
 * 地域は端末に残る。cloud には送らず、質問に地名が無いときだけ使う。
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PREFECTURE_NAMES } from './places.js';

export const DEFAULT_REGION = '東京都';

export function currentInfoPreferencesPath(
  env: Record<string, string | undefined> = process.env,
  home = homedir(),
): string {
  return env['ASTRA_DATA_ROOT']
    ? join(env['ASTRA_DATA_ROOT'], 'current-info.json')
    : join(home, 'Library/Application Support/Astra/current-info.json');
}

/** 読めない・知らない値なら東京都。 */
export function defaultRegion(path = currentInfoPreferencesPath()): string {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    const region =
      value && typeof value === 'object' ? (value as Record<string, unknown>)['default_region'] : null;
    if (typeof region === 'string' && PREFECTURE_NAMES.includes(region)) return region;
  } catch {
    // 無い・壊れている: 既定に戻す
  }
  return DEFAULT_REGION;
}

/**
 * 端末とチャネル連携の仮の端末。クライアントがチャネルを名乗れないこと。
 */
import { describe, expect, it } from 'vitest';
import {
  ChannelProvider,
  DevicePlatform,
  DevTokenRequest,
  IdpSignInRequest,
  Platform,
  isChannelDevice,
} from '../src/index.js';

describe('DevicePlatform', () => {
  it('holds every real platform and every channel', () => {
    expect(DevicePlatform.options).toEqual([...Platform.options, ...ChannelProvider.options]);
    expect(isChannelDevice('slack')).toBe(true);
    expect(isChannelDevice('line')).toBe(true);
    expect(isChannelDevice('macos')).toBe(false);
  });

  it('never lets a sign-in request register a channel device', () => {
    for (const platform of ChannelProvider.options) {
      expect(Platform.safeParse(platform).success, platform).toBe(false);
      expect(DevTokenRequest.shape.platform.safeParse(platform).success, platform).toBe(false);
      expect(IdpSignInRequest.shape.platform.safeParse(platform).success, platform).toBe(false);
    }
  });
});

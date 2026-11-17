/**
 * ニュースの画像を出してよいか（Media Rights Resolver）。台帳に載った使い方のときだけ写真。
 */
import { describe, expect, it } from 'vitest';
import {
  NEWS_MEDIA_LICENSES,
  resolveNewsImage,
  type MediaLicense,
  type NewsMedia,
} from '../src/news-media.js';

const NOW = new Date('2026-10-29T00:00:00Z');
const LICENSE: MediaLicense = {
  id: 'lic-1',
  provider: 'Example Wire',
  imageHosts: ['images.example-wire.com'],
  allowedUses: ['line_distribution'],
  attribution: 'Example Wire',
  validUntil: '2027-01-01T00:00:00Z',
};
const MEDIA: NewsMedia = {
  image_url: 'https://images.example-wire.com/a.jpg',
  provider: 'Example Wire',
  license_id: 'lic-1',
};

describe('deciding whether a news image may be shown', () => {
  it('shows a photo only for a ledgered use, provider, host and period', () => {
    expect(resolveNewsImage(MEDIA, 'line_distribution', [LICENSE], NOW)).toEqual({
      display: 'photo',
      url: 'https://images.example-wire.com/a.jpg',
      attribution: 'Example Wire',
    });
  });

  it.each([
    ['no image', null, [LICENSE], 'line_distribution', 'no_image'],
    [
      'no license id (a bare og:image)',
      { ...MEDIA, license_id: null },
      [LICENSE],
      'line_distribution',
      'no_license',
    ],
    ['license not in the ledger', MEDIA, [], 'line_distribution', 'unknown_license'],
    [
      'another provider claiming the license',
      { ...MEDIA, provider: 'Other' },
      [LICENSE],
      'line_distribution',
      'other_provider',
    ],
    ['a use the license does not cover', MEDIA, [LICENSE], 'liff_display', 'use_not_allowed'],
    [
      'an expired license',
      MEDIA,
      [{ ...LICENSE, validUntil: '2026-10-01T00:00:00Z' }],
      'line_distribution',
      'expired',
    ],
    [
      'an image on another host',
      { ...MEDIA, image_url: 'https://evil.example/a.jpg' },
      [LICENSE],
      'line_distribution',
      'untrusted_host',
    ],
    [
      'an http image',
      { ...MEDIA, image_url: 'http://images.example-wire.com/a.jpg' },
      [LICENSE],
      'line_distribution',
      'untrusted_host',
    ],
  ] as const)('falls back to the icon for %s', (_label, media, ledger, use, reason) => {
    expect(resolveNewsImage(media, use, ledger, NOW)).toEqual({ display: 'icon', reason });
  });

  it('starts with an empty ledger (no contract yet)', () => {
    expect(NEWS_MEDIA_LICENSES).toEqual([]);
    expect(resolveNewsImage(MEDIA, 'line_distribution', NEWS_MEDIA_LICENSES, NOW).display).toBe(
      'icon',
    );
  });
});

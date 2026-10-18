/**
 * 秘密の封。**鍵が無ければ置かない・別の行の封は開かない・古い鍵の封も読める。**
 */
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SecretKeyError, secretBox, secretBoxFromEnv } from '../src/secret.js';

const hexKey = () => randomBytes(32).toString('hex');

describe('secretBox', () => {
  it('封じたものは同じ aad でだけ開く', () => {
    const box = secretBox(hexKey());
    const sealed = box.seal('agent-token-123', 'phone_connections:t:u:g');
    expect(sealed.startsWith(`v1:${box.keyId}:`)).toBe(true);
    expect(sealed).not.toContain('agent-token-123');
    expect(box.open(sealed, 'phone_connections:t:u:g')).toBe('agent-token-123');
    expect(() => box.open(sealed, 'phone_connections:t:other:g')).toThrow(SecretKeyError);
  });

  it('改ざん・形の崩れ・知らない鍵は開かない', () => {
    const box = secretBox(hexKey());
    const sealed = box.seal('x', 'a');
    const parts = sealed.split(':');
    parts[4] = Buffer.from('y').toString('base64url');
    expect(() => box.open(parts.join(':'), 'a')).toThrow(SecretKeyError);
    expect(() => box.open('v0:a:b:c:d', 'a')).toThrow(SecretKeyError);
    expect(() => secretBox(hexKey()).open(sealed, 'a')).toThrow(/見つかりません/);
  });

  it('鍵を替えても、古い鍵の封は GENIE_SECRET_KEYS_OLD で読める', () => {
    const oldKey = hexKey();
    const sealed = secretBox(oldKey).seal('token', 'a');
    const rotated = secretBox(hexKey(), [oldKey]);
    expect(rotated.open(sealed, 'a')).toBe('token');
    expect(rotated.seal('token', 'a').split(':')[1]).toBe(rotated.keyId);
  });

  it('base64 の鍵も受け、32 バイトでない鍵は断る', () => {
    expect(() => secretBox(randomBytes(32).toString('base64'))).not.toThrow();
    expect(() => secretBox('short')).toThrow(SecretKeyError);
  });
});

describe('secretBoxFromEnv', () => {
  it('鍵が無ければ null', () => {
    expect(secretBoxFromEnv({})).toBeNull();
    const key = hexKey();
    expect(secretBoxFromEnv({ GENIE_SECRET_KEY: key })?.keyId).toBe(secretBox(key).keyId);
  });
});

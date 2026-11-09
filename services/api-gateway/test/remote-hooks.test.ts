/**
 * 別の PC の Claude Code をつなぐ（remote-hooks.ts）: 合言葉・公開の入口・入れ方のスクリプト（純粋な部分）。
 */
import { describe, expect, it } from 'vitest';
import {
  DEVICE_NAME,
  PAIR_CODE,
  PairingCodes,
  installerScript,
  pairCommand,
  publicBase,
} from '../src/remote-hooks.js';

describe('合言葉', () => {
  it('1 回だけ・10 分だけ使える', () => {
    let now = 1_000_000;
    const codes = new PairingCodes(() => now);
    const a = codes.issue({ tenantId: 't', userId: 'u', device: 'MacBook Air' });
    expect(PAIR_CODE.test(a.code)).toBe(true);
    expect(codes.take(a.code)).toEqual({ tenantId: 't', userId: 'u', device: 'MacBook Air' });
    expect(codes.take(a.code)).toBeNull();

    const b = codes.issue({ tenantId: 't', userId: 'u', device: 'MacBook Air' });
    now += 10 * 60_000;
    expect(codes.take(b.code)).toBeNull();
    expect(codes.take('x'.repeat(43))).toBeNull();
  });
});

describe('公開の入口', () => {
  it('https のホストだけを使う', () => {
    expect(publicBase('https://abc-def.trycloudflare.com')).toBe(
      'https://abc-def.trycloudflare.com',
    );
    expect(publicBase('https://abc.example.com/path?q=1')).toBe('https://abc.example.com');
    expect(publicBase('http://abc.example.com')).toBeNull();
    expect(publicBase('https://user:pw@abc.example.com')).toBeNull();
    expect(publicBase('')).toBeNull();
    expect(publicBase(null)).toBeNull();
    expect(publicBase('not a url')).toBeNull();
    expect(pairCommand('https://a.example.com', 'c'.repeat(43))).toBe(
      `curl -fsSL https://a.example.com/v1/agent-pair/${'c'.repeat(43)} | sh`,
    );
  });
});

describe('PC の名前', () => {
  it('シェルの文字列を壊す記号を通さない', () => {
    for (const ok of ['MacBook Air', 'office-mac', '会社のMac', 'Mac.mini_2'])
      expect(DEVICE_NAME.test(ok)).toBe(true);
    for (const bad of ["a'b", 'a"b', 'a$(x)', 'a`x`', 'a;b', ' lead', '', 'x'.repeat(41), 'a\nb'])
      expect(DEVICE_NAME.test(bad)).toBe(false);
  });
});

describe('入れ方のスクリプト', () => {
  const base = 'https://abc.trycloudflare.com';
  const token = `gac_${'A'.repeat(43)}`;

  it('鍵はキーチェーンへ標準入力で渡し、hooks はその PC の ~/.genie に置く', () => {
    const script = installerScript({ base, token, device: 'MacBook Air' });
    expect(script.startsWith('#!/bin/sh\n')).toBe(true);
    // 鍵は security -i の標準入力（コマンドの引数に載せない）
    expect(script).toMatch(/printf 'add-generic-password[^\n]*\\\n {2}\| \/usr\/bin\/security -i/);
    expect(script.split(token)).toHaveLength(2);
    expect(script).toContain(`base='${base}'`);
    expect(script).toContain(`'claude-code-hook.sh') + ' ' + base`);
    expect(script).toContain('timeout: 600');
    // 送り先は https の入口だけ
    expect(script).toContain('case "$base" in https://*) ;; *) exit 0 ;; esac');
  });

  it('形の違う値は埋めない', () => {
    expect(() => installerScript({ base: 'http://a.example.com', token, device: 'A' })).toThrow();
    expect(() => installerScript({ base: `${base}/x`, token, device: 'A' })).toThrow();
    expect(() => installerScript({ base, token: "a'; touch /tmp/x; '", device: 'A' })).toThrow();
    expect(() => installerScript({ base, token, device: "A'; touch /tmp/x" })).toThrow();
  });
});

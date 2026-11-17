import { describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertRegistrationScreenshotPrivacy } from '../src/registration-privacy.js';

describe('registration screenshot privacy egress', () => {
  it('does not require a helper until registration has used the private barrier', () => {
    const root = mkdtempSync(join(tmpdir(), 'genie-privacy-test-'));
    try {
      const dir = join(root, 'locks');
      expect(() => assertRegistrationScreenshotPrivacy(dir, undefined)).not.toThrow();
      mkdirSync(dir, { mode: 0o700 });
      expect(() => assertRegistrationScreenshotPrivacy(dir, undefined)).not.toThrow();
      writeFileSync(join(dir, 'a'.repeat(64)), '', { mode: 0o600 });
      expect(() => assertRegistrationScreenshotPrivacy(dir, undefined)).toThrow(/登録用パスワード/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('only an exact native inactive response can release egress', () => {
    const root = mkdtempSync(join(tmpdir(), 'genie-privacy-test-'));
    try {
      const dir = join(root, 'locks');
      mkdirSync(dir, { mode: 0o700 });
      writeFileSync(join(dir, 'a'.repeat(64)), '', { mode: 0o600 });
      const helper = join(root, 'fixture-helper');
      for (const response of [
        '{"blocked":true}',
        'invalid',
        '{}',
        '{"blocked":false,"extra":true}',
      ]) {
        writeFileSync(helper, "#!/bin/sh\nprintf '%s' '" + response + "'\n", { mode: 0o700 });
        expect(() => assertRegistrationScreenshotPrivacy(dir, helper)).toThrow();
      }
      writeFileSync(helper, "#!/bin/sh\nprintf '%s' '{\"blocked\":false}'\n", { mode: 0o700 });
      expect(() => assertRegistrationScreenshotPrivacy(dir, helper)).not.toThrow();
      chmodSync(dir, 0o755);
      expect(() => assertRegistrationScreenshotPrivacy(dir, helper)).toThrow();
      chmodSync(dir, 0o700);
      writeFileSync(join(dir, 'unexpected'), '');
      expect(() => assertRegistrationScreenshotPrivacy(dir, helper)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('refuses a symlink even when the target folder is private and empty', () => {
    const root = mkdtempSync(join(tmpdir(), 'genie-privacy-test-'));
    try {
      const dir = join(root, 'real');
      mkdirSync(dir, { mode: 0o700 });
      symlinkSync(dir, join(root, 'alias'));
      expect(() => assertRegistrationScreenshotPrivacy(join(root, 'alias'), undefined)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('refuses a newly registered browser even if it exits during the native check', () => {
    const root = mkdtempSync(join(tmpdir(), 'genie-privacy-test-'));
    try {
      const dir = join(root, 'locks');
      mkdirSync(dir, { mode: 0o700 });
      writeFileSync(join(dir, 'a'.repeat(64)), '', { mode: 0o600 });
      const helper = join(root, 'fixture-helper');
      // The fixture adds a durable marker, then reports that its browser exited.
      writeFileSync(
        helper,
        `#!/bin/sh\numask 077\ntouch "$(dirname "$0")/locks/${'b'.repeat(64)}"\nprintf '%s' '{"blocked":false}'\n`,
        { mode: 0o700 },
      );
      expect(() => assertRegistrationScreenshotPrivacy(dir, helper)).toThrow(/登録用パスワード/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

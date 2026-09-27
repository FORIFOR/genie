import { describe, expect, it } from 'vitest';
import {
  verifyAllCriteria,
  verifyAxState,
  verifyCriterion,
  verifyFileContent,
  verifyFileExists,
  verifyProcessExit,
} from '../src/verifier.js';
import type { VerificationCriteria } from '@genie/contracts';

describe('Deterministic Verifier', () => {
  describe('verifyFileExists', () => {
    it('returns satisfied=false when stat returns null (file missing)', async () => {
      const res = await verifyFileExists('f1', { path: '/tmp/missing.txt' }, {
        stat: async () => null,
      });
      expect(res.satisfied).toBe(false);
      expect(res.message).toContain('File does not exist');
      expect(res.evidence).toBeUndefined();
    });

    it('returns satisfied=false when file size is below min_bytes', async () => {
      const res = await verifyFileExists(
        'f2',
        { path: '/tmp/test.txt', min_bytes: 100 },
        {
          stat: async () => ({ size: 50, mtimeMs: Date.now() }),
        },
      );
      expect(res.satisfied).toBe(false);
      expect(res.message).toContain('less than expected minimum');
    });

    it('returns satisfied=false when file mtime is older than threshold', async () => {
      const threshold = 1_700_000_000_000;
      const res = await verifyFileExists(
        'f3',
        { path: '/tmp/test.txt', mtime_after_ms: threshold },
        {
          stat: async () => ({ size: 500, mtimeMs: threshold - 1000 }),
        },
      );
      expect(res.satisfied).toBe(false);
      expect(res.message).toContain('earlier than threshold');
    });

    it('returns satisfied=true and evidence when all constraints are met', async () => {
      const threshold = 1_700_000_000_000;
      const res = await verifyFileExists(
        'f4',
        { path: '/tmp/test.txt', min_bytes: 100, mtime_after_ms: threshold },
        {
          stat: async () => ({ size: 500, mtimeMs: threshold + 5000 }),
        },
      );
      expect(res.satisfied).toBe(true);
      expect(res.evidence).toBeDefined();
      expect(res.evidence?.type).toBe('file');
      expect(res.evidence?.uri).toBe('file:///tmp/test.txt');
    });
  });

  describe('verifyFileContent', () => {
    it('returns satisfied=false when file cannot be read', async () => {
      const res = await verifyFileContent('c1', { path: '/tmp/missing.txt' }, {
        readFile: async () => null,
      });
      expect(res.satisfied).toBe(false);
    });

    it('verifies contains substring check', async () => {
      const env = { readFile: async () => 'Hello, world! Report generated successfully.' };
      const failRes = await verifyFileContent('c2', { path: '/tmp/r.txt', contains: 'Failed' }, env);
      expect(failRes.satisfied).toBe(false);

      const passRes = await verifyFileContent(
        'c3',
        { path: '/tmp/r.txt', contains: 'Report generated' },
        env,
      );
      expect(passRes.satisfied).toBe(true);
      expect(passRes.evidence?.description).toContain('Report generated');
    });

    it('verifies pattern regex check', async () => {
      const env = { readFile: async () => 'Status: SUCCESS, Total items: 42' };
      const failRes = await verifyFileContent(
        'c4',
        { path: '/tmp/r.txt', pattern: '^ERROR.*' },
        env,
      );
      expect(failRes.satisfied).toBe(false);

      const passRes = await verifyFileContent(
        'c5',
        { path: '/tmp/r.txt', pattern: 'Total items: \\d+' },
        env,
      );
      expect(passRes.satisfied).toBe(true);
    });
  });

  describe('verifyProcessExit', () => {
    it('verifies exit code matches expected (default 0)', () => {
      expect(verifyProcessExit('p1', { exit_code: 0 }).satisfied).toBe(true);
      expect(verifyProcessExit('p2', { exit_code: 1 }).satisfied).toBe(false);
      expect(verifyProcessExit('p3', { exit_code: 124, expected_code: 124 }).satisfied).toBe(true);
    });
  });

  describe('verifyAxState', () => {
    it('returns satisfied=false when queryAx is not configured', async () => {
      const res = await verifyAxState('ax1', { app: 'Calendar' }, {});
      expect(res.satisfied).toBe(false);
      expect(res.message).toContain('AX verifier query environment is not available');
    });

    it('verifies element existence and expected value', async () => {
      const env = {
        queryAx: async (q: { app?: string; role?: string; title?: string; value?: string }) => {
          if (q.title === 'Meeting with Tanaka') {
            return { found: true, value: '15:00 - 15:30' };
          }
          return { found: false };
        },
      };

      const passRes = await verifyAxState(
        'ax2',
        { app: 'Calendar', title: 'Meeting with Tanaka', value: '15:00 - 15:30' },
        env,
      );
      expect(passRes.satisfied).toBe(true);
      expect(passRes.evidence?.type).toBe('element_id');

      const failRes = await verifyAxState(
        'ax3',
        { app: 'Calendar', title: 'Meeting with Suzuki' },
        env,
      );
      expect(failRes.satisfied).toBe(false);
    });
  });

  describe('verifyAllCriteria', () => {
    it('verifies a suite of criteria and aggregates results', async () => {
      const criteria: VerificationCriteria[] = [
        {
          id: 'crit-1',
          type: 'process_exit',
          target: { exit_code: 0 },
          satisfied: false,
          evidence_ref: null,
        },
        {
          id: 'crit-2',
          type: 'file_exists',
          target: { path: '/tmp/output.csv', min_bytes: 10 },
          satisfied: false,
          evidence_ref: null,
        },
      ];

      const env = {
        stat: async () => ({ size: 100, mtimeMs: Date.now() }),
      };

      const { allSatisfied, results } = await verifyAllCriteria(criteria, env);
      expect(allSatisfied).toBe(true);
      expect(results).toHaveLength(2);
      expect(results[0]?.satisfied).toBe(true);
      expect(results[1]?.satisfied).toBe(true);
    });
  });
});

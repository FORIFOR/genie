"""The memory guard with harmless shell commands: no build, app, or model runs."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

GUARD = Path(__file__).resolve().parents[1] / 'memguard.py'


class MemoryGuardTests(unittest.TestCase):
    def guard(self, *options, command):
        with tempfile.TemporaryDirectory() as directory:
            log, report = Path(directory) / 'gate.log', Path(directory) / 'memory.json'
            result = subprocess.run(
                [sys.executable, str(GUARD), '--interval', '0.1', '--log', str(log), '--report', str(report),
                 *options, '--', 'bash', '-c', command],
                capture_output=True, text=True, timeout=60)
            return result, log.read_text() if log.exists() else '', \
                json.loads(report.read_text()) if report.exists() else None

    def test_finished_command_keeps_its_own_exit_status_and_stage_names(self):
        result, log, report = self.guard(
            '--start-free', '0', '--min-free', '0', '--max-swap-growth-mb', '1000000',
            command='echo "== first =="; sleep 0.4; echo "== second =="; sleep 0.4; exit 3')
        self.assertEqual(result.returncode, 3, result.stdout + result.stderr)
        self.assertIn('== second ==', log)
        self.assertFalse(report['guardStopped'])
        self.assertEqual(report['commandExitCode'], 3)
        self.assertIn('second', [stage['stage'] for stage in report['stages']])

    def test_breach_stops_the_whole_process_group_and_is_not_a_pass(self):
        with tempfile.TemporaryDirectory() as directory:
            survivor = Path(directory) / 'survivor'
            result, _, report = self.guard(
                '--start-free', '0', '--min-free', '101',
                command=f'(sleep 3; touch "{survivor}") & wait')
            self.assertEqual(result.returncode, 75, result.stdout + result.stderr)
            self.assertIn('MEMGUARD_STOPPED', result.stdout)
            self.assertTrue(report['guardStopped'])
            subprocess.run(['sleep', '3.5'], check=True)
            self.assertFalse(survivor.exists(), 'child of the stopped command kept running')

    def test_does_not_start_without_headroom(self):
        with tempfile.TemporaryDirectory() as directory:
            started = Path(directory) / 'started'
            result, _, report = self.guard('--start-free', '101', command=f'touch "{started}"')
            self.assertEqual(result.returncode, 75)
            self.assertIn('MEMGUARD_NOT_STARTED', result.stdout)
            self.assertFalse(started.exists())
            self.assertIsNone(report)


if __name__ == '__main__':
    unittest.main()

"""Offline launcher regression checks; no services, downloads or Mac permissions."""
from pathlib import Path
import os
import shutil
import subprocess
import tempfile
import unittest

LAUNCHER = Path(__file__).resolve().parents[1] / 'Start Genie.command'

class LauncherTests(unittest.TestCase):
    def run_launcher(self, major='22', status='0', source=True, args=()):
        with tempfile.TemporaryDirectory(prefix='genie source ') as tmp:
            root = Path(tmp)
            shutil.copyfile(LAUNCHER, root / LAUNCHER.name)
            (root / 'scripts').mkdir()
            if source:
                (root / 'scripts/start-local-preview.mjs').write_text('// fixture\n')
            (root / 'bin').mkdir()
            node = root / 'bin/node'
            node.write_text('#!/bin/bash\nif [[ "$1" == "-p" ]]; then printf "%s\\n" "$TEST_NODE_MAJOR"; exit 0; fi\nprintf "SUPERVISOR:%s\\n" "$@"\nexit "$TEST_NODE_STATUS"\n')
            node.chmod(0o755)
            env = {**os.environ, 'PATH': str(root / 'bin') + ':/usr/bin:/bin',
                   'TEST_NODE_MAJOR': major, 'TEST_NODE_STATUS': status}
            return subprocess.run(['/bin/bash', str(root / LAUNCHER.name), *args],
                                  input='', text=True, capture_output=True, env=env, timeout=5)

    def test_node_22_starts_from_path_with_spaces(self):
        result = self.run_launcher(args=('--model', 'a model'))
        self.assertEqual(result.returncode, 0)
        self.assertIn('SUPERVISOR:a model', result.stdout)

    def test_newer_node_is_supported(self):
        self.assertEqual(self.run_launcher(major='24').returncode, 0)

    def test_old_node_does_not_start_services(self):
        for major in ('18', '20', '21'):
            with self.subTest(major=major):
                result = self.run_launcher(major=major)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn('SUPERVISOR:', result.stdout)
                self.assertIn('Node 22', result.stdout)

    def test_unreadable_version_does_not_start_services(self):
        for major in ('', 'broken'):
            with self.subTest(major=major):
                result = self.run_launcher(major=major)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn('SUPERVISOR:', result.stdout)

    def test_missing_source_is_actionable(self):
        result = self.run_launcher(source=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('ソース一式', result.stdout)
        self.assertNotIn('SUPERVISOR:', result.stdout)

    def test_supervisor_failure_is_preserved_without_interactive_hang(self):
        self.assertEqual(self.run_launcher(status='7').returncode, 7)

if __name__ == '__main__':
    unittest.main()

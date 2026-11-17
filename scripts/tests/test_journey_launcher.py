import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


class JourneyLauncherTests(unittest.TestCase):
    def run_gate(self, fault='', executable='GenieMac'):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'scripts').mkdir()
            script = root / 'scripts/verify-journeys.sh'
            shutil.copy2(Path(__file__).resolve().parents[1] / script.name, script)
            shutil.copy2(Path(__file__).resolve().parents[1] / 'app-selftest-runner.sh',
                         root / 'scripts/app-selftest-runner.sh')
            app = root / 'Genie Fixture.app'
            binary = app / 'Contents/MacOS' / executable
            binary.parent.mkdir(parents=True)
            binary.touch(); binary.chmod(0o755)
            (app / 'Contents/Info.plist').write_text('<plist/>')
            commands = root / 'commands'
            tools = root / 'tools'; tools.mkdir()
            signer = tools / 'codesign'
            signer.write_text('#!/bin/sh\nexit 0\n'); signer.chmod(0o755)
            opener = tools / 'open'
            opener.write_text('''#!/usr/bin/env python3
import json, os, pathlib, sys
args = sys.argv[1:]
with open(os.environ['COMMANDS'], 'a') as log:
    log.write(json.dumps(args) + '\\n')
output = pathlib.Path(args[args.index('--stdout') + 1])
pathlib.Path(args[args.index('--stderr') + 1]).write_text('')
call = args[args.index('--selftest') + 1:]
if call[0] == 'journey':
    output.write_text('JOURNEY ' + call[1] + ' success=true\\n')
else:
    measurement = ('  MOTION T0-idle-to-listening frames=33 captured=33 fps=46\\n'
                   '  NOT_MEASURED T0-idle-to-listening: 46fps\\n'
                   if os.environ['FAULT'] == 'motion-unmeasured' else '')
    output.write_text(measurement + 'SURFACE_CONTINUITY_MOTION=PASS\\n')
    pathlib.Path(call[1], 'result.json').write_text('{}')
receipt = next(a.split('=', 1)[1] for a in args if a.startswith('ASTRA_SELFTEST_EXIT_RECEIPT='))
fault = os.environ['FAULT']
if fault != 'missing-receipt':
    pathlib.Path(receipt).write_text(json.dumps({'schema': 1, 'normalExit': True,
                                               'exitCode': 2 if fault == 'failed-receipt' else 0}))
sys.exit(7 if fault == 'launch-failed' else 0)
''')
            opener.chmod(0o755)
            result = subprocess.run(['/bin/bash', str(script)], env=dict(os.environ,
                ASTRA_RECORD_BIN=str(binary), ASTRA_DATA_ROOT=str(root / 'data with spaces'),
                PATH=str(tools) + os.pathsep + os.environ['PATH'], COMMANDS=str(commands), FAULT=fault),
                capture_output=True, text=True, timeout=10)
            calls = [json.loads(line) for line in commands.read_text().splitlines()] if commands.exists() else []
            return result, calls

    def test_journeys_and_motion_launch_the_signed_app_with_isolated_data(self):
        result, calls = self.run_gate()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('JOURNEYS_OK', result.stdout)
        self.assertEqual(len(calls), 4)
        for call in calls:
            self.assertEqual(call[:2], ['-n', '-W'])
            self.assertEqual(sum(a.startswith('ASTRA_DATA_ROOT=') for a in call), 1)
            self.assertTrue(next(a for a in call if a.startswith('ASTRA_DATA_ROOT=')).endswith('data with spaces'))
            self.assertTrue(call[call.index('--args') - 1].endswith('Genie Fixture.app'))
            self.assertEqual(call[call.index('--args') + 1:call.index('--selftest')],
                             ['-astra.transcription.cloudGoogleSTT', 'NO'])

    def test_success_text_cannot_hide_a_crash_or_failed_exit(self):
        for fault in ['missing-receipt', 'failed-receipt', 'launch-failed']:
            with self.subTest(fault=fault):
                result, _ = self.run_gate(fault)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn('JOURNEYS_OK', result.stdout)
                self.assertIn('did not complete normally', result.stderr)

    def test_continuity_success_keeps_unmeasured_fps_and_does_not_claim_60fps(self):
        result, _ = self.run_gate('motion-unmeasured')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('NOT_MEASURED T0-idle-to-listening: 46fps', result.stdout)
        self.assertIn('MOTION T0-idle-to-listening frames=33 captured=33 fps=46', result.stdout)
        summary = next(line for line in result.stdout.splitlines() if line.startswith('JOURNEYS_OK:'))
        self.assertIn('観測した窓・面の連続性', summary)
        self.assertIn('実効fps・未計測項目は上記', summary)
        self.assertNotIn('60fps', summary)

    def test_regular_developer_bundle_keeps_its_launchservices_identity(self):
        result, calls = self.run_gate(executable='Genie')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(len(calls), 4)
        for call in calls:
            self.assertTrue(call[call.index('--args') - 1].endswith('Genie Fixture.app'))

    def test_unknown_executable_is_not_launched_as_the_test_app(self):
        result, calls = self.run_gate(executable='OtherExecutable')
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertIn('AUTOMATION_MISSING', result.stderr)
        self.assertEqual(calls, [])


if __name__ == '__main__':
    unittest.main()

import os
from pathlib import Path
import subprocess
import tempfile
import unittest


class MacOSRecordingEnvironmentTests(unittest.TestCase):
    def run_launcher(self, forwarded, open_status=0):
        # Execute the production launcher, replacing only LaunchServices itself.
        source = (Path(__file__).resolve().parents[1] / 'verify-macos-recording.sh').read_text()
        launcher = '# LaunchServices does not inherit' + source.split(
            '# LaunchServices does not inherit', 1)[1].split('\nOUT=', 1)[0]
        with tempfile.TemporaryDirectory() as directory:
            args = Path(directory) / 'arguments'
            env = {k: v for k, v in os.environ.items() if k not in (
                'ASTRA_DATA_ROOT', 'ASTRA_SELFTEST_AGENT_EMAIL', 'ASTRA_SELFTEST_AGENT_TOKEN_PATH',
                'ASTRA_GATEWAY_URL')}
            env.update(forwarded, ARGUMENTS=str(args), OPEN_STATUS=str(open_status))
            result = subprocess.run(['/bin/bash', '-c', '''set -euo pipefail
APP='/fixture/Genie App.app'
open() {
  printf '%s\\0' "$@" > "$ARGUMENTS"
  while [[ $# -gt 0 ]]; do
    if [[ "$1" = --stdout ]]; then printf 'SELFTEST_OK fixture\\n' > "$2"; fi
    if [[ "$1" = --stderr ]]; then : > "$2"; fi
    shift
  done
  return "$OPEN_STATUS"
}
''' + launcher + '\nrun_app_selftest micrelease\n'], env=env,
                capture_output=True, text=True, timeout=10)
            actual = args.read_bytes().decode().split('\0')[:-1] if args.exists() else []
            return result, actual

    def test_empty_environment_runs_under_system_bash_nounset(self):
        result, actual = self.run_launcher({})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('SELFTEST_OK fixture', result.stdout)
        self.assertEqual(actual[:3], ['-n', '-W', '--stdout'])
        self.assertEqual(actual[-6:], ['/fixture/Genie App.app', '--args',
            '-astra.transcription.cloudGoogleSTT', 'NO', '--selftest', 'micrelease'])

    def test_forwarded_values_stay_single_arguments(self):
        forwarded = {'ASTRA_DATA_ROOT': '/fixture/data with spaces',
                     'ASTRA_SELFTEST_AGENT_EMAIL': 'fixture@example.invalid',
                     'ASTRA_SELFTEST_AGENT_TOKEN_PATH': '/fixture/token path',
                     'ASTRA_GATEWAY_URL': 'http://127.0.0.1:43180'}
        result, actual = self.run_launcher(forwarded)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(actual[2:10], [value for key, content in forwarded.items()
                                      for value in ('--env', key + '=' + content)])

    def test_network_selftests_use_the_selected_gateway(self):
        # Execute the actual network call sites with a recorder binary and
        # LaunchServices stub. Stop before UI/recording (no native app is run).
        source = (Path(__file__).resolve().parents[1] / 'verify-macos-recording.sh').read_text()
        source = source.split('# UI/UX テスト仕様', 1)[0]
        for selected, executable in [(gateway, name)
                for gateway in [None, 'http://127.0.0.1:43180/path with spaces']
                for name in ['Genie', 'GenieMac']]:
            with self.subTest(selected=selected, executable=executable), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                scripts = root / 'scripts'; scripts.mkdir()
                script = scripts / 'verify-macos-recording.sh'; script.write_text(source)
                (scripts / 'build-resource-env.sh').write_text('GENIE_SWIFT_BUILD_JOBS=1\n')
                (scripts / 'verify-local-translation.sh').write_text('exit 0\n')
                app = root / 'Genie.app/Contents'; (app / 'MacOS').mkdir(parents=True)
                (app / 'Info.plist').write_text('fixture')
                binary = app / 'MacOS' / executable
                binary.write_text('#!/bin/bash\nprintf "%s\\0" "$@" >> "$CALLS"\nprintf "\\n" >> "$CALLS"\necho "SELFTEST_OK fixture"\n')
                binary.chmod(0o755)
                tools = root / 'tools'; tools.mkdir()
                (tools / 'codesign').write_text('#!/bin/bash\nexit 0\n'); (tools / 'codesign').chmod(0o755)
                (tools / 'open').write_text('''#!/bin/bash
while [[ $# -gt 0 ]]; do
  if [[ "$1" == --stdout ]]; then echo 'SELFTEST_OK fixture' > "$2"; fi
  if [[ "$1" == --stderr ]]; then : > "$2"; fi
  printf '%s\\0' "$1" >> "$CALLS"
  shift
done
printf '\\n' >> "$CALLS"
'''); (tools / 'open').chmod(0o755)
                env = {k: v for k, v in os.environ.items() if k != 'ASTRA_GATEWAY_URL'}
                env.update(PATH=str(tools) + os.pathsep + env['PATH'],
                           ASTRA_RECORD_BIN=str(binary), CALLS=str(root / 'calls'))
                if selected is not None: env['ASTRA_GATEWAY_URL'] = selected
                result = subprocess.run(['/bin/bash', str(script)], env=env,
                                        capture_output=True, text=True, timeout=10)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                calls = [line.split('\0')[:-1] for line in (root / 'calls').read_text().splitlines()]
                for test in ['aiaction', 'recovery', 'voiceask', 'aistop', 'recoveryoffline', 'fulllifecycle']:
                    invocation = next(call for call in calls if '--selftest' in call and test in call)
                    self.assertEqual(invocation[invocation.index(test) + 1], selected or 'http://127.0.0.1:3000')

    def test_launch_failure_is_not_reported_as_a_pass(self):
        result, _ = self.run_launcher({}, open_status=7)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('FAIL: app selftest micrelease did not complete', result.stderr)

    def test_unknown_executable_does_not_enter_recording_or_launchservices(self):
        source = (Path(__file__).resolve().parents[1] / 'verify-macos-recording.sh').read_text()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            scripts = root / 'scripts'; scripts.mkdir()
            script = scripts / 'verify-macos-recording.sh'
            script.write_text(source)
            (scripts / 'build-resource-env.sh').write_text('GENIE_SWIFT_BUILD_JOBS=1\n')
            app = root / 'Genie.app/Contents'; (app / 'MacOS').mkdir(parents=True)
            (app / 'Info.plist').write_text('fixture')
            binary = app / 'MacOS/OtherExecutable'
            calls = root / 'calls'
            binary.write_text('#!/bin/bash\ntouch "$CALLS"\n')
            binary.chmod(0o755)
            result = subprocess.run(['/bin/bash', str(script)],
                                    env=dict(os.environ, ASTRA_RECORD_BIN=str(binary), CALLS=str(calls)),
                                    capture_output=True, text=True, timeout=5)
            self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
            self.assertIn('AUTOMATION_MISSING', result.stderr)
            self.assertFalse(calls.exists())


if __name__ == '__main__':
    unittest.main()

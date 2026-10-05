"""Production shell orchestration with fake commands: no build, app, or model runs."""
import os
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parents[1]


class VerificationResourceTests(unittest.TestCase):
    def environment(self, **extra):
        clean = {key: value for key, value in os.environ.items() if key not in (
            'ASTRA_VERIFY_LOCAL_MODEL', 'ASTRA_RECORD_BIN', 'GENIE_SWIFT_BUILD_JOBS',
            'CARGO_BUILD_JOBS', 'ASTRA_VERIFY_CODEX_TRANSLATION', 'ASTRA_VERIFY_CODEX_SHUTDOWN')}
        return dict(clean, **extra)

    def model_gate(self, opt_in=None, output='SELFTEST_OK translate: fixture', status=0):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            binary = root / 'Fake Genie'
            calls = root / 'calls'
            binary.write_text('#!/bin/bash\nprintf "%s\\n" "$*" > "$CALLS"\n'
                              'printf "%s\\n" "$MODEL_OUTPUT"\nexit "$MODEL_STATUS"\n')
            binary.chmod(0o755)
            env = self.environment(ASTRA_RECORD_BIN=str(binary), CALLS=str(calls),
                                   MODEL_OUTPUT=output, MODEL_STATUS=str(status))
            if opt_in is not None:
                env['ASTRA_VERIFY_LOCAL_MODEL'] = opt_in
            result = subprocess.run(['/bin/bash', str(SCRIPTS / 'verify-local-translation.sh')],
                                    env=env, capture_output=True, text=True, timeout=5)
            return result, calls.read_text() if calls.exists() else ''

    def test_default_does_not_launch_a_model_and_is_not_a_pass(self):
        result, calls = self.model_gate()
        self.assertEqual(result.returncode, 2)
        self.assertIn('NOT_RUN: local_translation_model', result.stdout)
        self.assertEqual(calls, '')

    def test_explicit_opt_in_uses_the_existing_semantic_selftest(self):
        result, calls = self.model_gate('1')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(calls.strip(), '--selftest translate')

    def test_recording_harness_leaves_real_translation_unrun_by_default(self):
        # Exercise the complete production recording script with inert fixture
        # commands, including its status propagation after the remaining gates.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); (root / 'scripts').mkdir()
            for name in ['verify-macos-recording.sh', 'verify-local-translation.sh', 'build-resource-env.sh']:
                shutil.copy2(SCRIPTS / name, root / 'scripts' / name)
            app = root / 'Fake Genie.app'; binary = app / 'Contents/MacOS/GenieMac'
            binary.parent.mkdir(parents=True)
            (app / 'Contents/Info.plist').write_text('<plist/>')
            calls = root / 'calls'
            binary.write_text('#!/bin/bash\nprintf "%s\\n" "$*" >> "$CALLS"\n'
                              'printf "SELFTEST_OK %s: fixture\\n" "$2"\n')
            binary.chmod(0o755)
            tools = root / 'tools'; tools.mkdir()
            (tools / 'codesign').write_text('#!/bin/sh\nexit 0\n'); (tools / 'codesign').chmod(0o755)
            opener = tools / 'open'
            opener.write_text('''#!/bin/bash
while [[ $# -gt 0 ]]; do
  case "$1" in
    --stdout) out="$2"; shift ;;
    --stderr) : > "$2"; shift ;;
    --selftest) name="$2"; break ;;
  esac
  shift
done
if [[ "$name" == e2e001 ]]; then
  printf 'SELFTEST_OK e2e001(offline): fixture\\n' > "$out"
else
  printf 'SELFTEST_OK %s: fixture\\n' "$name" > "$out"
fi
''')
            opener.chmod(0o755)
            result = subprocess.run(['/bin/bash', str(root / 'scripts/verify-macos-recording.sh')],
                                    env=self.environment(ASTRA_RECORD_BIN=str(binary), CALLS=str(calls),
                                        PATH=str(tools) + os.pathsep + os.environ['PATH'], ASTRA_E2E_SYNTHETIC='0'),
                                    capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
            self.assertIn('NOT_RUN: local_translation_model', result.stdout)
            self.assertIn('RECORDING_PARTIAL', result.stdout)
            self.assertNotIn('--selftest translate', calls.read_text())
            self.assertIn('--selftest connectorflow', calls.read_text())

    def test_skip_failure_crash_and_missing_result_cannot_count_as_success(self):
        for output, status, expected in [
            ('SELFTEST_SKIP translate: unavailable', 0, 2),
            ('SELFTEST_OK translate: fixture', 9, 1),
            ('SELFTEST_FAIL translate: meaning changed', 2, 1),
            ('SELFTEST_OK unrelated: fixture', 0, 1),
        ]:
            with self.subTest(output=output, status=status):
                result, _ = self.model_gate('1', output, status)
                self.assertEqual(result.returncode, expected)
        result, calls = self.model_gate('yes')
        self.assertEqual(result.returncode, 1)
        self.assertEqual(calls, '')

    def test_job_defaults_overrides_and_invalid_values(self):
        command = 'source "$1" || exit; printf "%s,%s" "$GENIE_SWIFT_BUILD_JOBS" "$CARGO_BUILD_JOBS"'
        for values, expected in [({}, '2,2'), ({'GENIE_SWIFT_BUILD_JOBS': '1', 'CARGO_BUILD_JOBS': '3'}, '1,3')]:
            result = subprocess.run(['/bin/bash', '-c', command, 'test', str(SCRIPTS / 'build-resource-env.sh')],
                                    env=self.environment(**values), capture_output=True, text=True, timeout=5)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, expected)
        for value in ['0', '-1', '2; echo unsafe', 'unlimited']:
            result = subprocess.run(['/bin/bash', '-c', command, 'test', str(SCRIPTS / 'build-resource-env.sh')],
                                    env=self.environment(GENIE_SWIFT_BUILD_JOBS=value), capture_output=True, text=True, timeout=5)
            self.assertNotEqual(result.returncode, 0)

    def full_gate(self, message='', status=0, jobs=None, swift_output='Executed 1 test, with 0 failures', swift_status=0,
                  desktop_output=' Tests  1 passed (1)', desktop_status=0):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'scripts').mkdir()
            source = (SCRIPTS / 'verify-all.sh').read_text()
            for script in set(re.findall(r'scripts/([a-z0-9-]+\.sh)', source)):
                target = root / 'scripts' / script
                target.write_text('#!/bin/bash\nexit 0\n')
            for name in ['verify-all.sh', 'verify-swift-tests.sh', 'verify-desktop-tests.sh', 'build-resource-env.sh']:
                shutil.copy2(SCRIPTS / name, root / 'scripts' / name)
            (root / 'scripts/verify-macos-recording.sh').write_text(
                '#!/bin/bash\nprintf "%s\\n" "$GATE_MESSAGE"\nexit "$GATE_STATUS"\n')
            tools = root / 'tools'; tools.mkdir()
            calls = root / 'calls'
            for tool in ['pnpm', 'swift', 'cargo', 'node', 'python3']:
                command = tools / tool
                command.write_text('#!/bin/sh\nprintf "%s|%s|cargo_jobs=%s\\n" "' + tool
                                   + '" "$*" "$CARGO_BUILD_JOBS" >> "$CALLS"\n'
                                   + ('if [ "$1" = test ]; then case "$*" in *--filter*) echo "Executed 1 test, with 0 failures"; exit 0;; esac; printf "%s\\n" "$SWIFT_OUTPUT"; exit "$SWIFT_STATUS"; fi\n'
                                      if tool == 'swift' else '')
                                   + ('if [ "$1" = --filter ] && [ "$2" = @genie/desktop ] && [ "$3" = test ]; then printf "%s\\n" "$DESKTOP_OUTPUT"; exit "$DESKTOP_STATUS"; fi\n'
                                      if tool == 'pnpm' else '')
                                   + 'echo "Executed 1 tests"\necho "test result: ok"\n')
                command.chmod(0o755)
            (tools / 'uname').write_text('#!/bin/sh\necho Darwin\n'); (tools / 'uname').chmod(0o755)
            for directory_name in ['core/genie-core', 'apps/desktop/src-tauri', 'apps/genie-macos/.build/debug']:
                (root / directory_name).mkdir(parents=True, exist_ok=True)
            binary = root / 'apps/genie-macos/.build/debug/GenieMac'
            binary.write_text('#!/bin/sh\necho "SELFTEST_OK fixture: fake native command"\n'); binary.chmod(0o755)
            env = self.environment(PATH=str(tools) + os.pathsep + os.environ['PATH'], CALLS=str(calls),
                                   GATE_MESSAGE=message, GATE_STATUS=str(status),
                                   SWIFT_OUTPUT=swift_output, SWIFT_STATUS=str(swift_status),
                                   DESKTOP_OUTPUT=desktop_output, DESKTOP_STATUS=str(desktop_status),
                                   ASTRA_VERIFY_CODEX_TRANSLATION="1", **(jobs or {}))
            result = subprocess.run(['/bin/bash', str(root / 'scripts/verify-all.sh')], cwd=root,
                                    env=env, capture_output=True, text=True, timeout=10)
            return result, calls.read_text()

    def test_full_gate_tracks_omissions_and_never_calls_them_green(self):
        for status in [0, 2]:
            result, _ = self.full_gate('NOT_RUN: local_translation_model (opt-in required)', status)
            self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
            self.assertIn('VERIFY_ALL_PARTIAL', result.stdout)
            self.assertIn('1 reported checks/scopes', result.stdout)
            self.assertNotIn('VERIFY_ALL_OK', result.stdout)

    def test_namespaced_skip_and_unmeasured_native_results_remain_partial(self):
        for marker in ['CS_SKIP gateway: not reachable', 'CABI_SKIP api: unreachable',
                       'SELFTEST_OK egress: sttNoFallback=NOT_MEASURED(all assets present)',
                       '  NOT_MEASURED motion: 49 fps sample']:
            with self.subTest(marker=marker):
                result, _ = self.full_gate(marker)
                self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
                self.assertIn('VERIFY_ALL_PARTIAL', result.stdout)
                self.assertNotIn('VERIFY_ALL_OK', result.stdout)

    def test_xctest_opt_in_skips_remain_partial_through_summary_wrapper(self):
        for count, noun in [(1, 'test'), (2, 'tests')]:
            summary = f'Executed 74 tests, with {count} {noun} skipped and 0 failures (0 unexpected)'
            result, _ = self.full_gate(swift_output="Test Case 'external opt-in' skipped (0.000 seconds).\n" + summary)
            self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
            self.assertIn('NOT_RUN: macOS_swift_unit ' + summary, result.stdout)
            self.assertIn("Test Case 'external opt-in' skipped", result.stdout)
            self.assertIn('1 reported checks/scopes', result.stdout)
            self.assertNotIn('VERIFY_ALL_OK', result.stdout)
        result, _ = self.full_gate(swift_output='Executed 74 tests, with 0 tests skipped and 0 failures')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('VERIFY_ALL_OK', result.stdout)

    def test_runner_skips_remain_partial_without_custom_markers(self):
        for summary in [' Tests  32 passed | 1 skipped (33)', '# skipped 2',
                        '# skip 1', 'ℹ skipped 3', 'OK (skipped=1)',
                        'test result: ok. 3 passed; 0 failed; 2 ignored; 0 measured;']:
            with self.subTest(summary=summary):
                result, _ = self.full_gate(summary)
                self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
                self.assertIn('VERIFY_ALL_PARTIAL', result.stdout)
                self.assertNotIn('VERIFY_ALL_OK', result.stdout)
        for summary in [' Tests  32 passed | 0 skipped (32)', '# skipped 0',
                        'ℹ skipped 0', 'OK (skipped=0)']:
            with self.subTest(summary=summary):
                result, _ = self.full_gate(summary)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertIn('VERIFY_ALL_OK', result.stdout)

    def test_xctest_failure_still_wins_over_skipped_tests(self):
        result, _ = self.full_gate(swift_output='Executed 74 tests, with 2 tests skipped and 1 failure', swift_status=1)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn('NOT_RUN: macOS_swift_unit ', result.stdout)
        self.assertIn('VERIFY_ALL_FAIL', result.stdout)
        self.assertNotIn('VERIFY_ALL_OK', result.stdout)

    def test_desktop_summary_preserves_all_skipped_empty_and_failed_runs(self):
        for output, process_status, expected in [
                (' Tests  2 skipped (2)', 0, 2),
                (' Tests  1 passed | 1 skipped (2)', 0, 2),
                ('No test files found, exiting with code 0', 0, 1),
                (' Tests  0 passed (0)', 0, 1),
                (' Tests  1 failed | 2 passed (3)', 1, 1)]:
            with self.subTest(output=output):
                result, _ = self.full_gate(desktop_output=output, desktop_status=process_status)
                self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
                self.assertIn(output, result.stdout)
                self.assertNotIn('VERIFY_ALL_OK', result.stdout)

    def test_failures_win_over_skip_and_exit_two_without_skip_is_a_failure(self):
        for message, status in [('NOT_RUN: local_translation_model\nSELFTEST_FAIL recording: crash', 2), ('', 2), ('NOT_RUN: fixture', 1)]:
            result, _ = self.full_gate(message, status)
            self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
            self.assertIn('VERIFY_ALL_FAIL', result.stdout)
            self.assertNotIn('VERIFY_ALL_OK', result.stdout)

    def test_full_gate_keeps_swift_unit_tests_and_propagates_job_limits(self):
        for jobs, swift_jobs, cargo_jobs in [({}, '2', '2'), ({'GENIE_SWIFT_BUILD_JOBS': '1', 'CARGO_BUILD_JOBS': '3'}, '1', '3')]:
            result, calls = self.full_gate(jobs=jobs)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn('VERIFY_ALL_OK', result.stdout)
            self.assertIn('swift|build --package-path ', calls)
            self.assertIn('--jobs ' + swift_jobs, calls)
            self.assertIn('swift|test --jobs ' + swift_jobs, calls)
            self.assertIn('cargo|test --quiet|cargo_jobs=' + cargo_jobs, calls)

    def test_packager_keeps_release_optimization_and_limits_parallelism(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); (root / 'scripts').mkdir()
            (root / 'apps/genie-macos').mkdir(parents=True)
            (root / 'package.json').write_text('{"version":"0.1.4"}')
            for name in ['package-macos-app.sh', 'build-resource-env.sh']:
                shutil.copy2(SCRIPTS / name, root / 'scripts' / name)
            tools = root / 'tools'; tools.mkdir()
            calls = root / 'calls'
            swift = tools / 'swift'
            swift.write_text('#!/bin/sh\nprintf "%s" "$*" > "$CALLS"\nexit 42\n'); swift.chmod(0o755)
            result = subprocess.run(['/bin/bash', str(root / 'scripts/package-macos-app.sh')],
                                    env=self.environment(PATH=str(tools) + os.pathsep + os.environ['PATH'], CALLS=str(calls)),
                                    capture_output=True, text=True, timeout=5)
            self.assertEqual(result.returncode, 42)
            self.assertEqual(calls.read_text(), 'build -c release --jobs 2')

    def normal_macos_build(self, overrides=None):
        """Run the real packaging script in an isolated tree with inert tools."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); (root / 'scripts').mkdir()
            for name in ['build-macos-app.sh', 'build-resource-env.sh']:
                shutil.copy2(SCRIPTS / name, root / 'scripts' / name)
            for name in ['core/genie-core', 'apps/genie-macos/Resources', 'plugins/builtin',
                         'apps/genie-macos/Vendor/Sparkle/Sparkle.xcframework/macos-arm64_x86_64/Sparkle.framework']:
                (root / name).mkdir(parents=True)
            (root / 'package.json').write_text('{"version":"0.1.4"}')
            (root / 'apps/genie-macos/Resources/AppIcon.icns').write_text('fixture icon')
            binary_dir = root / 'fake-swift-output'; binary_dir.mkdir()
            (binary_dir / 'GenieMac').write_text('inert fixture executable')
            calls = root / 'calls.jsonl'
            tools = root / 'tools'; tools.mkdir()
            for name in ['cargo', 'swift', 'node', 'codesign', 'security', 'install_name_tool']:
                fake = tools / name
                fake.write_text(f'#!{sys.executable}\n' + '''import json, os, sys
from pathlib import Path
tool=Path(sys.argv[0]).name
with open(os.environ['CALLS'], 'a') as output:
    output.write(json.dumps({'tool':tool,'argv':sys.argv[1:],
        'swiftJobs':os.environ.get('GENIE_SWIFT_BUILD_JOBS'),
        'cargoJobs':os.environ.get('CARGO_BUILD_JOBS'),
        'coreLib':os.environ.get('ASTRA_CORE_LIB_DIR'),
        'deploymentTarget':os.environ.get('MACOSX_DEPLOYMENT_TARGET')})+'\\n')
if tool=='node': print('0.1.4')
if tool=='swift' and '--show-bin-path' in sys.argv: print(os.environ['FAKE_BIN_DIR'])
''')
                fake.chmod(0o755)
            env = self.environment(PATH=str(tools) + os.pathsep + os.environ['PATH'],
                                   CALLS=str(calls), FAKE_BIN_DIR=str(binary_dir), GENIE_SIGN_IDENTITY='-')
            # Ambient preview/developer settings must not change this fixture's path.
            env.pop('ASTRA_CORE_LIB_DIR', None)
            env.pop('ASTRA_CONNECTIONS_CONFIG', None)
            env.update(overrides or {})
            result = subprocess.run(['/bin/bash', str(root / 'scripts/build-macos-app.sh')],
                                    cwd=root, env=env, capture_output=True, text=True, timeout=10)
            recorded = [json.loads(line) for line in calls.read_text().splitlines()] if calls.exists() else []
            return result, recorded

    def test_normal_macos_build_applies_shared_defaults_and_explicit_job_limits(self):
        for overrides, swift_jobs, cargo_jobs in [
                ({}, '2', '2'),
                ({'GENIE_SWIFT_BUILD_JOBS':'1', 'CARGO_BUILD_JOBS':'1'}, '1', '1'),
                ({'GENIE_SWIFT_BUILD_JOBS':'3', 'CARGO_BUILD_JOBS':'4'}, '3', '4')]:
            with self.subTest(overrides=overrides):
                result, calls = self.normal_macos_build(overrides)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                cargo = [call for call in calls if call['tool'] == 'cargo']
                self.assertEqual(len(cargo), 1)
                self.assertEqual(cargo[0]['argv'][:2], ['build', '--manifest-path'])
                self.assertEqual(cargo[0]['argv'][-1], '--lib')
                self.assertEqual(cargo[0]['cargoJobs'], cargo_jobs)
                self.assertEqual(cargo[0]['deploymentTarget'], '14.0')
                swift = [call for call in calls if call['tool'] == 'swift']
                self.assertEqual([call['argv'] for call in swift], [
                    ['build', '-c', 'release', '--jobs', swift_jobs],
                    ['build', '-c', 'release', '--jobs', swift_jobs, '--show-bin-path']])
                for call in swift:
                    self.assertEqual(call['swiftJobs'], swift_jobs)
                    self.assertEqual(call['cargoJobs'], cargo_jobs)
                    self.assertTrue(call['coreLib'].endswith('/core/genie-core/target/debug'))
                    self.assertEqual(call['deploymentTarget'], '14.0')

    def test_normal_macos_build_respects_prebuilt_core_without_running_cargo(self):
        result, calls = self.normal_macos_build({'ASTRA_CORE_LIB_DIR':'/fixture/prebuilt-core',
                                                'GENIE_SWIFT_BUILD_JOBS':'1'})
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse(any(call['tool'] == 'cargo' for call in calls))
        swift = [call for call in calls if call['tool'] == 'swift']
        self.assertEqual(len(swift), 2)
        for call in swift:
            self.assertEqual(call['coreLib'], '/fixture/prebuilt-core')
            self.assertEqual(call['argv'][3:5], ['--jobs', '1'])

    def test_normal_macos_build_rejects_invalid_job_limits_before_any_tool(self):
        for key, value in [('GENIE_SWIFT_BUILD_JOBS','0'), ('CARGO_BUILD_JOBS','unlimited')]:
            with self.subTest(key=key):
                result, calls = self.normal_macos_build({key:value})
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(key + ' must be a positive integer', result.stderr)
                self.assertEqual(calls, [])

    def compiler_entrypoint(self, script, overrides=None):
        # Run the real orchestration in a disposable checkout. Release stops at
        # its missing-binary guard; cargo-only checks stop at the fake compiler.
        # No package, signature, network request, or generated binding is made.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); (root / 'scripts').mkdir()
            for name in [script, 'build-resource-env.sh']:
                shutil.copy2(SCRIPTS / name, root / 'scripts' / name)
            (root / 'scripts/fetch-sparkle.sh').write_text('#!/bin/bash\nexit 0\n')
            for name in ['core/genie-core/target/debug', 'apps/genie-macos', 'fake-swift-output']:
                (root / name).mkdir(parents=True)
            (root / 'core/genie-core/target/debug/libgenie_core.dylib').write_text('inert fixture')
            calls = root / 'calls.jsonl'
            tools = root / 'tools'; tools.mkdir()
            driver = f'#!{sys.executable}\n' + '''import json, os, sys
from pathlib import Path
tool=Path(sys.argv[0]).name
args=sys.argv[1:]
with open(os.environ['CALLS'], 'a') as output:
    output.write(json.dumps({'tool':tool, 'argv':args,
        'swiftJobs':os.environ.get('GENIE_SWIFT_BUILD_JOBS'),
        'cargoJobs':os.environ.get('CARGO_BUILD_JOBS'),
        'coreLib':os.environ.get('ASTRA_CORE_LIB_DIR'),
        'deploymentTarget':os.environ.get('MACOSX_DEPLOYMENT_TARGET'),
        'rustFlags':os.environ.get('RUSTFLAGS')})+'\\n')
script=os.environ['FIXTURE_SCRIPT']
if tool=='node': print('0.1.4')
elif tool=='python3': print('fixture-source-snapshot')
elif tool=='lipo': Path(args[args.index('-output')+1]).write_text('inert archive')
elif tool=='swift':
    if '--show-bin-path' in args: print(os.environ['FAKE_BIN_DIR'])
elif tool=='cargo':
    if script=='verify-api-roundtrip.sh': print('test result: ok. fixture')
    elif script=='release-macos.sh': pass
    elif script=='gen-swift-bindings.sh' and args[0]=='build': pass
    else: sys.exit(42)
elif tool=='curl': pass
elif tool=='GenieMac': print('SELFTEST_OK api: fixture')
else:
    print('unexpected downstream tool: '+tool, file=sys.stderr)
    sys.exit(97)
'''
            for name in ['cargo', 'swift', 'node', 'python3', 'lipo', 'curl', 'dotnet',
                         'swiftc', 'clang', 'xcrun', 'codesign', 'security', 'otool']:
                fake = tools / name; fake.write_text(driver); fake.chmod(0o755)
            if script == 'verify-api-roundtrip.sh':
                fake = root / 'fake-swift-output/GenieMac'
                fake.write_text(driver); fake.chmod(0o755)
            env = self.environment(PATH=str(tools) + os.pathsep + os.environ['PATH'],
                                   CALLS=str(calls), FAKE_BIN_DIR=str(root / 'fake-swift-output'),
                                   FIXTURE_SCRIPT=script)
            for key in ['ASTRA_CORE_LIB_DIR', 'ASTRA_RELEASE_OUTPUT_DIR', 'ASTRA_CONNECTIONS_CONFIG']:
                env.pop(key, None)
            env.update(ASTRA_SIGN_IDENTITY='fixture identity', ASTRA_NOTARIZATION_BACKEND='notarytool',
                       ASTRA_GATEWAY_URL='http://fixture.invalid:3000', RUSTFLAGS='--cfg fixture')
            env.update(overrides or {})
            result = subprocess.run(['/bin/bash', str(root / 'scripts' / script)],
                                    cwd=root, env=env, capture_output=True, text=True, timeout=5)
            recorded = [json.loads(line) for line in calls.read_text().splitlines()] if calls.exists() else []
            return result, recorded

    def test_release_entrypoint_limits_both_architectures_without_changing_release_flags(self):
        for values, swift_jobs, cargo_jobs in [({}, '2', '2'),
                ({'GENIE_SWIFT_BUILD_JOBS':'1', 'CARGO_BUILD_JOBS':'3'}, '1', '3')]:
            with self.subTest(values=values):
                result, calls = self.compiler_entrypoint('release-macos.sh', values)
                self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
                self.assertIn('FAIL: 今回のuniversal実行体が無い:', result.stderr)
                cargo = [call for call in calls if call['tool'] == 'cargo']
                self.assertEqual([call['argv'] for call in cargo], [
                    ['build', '--release', '--quiet', '--target', arch]
                    for arch in ['aarch64-apple-darwin', 'x86_64-apple-darwin']])
                for call in cargo:
                    self.assertEqual(call['cargoJobs'], cargo_jobs)
                    self.assertEqual(call['deploymentTarget'], '14.0')
                    self.assertIn('--remap-path-prefix=', call['rustFlags'])
                    self.assertTrue(call['rustFlags'].endswith('--cfg fixture'))
                swift = [call for call in calls if call['tool'] == 'swift']
                base = ['build', '-c', 'release', '--arch', 'arm64', '--arch', 'x86_64', '--jobs', swift_jobs]
                self.assertEqual([call['argv'] for call in swift], [base, base + ['--show-bin-path']])
                for call in swift:
                    self.assertEqual(call['cargoJobs'], cargo_jobs)
                    self.assertTrue(call['coreLib'].endswith('/core/genie-core/target/universal-release'))
                self.assertFalse(any(call['tool'] in ['security', 'codesign', 'xcrun'] for call in calls))

    def test_api_roundtrip_entrypoint_limits_cargo_and_both_swift_build_queries(self):
        for values, swift_jobs, cargo_jobs in [({}, '2', '2'),
                ({'GENIE_SWIFT_BUILD_JOBS':'3', 'CARGO_BUILD_JOBS':'1'}, '3', '1')]:
            with self.subTest(values=values):
                result, calls = self.compiler_entrypoint('verify-api-roundtrip.sh', values)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                cargo = [call for call in calls if call['tool'] == 'cargo']
                self.assertEqual(len(cargo), 1)
                self.assertEqual(cargo[0]['argv'], ['test', '--quiet', 'dev_sign_in_then_me'])
                self.assertEqual(cargo[0]['cargoJobs'], cargo_jobs)
                swift = [call['argv'] for call in calls if call['tool'] == 'swift']
                self.assertEqual(swift, [['build', '--jobs', swift_jobs],
                                         ['build', '--jobs', swift_jobs, '--show-bin-path']])
                app = [call for call in calls if call['tool'] == 'GenieMac']
                self.assertEqual([call['argv'] for call in app],
                                 [['--selftest', 'api', 'http://fixture.invalid:3000']])

    def test_standalone_cargo_entrypoints_inherit_limits_including_binding_generator_run(self):
        for script in ['verify-swift-roundtrip.sh', 'verify-csharp-bridge.sh',
                       'gen-swift-bindings.sh', 'verify-c-abi.sh']:
            for values, cargo_jobs in [({}, '2'), ({'CARGO_BUILD_JOBS':'1'}, '1')]:
                with self.subTest(script=script, values=values):
                    result, calls = self.compiler_entrypoint(script, values)
                    self.assertEqual(result.returncode, 42, result.stdout + result.stderr)
                    cargo = [call for call in calls if call['tool'] == 'cargo']
                    self.assertEqual(len(cargo), 2 if script == 'gen-swift-bindings.sh' else 1)
                    self.assertEqual(cargo[0]['argv'], ['build', '--quiet'])
                    for call in cargo:
                        self.assertEqual(call['cargoJobs'], cargo_jobs)
                    if script == 'gen-swift-bindings.sh':
                        self.assertEqual(cargo[1]['argv'][:6],
                                         ['run', '--quiet', '--bin', 'uniffi-bindgen', '--', 'generate'])
                    self.assertFalse(any(call['tool'] in ['swiftc', 'clang', 'dotnet'] for call in calls))

    def test_all_new_entrypoints_reject_invalid_policy_before_tools_or_network(self):
        for script in ['release-macos.sh', 'verify-api-roundtrip.sh', 'verify-swift-roundtrip.sh',
                       'verify-csharp-bridge.sh', 'gen-swift-bindings.sh', 'verify-c-abi.sh']:
            for key in ['GENIE_SWIFT_BUILD_JOBS', 'CARGO_BUILD_JOBS']:
                with self.subTest(script=script, key=key):
                    result, calls = self.compiler_entrypoint(script, {key:'0'})
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn(key + ' must be a positive integer', result.stderr)
                    self.assertEqual(calls, [])


if __name__ == '__main__':
    unittest.main()

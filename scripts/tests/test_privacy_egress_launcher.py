"""Run the real egress gate with inert LaunchServices and a synthetic app bundle."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parents[1]


class GeminiEgressGuardTests(unittest.TestCase):
    guards = '''        if gemini.enabled, gemini.hasKey {
            let check = gemini.budget.canStart(at: Date())
            guard check.ok, let key = gemini.apiKey() else { return }
            provider = GeminiLiveProvider(apiKey: key, settings: gemini)
        }'''

    def state(self, body=None, arguments='geminiSettings: GeminiLiveSettings? = nil'):
        return ('class VoiceHUDState {\n    func beginConversation(' + arguments + ') {\n'
                + (self.guards if body is None else body) + '\n    }\n}\n')

    def check(self, state):
        script = (SCRIPTS / 'verify-privacy-egress.sh').read_text()
        checker = script.split('gemini_check=$(python3 - "$SRC" <<\'CHECK\'\n', 1)[1].split('\nCHECK\n)', 1)[0]
        with tempfile.TemporaryDirectory() as directory:
            src = Path(directory)
            (src / 'Audio').mkdir(); (src / 'VoiceHUD').mkdir()
            (src / 'Audio/GeminiLiveProvider.swift').write_text('// x-goog-api-key\n')
            (src / 'VoiceHUD/VoiceHUDState.swift').write_text(state)
            return subprocess.run(['python3', '-c', checker, str(src)],
                                  capture_output=True, text=True, timeout=5)

    def assert_rejected(self, state):
        result = self.check(state)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn('beginConversation:', result.stdout)

    def test_optional_settings_and_original_signature_keep_all_guards(self):
        for arguments in ['', 'geminiSettings: GeminiLiveSettings? = nil']:
            with self.subTest(arguments=arguments):
                result = self.check(self.state(arguments=arguments))
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_each_required_check_must_precede_provider_construction(self):
        for token in ['gemini.enabled', 'gemini.hasKey', 'canStart(at:']:
            with self.subTest(token=token):
                missing = self.guards.replace(token, 'disabledCheck')
                self.assert_rejected(self.state(missing))
                self.assert_rejected(self.state(missing + '\n        ' + token))

    def test_comment_or_literal_tokens_are_not_guard_evidence(self):
        missing = self.guards.replace('gemini.enabled', 'disabledCheck')
        for fake in ['// gemini.enabled', '/* gemini.enabled */',
                     '/* outer /* inner */ gemini.enabled */',
                     'let hint = "gemini.enabled"', 'let hint = #"gemini.enabled"#',
                     'let hint = """\ngemini.enabled\n"""',
                     r'let hint = "\(fake("gemini.enabled"))"']:
            with self.subTest(fake=fake):
                self.assert_rejected(self.state(fake + '\n' + missing))

    def test_missing_duplicate_or_other_function_checks_do_not_authorize(self):
        self.assert_rejected(self.state().replace('func beginConversation(', 'func other('))
        self.assert_rejected(self.state() + self.state(arguments=''))
        other = self.state().replace('func beginConversation(', 'func other(').replace(
            'provider = GeminiLiveProvider(apiKey: key, settings: gemini)', '')
        self.assert_rejected(other + self.state('provider = GeminiLiveProvider()'))

    def test_provider_outside_function_or_multiple_constructors_are_rejected(self):
        no_provider = self.guards.replace('provider = GeminiLiveProvider(apiKey: key, settings: gemini)', '')
        self.assert_rejected(self.state(no_provider) + '\nlet outside = GeminiLiveProvider()')
        self.assert_rejected(self.state(self.guards + '\nlet second = GeminiLiveProvider()'))

    def test_nested_comments_and_literal_braces_do_not_truncate_the_function(self):
        result = self.check(self.state('/* outer { /* nested } */ still comment } */\n'
                                       + 'let hint = "} GeminiLiveProvider( {"\n' + self.guards))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


class PrivacyEgressLauncherTests(unittest.TestCase):
    def run_gate(self, output='SELFTEST_OK egress: sttNoFallback=fixture file=nil', fault='', executable='Genie', isolated=True):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            app = root / 'Genie Fixture.app'; binary = app / 'Contents/MacOS' / executable
            binary.parent.mkdir(parents=True)
            (app / 'Contents/Info.plist').write_text('<plist/>')
            binary.write_text('#!/bin/sh\necho "FAIL: raw executable must never run"\nexit 88\n')
            binary.chmod(0o755)
            commands = root / 'commands'
            tools = root / 'tools'; tools.mkdir()
            signer = tools / 'codesign'
            signer.write_text('#!/bin/sh\n[ "$FAULT" != signature ]\n'); signer.chmod(0o755)
            opener = tools / 'open'
            opener.write_text('''#!/usr/bin/env python3
import json, os, pathlib, sys
args = sys.argv[1:]
with open(os.environ['COMMANDS'], 'a') as stream:
    stream.write(json.dumps({'args':args, 'autoUploadPresent':'ASTRA_DEV_AUTO_UPLOAD' in os.environ})+'\\n')
pathlib.Path(args[args.index('--stdout') + 1]).write_text(os.environ['OUTPUT']+'\\n')
pathlib.Path(args[args.index('--stderr') + 1]).write_text('')
receipt = next(a.split('=',1)[1] for a in args if a.startswith('ASTRA_SELFTEST_EXIT_RECEIPT='))
fault = os.environ['FAULT']
if fault != 'missing-receipt':
    payload = {'schema':1, 'normalExit': fault != 'abnormal-exit', 'exitCode':0}
    if fault == 'failed-receipt': payload['exitCode'] = 2
    if fault == 'false-code': payload['exitCode'] = False
    pathlib.Path(receipt).write_text(json.dumps(payload))
sys.exit(7 if fault == 'launch-failed' else 0)
''')
            opener.chmod(0o755)
            env = {k:v for k,v in os.environ.items() if not k.startswith('ASTRA_')}
            env.update(ASTRA_RECORD_BIN=str(binary), ASTRA_DEV_AUTO_UPLOAD='1',
                       ASTRA_GATEWAY_URL='http://127.0.0.1:43180',
                       ASTRA_SELFTEST_AGENT_EMAIL='fixture@example.invalid',
                       ASTRA_SELFTEST_AGENT_TOKEN_PATH='/tmp/synthetic token path',
                       TMPDIR=str(root), PATH=str(tools) + os.pathsep + os.environ['PATH'],
                       COMMANDS=str(commands), OUTPUT=output, FAULT=fault)
            if isolated: env['ASTRA_DATA_ROOT'] = str(root / 'isolated data')
            result = subprocess.run(['/bin/bash', str(SCRIPTS / 'verify-privacy-egress.sh')],
                                    env=env, capture_output=True, text=True, timeout=15)
            calls = [json.loads(x) for x in commands.read_text().splitlines()] if commands.exists() else []
            return result, calls

    def test_selected_signed_identity_is_used_with_receipt_and_isolated_configuration(self):
        for executable in ['Genie', 'GenieMac']:
            with self.subTest(executable=executable):
                result, calls = self.run_gate(executable=executable)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertEqual(len(calls), 1)
                call = calls[0]
                self.assertFalse(call['autoUploadPresent'])
                args = call['args']
                self.assertEqual(args[:2], ['-n', '-W'])
                self.assertTrue(next(a for a in args if a.startswith('ASTRA_DATA_ROOT=')).endswith('/isolated data'))
                self.assertIn('ASTRA_GATEWAY_URL=http://127.0.0.1:43180', args)
                self.assertIn('ASTRA_SELFTEST_AGENT_TOKEN_PATH=/tmp/synthetic token path', args)
                self.assertTrue(args[args.index('--args')-1].endswith('Genie Fixture.app'))
                self.assertEqual(args[-5:], ['--args', '-astra.transcription.cloudGoogleSTT', 'NO', '--selftest', 'egress'])
                self.assertIn('PRIVACY_EGRESS_GATE=PASS', result.stdout)

    def test_missing_data_root_uses_disposable_library(self):
        result, calls = self.run_gate(isolated=False)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue(next(a for a in calls[0]['args'] if a.startswith('ASTRA_DATA_ROOT=')).endswith('/data'))

    def test_success_marker_cannot_hide_failed_or_missing_normal_exit(self):
        for fault in ['missing-receipt', 'failed-receipt', 'abnormal-exit', 'false-code', 'launch-failed']:
            with self.subTest(fault=fault):
                result, _ = self.run_gate(fault=fault)
                self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
                self.assertNotIn('PRIVACY_EGRESS_GATE=PASS', result.stdout)

    def test_unmeasured_and_skipped_stt_remain_partial(self):
        for output in ['SELFTEST_OK egress: sttNoFallback=NOT_MEASURED',
                       'SELFTEST_OK egress: sttNoFallback=NOT_MEASURED(all locales have assets)',
                       'SELFTEST_SKIP egress: fixture unavailable']:
            with self.subTest(output=output):
                result, _ = self.run_gate(output=output)
                self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
                self.assertNotIn('PRIVACY_EGRESS_GATE=PASS', result.stdout)
                self.assertIn('NOT_RUN', result.stdout)

    def test_wrong_result_or_failure_is_not_green(self):
        for output in ['SELFTEST_OK other: fixture', 'SELFTEST_FAIL egress: server fallback',
                       'SELFTEST_OK egress: fixture\nSELFTEST_FAIL egress: unexpected fallback']:
            with self.subTest(output=output):
                result, _ = self.run_gate(output=output)
                self.assertEqual(result.returncode, 1, result.stdout + result.stderr)

    def test_invalid_bundle_or_signature_never_launches(self):
        result, calls = self.run_gate(executable='OtherExecutable')
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertEqual(calls, [])
        result, calls = self.run_gate(fault='signature')
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertEqual(calls, [])


if __name__ == '__main__':
    unittest.main()

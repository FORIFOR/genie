#!/usr/bin/env bash
# PRIVACY_EGRESS_GATE — 端末から出る道が、既定で閉じているか（docs/privacy-egress.md）。
#
# 「録音した音声・文字起こし・鍵はこの Mac の中だけで扱われ、あなたが確認して実行したものだけが
# 外に出ます」（ガイドの footer）を、機械で守る。2026-09-04 に 2 つの例外が見つかった:
#   - ja-JP のオンデバイス資産が無い Mac では Apple のサーバ認識に黙って落ちていた
#   - gateway が到達可能なだけで会議を作り、停止時に音声全体を送っていた
# ここは**静的**に道を数える。実行体での確認は `--selftest egress`（既定 OFF・資産無しロケールで throw）。
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/apps/genie-macos/Sources/GenieMac"
BIN="$ROOT/apps/genie-macos/.build/debug/GenieMac"
fail=0
row() { printf "  %-40s %s\n" "$1" "$2"; }
bad() { row "$1" "$2"; shift 2; printf "    %s\n" "$@" >&2; fail=1; }

# 本番の Swift（selftest を除く）
prod() { grep -rn "$@" "$SRC" --include='*.swift' | grep -v "App/SelfTest.swift" | grep -vE '^[^:]+:[0-9]+:\s*//'; }

echo "== PRIVACY_EGRESS_GATE =="

# 1. 録音の upload は、明示的な Google STT 同意の外では 0。
#    - 音声を送る関数は RecordingRuntime だけが呼ぶ
#    - cloudTranscriptionAllowed が true のときだけ会議作成・送信・回復を行う
up=$(prod "uploadMeetingAudio(" | grep -v "RecordingWorkspace/RecordingRuntime.swift\|RecordingWorkspace/GenieCoreBridge.swift" || true)
flag=$(awk '/static var devAutoUploadEnabled/,/^    }/' "$SRC/RecordingWorkspace/RecordingRuntime.swift")
flag_ok=1
grep -q "#if DEBUG" <<<"$flag" || flag_ok=0
grep -A2 "#else" <<<"$flag" | grep -q "return false" || flag_ok=0
cloud_gate=$(python3 - "$SRC" <<'CHECK'
import pathlib, sys, re
src=pathlib.Path(sys.argv[1])
r=(src/'RecordingWorkspace/RecordingRuntime.swift').read_text()
c=(src/'RecordingWorkspace/CloudMeetingTranscription.swift').read_text()
l=(src/'Audio/GoogleLiveTranscriber.swift').read_text()
m=(src/'Main/MainWindowView.swift').read_text()
checks = [
 'stored as? Bool ?? developmentUpload' in r,
 'cloudConsentValue(UserDefaults.standard.object(forKey: cloudTranscriptionDefaultsKey),' in r,
 'developmentUpload: devAutoUploadEnabled)' in r,
 'cloudRequestedForRecording = Self.cloudTranscriptionAllowed' in r,
 'if transcribe, cloudRequestedForRecording { startGoogleLive() }' in r,
 'guard RecordingRuntime.cloudTranscriptionAllowed else' in l,
 'try await ws.send(.data(Data(bytes)))' in l,
 'CloudMeetingTranscription.finalize' not in r[r.index('    func end('):r.index('    func retryCloudTranscription')],
 'guard RecordingRuntime.cloudTranscriptionAllowed else' in c,
 bool(re.search(r'try consent\(\)\s+try await socket.send\(\.data', c)),
 'if RecordingRuntime.devAutoUploadEnabled {' in m,
 'if RecordingRuntime.cloudTranscriptionAllowed {\n                        let recovered' not in m,
]
if all(checks): print('guarded')
CHECK
)
if [ -z "$up" ] && [ -n "$cloud_gate" ] && [ $flag_ok -eq 1 ]; then
  row "recording upload requires explicit cloud consent" "PASS"
else
  bad "recording upload requires explicit cloud consent" "FAIL" \
    "${up:+upload を RecordingRuntime の外で呼んでいる: $up}" \
    "$([ -n "$cloud_gate" ] || echo 'cloudTranscriptionAllowed の gate が無い')" \
    "$([ $flag_ok -eq 1 ] || echo 'devAutoUploadEnabled が #if DEBUG / #else false になっていない')"
fi

# 2. Apple STT のサーバ fallback は 0。
#    requiresOnDeviceRecognition は SpeechTranscriber.swift の中で、必ず `= true`。
#    認識 request を組むのも SpeechTranscriber.swift だけ。
stt="$SRC/Audio/SpeechTranscriber.swift"
req_elsewhere=$(prod "requiresOnDeviceRecognition\|SFSpeech.*RecognitionRequest(" | grep -v "Audio/SpeechTranscriber.swift" || true)
req_not_true=$(grep -n "requiresOnDeviceRecognition *=" "$stt" | grep -vE '^[0-9]+:\s*//' | grep -v "requiresOnDeviceRecognition = true" || true)
if [ -z "$req_elsewhere" ] && [ -z "$req_not_true" ] && grep -q "requiresOnDeviceRecognition = true" "$stt"; then
  row "silent Apple STT fallback" "0"
else
  bad "silent Apple STT fallback" "FAIL" \
    "${req_elsewhere:+SpeechTranscriber の外で認識 request を組んでいる: $req_elsewhere}" \
    "${req_not_true:+requiresOnDeviceRecognition が true 以外: $req_not_true}"
fi

# 3. マイクだけの録音では画面収録を求めず、「画面の音」の選択と同じ条件で求める。
pc="$SRC/Settings/PermissionCenter.swift"
workspace="$SRC/RecordingWorkspace/RecordingWorkspaceState.swift"
if grep -q 'case .meeting: return \[.microphone, .speechRecognition\]$' "$pc" \
  && grep -q 'case .meetingAudio: return \[.screenRecording\]$' "$pc" \
  && grep -q 'if screenAudio && requestPermissions { PermissionCenter.request(.meetingAudio) }' "$workspace" \
  && grep -q 'captureSystemAudio: screenAudio' "$workspace" \
  && grep -q 'object(forKey: "astra.recording.systemAudio") as? Bool ?? true' "$workspace"; then
  row "screen audio permission follows selection" "PASS"
else
  bad "screen audio permission follows selection" "FAIL" \
    "マイク権限と画面音の権限・保存された選択の接続を確認してください"
fi

# 4. connector（OAuth）は人が押した行からしか始まらない。
conn_check=$(python3 - "$SRC" <<'CHECK'
import pathlib, re, sys
src = pathlib.Path(sys.argv[1])
allowed = {'Main/ConnectionsPane.swift': 'connectProvider', 'Work/ReplyFlow.swift': 'connectActions'}
found = set()
for path in src.rglob('*.swift'):
    rel = str(path.relative_to(src))
    if path.name.startswith('SelfTest') or rel == 'Context/ConnectorState.swift': continue
    text = re.sub(r'//[^\n]*', '', path.read_text())
    # 会話の Gemini Live の再生は AVAudioEngine の節点をつなぐだけ（OAuth ではない）。
    # そのファイルでは `engine.connect(player` だけを除き、ほかの .connect( はここで数える。
    if rel == 'Audio/GeminiLiveProvider.swift':
        text = text.replace('engine.connect(player', 'engine_node_link(player')
    for call in re.findall(r'\.((?:connect|connectProvider|connectActions))\(', text):
        if allowed.get(rel) != call: raise SystemExit('unreviewed OAuth entry: ' + rel)
        found.add(rel)
pane = (src/'Main/ConnectionsPane.swift').read_text()
reply = (src/'Work/ReplyFlow.swift').read_text()
# The read flow remains inside the explicit provider button's action, after
# the purpose preview. Send consent remains behind its own confirmation.
checks = [
    found == set(allowed),
    re.search(r'Button\(provider == "google" \? "Googleで続ける" : "Microsoftで続ける"\)\s*\{\s*preview = nil\s*Task \{[^\n]*connections\.connectProvider\(provider\)', pane),
    # 接続を求める確認は止まらずに待つ（async）。同期で待つ版に戻すと、Dock の中身が戻らない。
    'if await Confirm.ask(ask) {\n                _ = connector(pluginId, connectorId)' in reply,
]
if not all(checks): raise SystemExit('OAuth must start from the purpose button or send confirmation')
print('provider purpose button + send confirmation')
CHECK
)
if [ "$?" -eq 0 ]; then
  row "connector egress requires user action" "PASS"
else
  bad "connector egress requires user action" "FAIL" "${conn_check:-OAuth の操作入口を確認できない}"
fi

# 5. 外へ届く実行は確認の面を通る（CONFIRMATION_GATE は verify-confirmation.sh が画素で持つ。
#    ここでは、送る/捨てる系の入口が Confirm.ask / Confirm.approve を経ることを静的に数える）。
#    返信の送信と backend の承認は、証拠（UserApproval）を返す Confirm.approve に移った。
#    ask だけを数えると、外へ届くいちばん強い入口が数から漏れる。
ask_n=$(prod "Confirm.ask(" | wc -l | tr -d ' ')
approve_n=$(prod "Confirm.approve(" | wc -l | tr -d ' ')
conf=$((ask_n + approve_n))
if [ "$conf" -ge 3 ] && [ "$approve_n" -ge 2 ]; then
  row "external action confirmation" "PASS (Confirm.ask ×$ask_n + Confirm.approve ×$approve_n; 面は CONFIRMATION_GATE)"
else
  bad "external action confirmation" "FAIL" "確認の入口が ask ×$ask_n / approve ×$approve_n しかない（返信の送信と backend の承認は Confirm.approve を通る）"
fi

# 6. ガイドが、オンデバイスと Google STT の選択を正しく説明する。
guide="$ROOT/docs/guide/build.py"
claim_ok=1
grep -q "Google STT" "$guide" || claim_ok=0
grep -q "相手の声のために" "$guide" && claim_ok=0     # 取り込んでいない音のために許可を説明しない
grep -q "transcription.onDeviceUnavailable" "$guide" || claim_ok=0   # 落とさない代わりに、出ない理由を教える
usage=$(grep -rn "NSSpeechRecognitionUsageDescription" "$ROOT/scripts/build-macos-app.sh" "$ROOT/apps/genie-macos/Info.plist" "$ROOT/apps/genie-macos/Sources" 2>/dev/null | head -1)
if [ $claim_ok -eq 1 ]; then
  row "transcription egress guide" "consistent"
else
  bad "transcription egress guide" "FAIL" "docs/guide/build.py: Google STT の説明が無い / 「相手の声のために」が残っている / 出ない理由の行が無い"
fi

# 7. いまの情報（天気・ニュース）は、一覧の相手にだけ出る。
#    - current-info/ の https URL は CURRENT_INFO_HOSTS の中だけ
#    - 生の fetch( は hosts.ts の infoFetch だけ
#    - 一覧はこのゲート・hosts.ts・docs/privacy-egress.md で同じ
info_check=$(python3 - "$ROOT" <<'CHECK'
import pathlib, re, sys
root = pathlib.Path(sys.argv[1])
d = root / 'workers/agent-host/src/current-info'
expected = ['api.open-meteo.com', 'geocoding-api.open-meteo.com', 'news.web.nhk', 'news.google.com']
hosts_ts = (d / 'hosts.ts').read_text()
listed = re.findall(r"^\s*'([a-z0-9.-]+)',", hosts_ts.split('CURRENT_INFO_HOSTS')[1].split('] as const')[0], re.M)
problems = []
if listed != expected:
    problems.append(f'CURRENT_INFO_HOSTS {listed} != {expected}')
for f in sorted(d.glob('*.ts')):
    text = f.read_text()
    for host in re.findall(r'https://([a-z0-9.-]+)', text):
        if host not in expected and host != 'open-meteo.com':
            problems.append(f'{f.name}: {host}')
    if f.name != 'hosts.ts' and re.search(r'(?<![A-Za-z])fetch\(', text.replace('this.#fetch(', '')):
        problems.append(f'{f.name}: raw fetch(')
doc = (root / 'docs/privacy-egress.md').read_text()
for host in expected:
    if host not in doc:
        problems.append(f'docs/privacy-egress.md: {host} missing')
print('; '.join(problems))
sys.exit(1 if problems else 0)
CHECK
)
if [ "$?" -eq 0 ]; then
  row "current-info egress allowlist" "PASS (4 hosts)"
else
  bad "current-info egress allowlist" "FAIL" "$info_check"
fi

# 8. 会話の Gemini Live は、本人がオンにし、キーと上限を置いたときだけ外へ出る。
#    - 接続先（generativelanguage.googleapis.com）を書いてよいのは GeminiLiveProtocol.swift だけ
#    - Gemini へつなぐ（GeminiLive.endpoint を使う）のは GeminiLiveProvider.swift だけ、キーは URL ではなくヘッダー
#    - GeminiLiveProvider を作るのは VoiceHUDState.beginConversation だけで、同意・キー・上限を確かめた後
gemini_check=$(python3 - "$SRC" <<'CHECK'
import pathlib, re, sys
src = pathlib.Path(sys.argv[1])
problems = []
for f in src.rglob('*.swift'):
    text = f.read_text()
    rel = str(f.relative_to(src))
    if 'generativelanguage.googleapis.com' in text and rel != 'Audio/GeminiLiveProtocol.swift':
        problems.append(f'{rel}: Gemini endpoint outside GeminiLiveProtocol.swift')
    # 接続の自己検査（geminismoke）だけは例外。本人の同意・キー・上限（settings.active）を確かめてからつなぐこと。
    if rel == 'App/SelfTestGeminiSmoke.swift':
        if 'GeminiLive.endpoint' in text and 'settings.active' not in text:
            problems.append(f'{rel}: connects to Gemini without checking settings.active')
    elif 'GeminiLive.endpoint' in text and rel != 'Audio/GeminiLiveProvider.swift':
        problems.append(f'{rel}: connects to Gemini outside GeminiLiveProvider.swift')
    if 'GeminiLiveProvider(' in text and rel not in ('VoiceHUD/VoiceHUDState.swift', 'Audio/GeminiLiveProvider.swift'):
        problems.append(f'{rel}: GeminiLiveProvider created outside beginConversation')
provider = (src / 'Audio/GeminiLiveProvider.swift').read_text()
if 'x-goog-api-key' not in provider or re.search(r'[?&]key=', provider):
    problems.append('GeminiLiveProvider.swift: API key must go in the x-goog-api-key header, not the URL')
state = (src / 'VoiceHUD/VoiceHUDState.swift').read_text()
begin = state.split('func beginConversation()')[1].split('\n    }\n')[0] if 'func beginConversation()' in state else ''
for needle in ['gemini.enabled', 'gemini.hasKey', 'canStart(at:']:
    if needle not in begin:
        problems.append(f'beginConversation: missing {needle} before creating GeminiLiveProvider')
print('; '.join(problems))
sys.exit(1 if problems else 0)
CHECK
)
if [ "$?" -eq 0 ]; then
  row "gemini live requires consent, key, limit" "PASS"
else
  bad "gemini live requires consent, key, limit" "FAIL" "$gemini_check"
fi

# 実行体（ある時だけ）: 既定 OFF と、資産の無いロケールで throw。
if [ -x "$BIN" ]; then
  out=$(env -u ASTRA_DEV_AUTO_UPLOAD "$BIN" --selftest egress 2>/dev/null | tail -1)
  case "$out" in
    SELFTEST_OK*)   row "runtime (--selftest egress)" "${out#SELFTEST_OK egress: }";;
    SELFTEST_SKIP*) row "runtime (--selftest egress)" "SKIP";;
    *) bad "runtime (--selftest egress)" "FAIL" "$out";;
  esac
fi

echo
if [ $fail -eq 0 ]; then echo "PRIVACY_EGRESS_GATE=PASS"; else echo "PRIVACY_EGRESS_GATE=FAIL" >&2; exit 1; fi

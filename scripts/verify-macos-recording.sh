#!/usr/bin/env bash
# macOS の録音 E2E（Swift → genie-core → 実ディスク断片）。ライブ mic ではなく合成音源で
# 断片が実際に書かれ、回復候補に出ることを確かめる（headless で再現可能）。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT/scripts/build-resource-env.sh"
# Match the explicitly selected isolated preview; never switch the global context.
GATEWAY="${ASTRA_GATEWAY_URL:-http://127.0.0.1:3000}"
if [[ -x "${ASTRA_RECORD_BIN:-}" ]]; then
  BIN="$ASTRA_RECORD_BIN"
elif [[ -x "$ROOT/dist/Genie.app/Contents/MacOS/GenieMac" ]]; then
  BIN="$ROOT/dist/Genie.app/Contents/MacOS/GenieMac"
elif [[ -x "$ROOT/apps/genie-macos/.build/Genie.app/Contents/MacOS/GenieMac" ]]; then
  BIN="$ROOT/apps/genie-macos/.build/Genie.app/Contents/MacOS/GenieMac"
else
  cd "$ROOT/apps/genie-macos"
  swift build --jobs "$GENIE_SWIFT_BUILD_JOBS" >/dev/null
  BIN="$(swift build --jobs "$GENIE_SWIFT_BUILD_JOBS" --show-bin-path)/GenieMac"
fi
# Both supported packaging routes must keep their own LaunchServices identity.
# build-macos-app.sh names the executable Genie; package/release use GenieMac.
case "$BIN" in
  */Contents/MacOS/Genie|*/Contents/MacOS/GenieMac) APP="${BIN%/Contents/MacOS/*}" ;;
  *) APP="$BIN" ;;
esac
if [[ "$APP" == "$BIN" || ! -f "$APP/Contents/Info.plist" ]]; then
  echo "AUTOMATION_MISSING: E2E-001 requires a signed app launched through LaunchServices" >&2
  exit 2
fi
codesign --verify --deep --strict "$APP" || exit 1
# LaunchServices does not inherit the shell environment. Keep fixtures out of the
# user's real library when the caller selects an isolated data root.
# Keep the command nonempty: Bash 3.2 treats an empty array as unset under -u.
APP_OPEN=(open -n -W)
for key in ASTRA_DATA_ROOT ASTRA_SELFTEST_AGENT_EMAIL ASTRA_SELFTEST_AGENT_TOKEN_PATH ASTRA_GATEWAY_URL; do
  if [[ -n "${!key:-}" ]]; then APP_OPEN+=(--env "$key=${!key}"); fi
done
# Tests that start recording/Speech must run as the app, not inherit the
# terminal's TCC responsibility (which lacks NSSpeechRecognitionUsageDescription).
# UI/capture fixtures exercise local recording. Do not inherit the user's cloud opt-in.
# Google finalization is verified separately by the explicit cloudstt integration test.
run_app_selftest() {
  local logs status=0
  logs="$(mktemp -d)"
  "${APP_OPEN[@]}" --stdout "$logs/stdout.txt" --stderr "$logs/stderr.txt" \
    "$APP" --args -astra.transcription.cloudGoogleSTT NO --selftest "$@" || status=$?
  cat "$logs/stdout.txt" 2>/dev/null || true
  cat "$logs/stderr.txt" >&2 2>/dev/null || true
  if [[ "$status" -ne 0 ]] || ! grep -qE '^SELFTEST_(OK|SKIP)' "$logs/stdout.txt" \
    || grep -qE '^SELFTEST_FAIL' "$logs/stdout.txt"; then
    echo "FAIL: app selftest $1 did not complete (logs: $logs)" >&2
    return 1
  fi
  rm -rf "$logs"
}

OUT="$("$BIN" --selftest record)"
echo "$OUT"
[[ "$OUT" == SELFTEST_OK* ]] || { echo "FAIL: macOS recording E2E" >&2; exit 1; }
OUT2="$("$BIN" --selftest lifecycle)"
echo "$OUT2"
[[ "$OUT2" == SELFTEST_OK* ]] || { echo "FAIL: macOS lifecycle E2E" >&2; exit 1; }
OUT3="$("$BIN" --selftest shortcut)"
echo "$OUT3"
# SKIP も通す。⌥Space は入力監視の許可を要り、その許可は**アプリとして起動した
# ときのバンドル**に紐づく。端末から実行した実行体には紐づかないので、ここで
# 確かめられないことがある（確かめられないことを「合格」とも「不合格」とも言わない）。
[[ "$OUT3" == SELFTEST_OK* || "$OUT3" == SELFTEST_SKIP* ]] || {
  echo "FAIL: macOS global shortcut register" >&2; exit 1; }
OUT4="$("$BIN" --selftest sysaudio)"
echo "$OUT4"
[[ "$OUT4" == SELFTEST_OK* ]] || { echo "FAIL: macOS system-audio config" >&2; exit 1; }
OUT5="$("$BIN" --selftest calendar)"
echo "$OUT5"
[[ "$OUT5" == SELFTEST_OK* ]] || { echo "FAIL: macOS calendar status" >&2; exit 1; }
OUT6="$("$BIN" --selftest screen)"
echo "$OUT6"
[[ "$OUT6" == SELFTEST_OK* ]] || { echo "FAIL: macOS screen-context config" >&2; exit 1; }
OUT7="$("$BIN" --selftest rag)"
echo "$OUT7"
[[ "$OUT7" == SELFTEST_OK* ]] || { echo "FAIL: macOS RAG rank_context via core" >&2; exit 1; }
OUT8="$("$BIN" --selftest keychain)"
echo "$OUT8"
[[ "$OUT8" == SELFTEST_OK* ]] || { echo "FAIL: macOS keychain round-trip" >&2; exit 1; }
OUT9="$("$BIN" --selftest files)"
echo "$OUT9"
[[ "$OUT9" == SELFTEST_OK* ]] || { echo "FAIL: macOS file context via core rank" >&2; exit 1; }
OUT10="$("$BIN" --selftest ax)"
echo "$OUT10"
[[ "$OUT10" == SELFTEST_OK* ]] || { echo "FAIL: macOS accessibility context" >&2; exit 1; }
OUT11="$("$BIN" --selftest speech)"
echo "$OUT11"
[[ "$OUT11" == SELFTEST_OK* ]] || { echo "FAIL: macOS on-device STT (Apple Speech)" >&2; exit 1; }
OUT12="$("$BIN" --selftest connector)"
echo "$OUT12"
[[ "$OUT12" == SELFTEST_OK* ]] || { echo "FAIL: macOS connector contract via core" >&2; exit 1; }

# ---- live 実機経路（この環境は mic/screen/ax/speech が許可済み）。CI 等で未許可なら SELFTEST_SKIP。----
echo "$("$BIN" --selftest permissions)"
OUTS="$("$BIN" --selftest shape)"; echo "$OUTS"
[[ "$OUTS" == SELFTEST_OK* ]] || { echo "FAIL: macOS workspace shape != shared fixture" >&2; exit 1; }
OUTH="$("$BIN" --selftest hudlifecycle)"; echo "$OUTH"
[[ "$OUTH" == SELFTEST_OK* ]] || { echo "FAIL: macOS HUD lifecycle" >&2; exit 1; }
OUTPB="$("$BIN" --selftest panel)"; echo "$OUTPB"
[[ "$OUTPB" == SELFTEST_OK* ]] || { echo "FAIL: macOS panel Spaces/fullscreen behavior" >&2; exit 1; }
OUTRN="$("$BIN" --selftest render)"; echo "$OUTRN"
[[ "$OUTRN" == SELFTEST_OK* ]] || { echo "FAIL: macOS SwiftUI offscreen render" >&2; exit 1; }
OUTP="$("$BIN" --selftest pause)"; echo "$OUTP"
[[ "$OUTP" == SELFTEST_OK* ]] || { echo "FAIL: macOS pause actually stops recording" >&2; exit 1; }
OUTTM="$("$BIN" --selftest timer)"; echo "$OUTTM"
[[ "$OUTTM" == SELFTEST_OK* ]] || { echo "FAIL: macOS elapsed timer" >&2; exit 1; }
OUTA="$("$BIN" --selftest aiaction "$GATEWAY")" || { echo "$OUTA"; exit 1; }; echo "$OUTA"
[[ "$OUTA" == SELFTEST_OK* || "$OUTA" == SELFTEST_SKIP* ]] || { echo "FAIL: macOS AI action via Agent" >&2; exit 1; }
# Real model loading is an explicit separate gate. Stub translation unit tests
# remain in normal Swift tests; they are not evidence of real-model quality.
translation_status=0
ASTRA_RECORD_BIN="$BIN" bash "$ROOT/scripts/verify-local-translation.sh" || translation_status=$?
[[ "$translation_status" -eq 0 || "$translation_status" -eq 2 ]] || exit 1
OUTR="$("$BIN" --selftest recovery "$GATEWAY")"; echo "$OUTR"
[[ "$OUTR" == SELFTEST_OK* || "$OUTR" == SELFTEST_SKIP* ]] || { echo "FAIL: macOS crash recovery" >&2; exit 1; }
OUTCF="$("$BIN" --selftest connectorflow)"; echo "$OUTCF"
[[ "$OUTCF" == SELFTEST_OK* ]] || { echo "FAIL: macOS OAuth loopback flow" >&2; exit 1; }
OUTCS="$("$BIN" --selftest connectorstate)"; echo "$OUTCS"
[[ "$OUTCS" == SELFTEST_OK* ]] || { echo "FAIL: macOS connector state" >&2; exit 1; }
OUTCE="$("$BIN" --selftest connectorexchange)"; echo "$OUTCE"
[[ "$OUTCE" == SELFTEST_OK* ]] || { echo "FAIL: macOS connector exchange (mock token endpoint)" >&2; exit 1; }
OUTVA="$("$BIN" --selftest voiceask "$GATEWAY")" || { echo "$OUTVA"; exit 1; }; echo "$OUTVA"
[[ "$OUTVA" == SELFTEST_OK* || "$OUTVA" == SELFTEST_SKIP* ]] || { echo "FAIL: macOS voice ask via Agent" >&2; exit 1; }
# Dock の止めるが backend の仕事を取り消し、後から届いた成功で ✓ にならない（2026-09-28）。
OUTAS="$("$BIN" --selftest aistop "$GATEWAY")" || { echo "$OUTAS"; exit 1; }; echo "$OUTAS"
[[ "$OUTAS" == SELFTEST_OK* || "$OUTAS" == SELFTEST_SKIP* ]] || { echo "FAIL: Dock stop cancels the backend task" >&2; exit 1; }
# やめたらマイクが閉じる（面を差し替えても、裏でマイクを回し続けない）。実マイクなので app として動かす。
OUTMR="$(run_app_selftest micrelease)" || { echo "$OUTMR"; exit 1; }; echo "$OUTMR" | grep -E '^SELFTEST_'
OUTRO="$("$BIN" --selftest recoveryoffline "$GATEWAY")" || { echo "$OUTRO"; exit 1; }; echo "$OUTRO"
[[ "$OUTRO" == SELFTEST_OK* || "$OUTRO" == SELFTEST_SKIP* ]] || { echo "FAIL: macOS offline recovery" >&2; exit 1; }
OUTFL="$(run_app_selftest fulllifecycle "$GATEWAY")" || { echo "$OUTFL"; exit 1; }; echo "$OUTFL"
[[ "$OUTFL" == SELFTEST_OK* || "$OUTFL" == SELFTEST_SKIP* ]] || { echo "FAIL: macOS full Voice HUD->Recording->save->HUD lifecycle" >&2; exit 1; }
# UI/UX テスト仕様 v1.0 の E2E-001（Product Reality Gate）。窓を実提示したまま一本で通し、
# HUD と Recording Workspace が同時に画面へ残らないことまで実測する。
# 実機gateで合成音源を暗黙に有効化しない。合成経路は明示した個別診断だけに使う。
if [[ "${ASTRA_E2E_SYNTHETIC:-0}" = 1 ]]; then
  echo "FAIL: recording gate requires real capture; ASTRA_E2E_SYNTHETIC=1 is diagnostic only" >&2
  exit 1
fi
e2e_status=0
E2E_LOG="$(mktemp -d)"
# 実キャプチャはバンドル自身をTCCの主体にする。openの終了0だけでは合格にしない。
"${APP_OPEN[@]}" --stdout "$E2E_LOG/stdout.txt" --stderr "$E2E_LOG/stderr.txt" \
  "$APP" --args -astra.transcription.cloudGoogleSTT NO --selftest e2e001 "$GATEWAY" || e2e_status=$?
OUTE2E="$(cat "$E2E_LOG/stdout.txt" 2>/dev/null)"
echo "$OUTE2E"
cat "$E2E_LOG/stderr.txt" >&2
[[ "$e2e_status" -eq 0 ]] || { echo "FAIL: E2E-001 exited $e2e_status" >&2; exit 1; }
grep -qE '^SELFTEST_OK e2e001\((online|offline)\):|^SELFTEST_SKIP e2e001:' <<<"$OUTE2E" || { echo "FAIL: E2E-001 Product Reality Gate (logs: $E2E_LOG)" >&2; exit 1; }
[[ "$OUTE2E" != *未検証* ]] || { echo "FAIL: E2E-001 contains an unverified required step (logs: $E2E_LOG)" >&2; exit 1; }
# Visual Gate: 8 主要画面を実アプリで撮り、geometry まで検査する（窓が在るだけでは PASS にしない）。
SHOTS_BASE="${ASTRA_SHOTS_DIR:-/tmp/astra-shots}"
for appearance in light dark; do
  ARG=""; [[ "$appearance" == dark ]] && ARG="dark"
  # `set -e` の下では、代入の中で落ちた時点でスクリプトごと静かに終わる。
  # どの面で落ちたのか分からなくなるので、状態を受け取ってから判定する。
  OUTSHOTS="$("$BIN" --selftest shots "$SHOTS_BASE-$appearance" $ARG || true)"
  echo "$appearance: $(echo "$OUTSHOTS" | tail -1)"
  [[ "$OUTSHOTS" == *SELFTEST_OK* || "$OUTSHOTS" == *SELFTEST_SKIP* ]] || { echo "FAIL: Visual Gate ($appearance)" >&2; exit 1; }
  # hover / focus / pressed が neutral と画素で違うことまで見る（実装の有無ではなく画面の差）。
  OUTST="$("$BIN" --selftest states "$SHOTS_BASE-states-$appearance" $ARG || true)"; echo "$OUTST" | grep '^STATE ' || true
  [[ "$OUTST" == *SELFTEST_OK* || "$OUTST" == *SELFTEST_SKIP* ]] || { echo "FAIL: interaction states ($appearance)" >&2; exit 1; }
  # committed の golden と画素で比べる（中身が決まっている面だけ。Home/Apps は時刻や接続で変わるので除外）。
  GDIR="$ROOT/docs/golden-screenshots"; [[ "$appearance" == dark ]] && GDIR="$GDIR/dark"
  OUTG="$("$BIN" --selftest golden "$GDIR" "$SHOTS_BASE-$appearance" || true)"; echo "$OUTG" | tail -1
  [[ "$OUTG" == *SELFTEST_OK* ]] || { echo "$OUTG" >&2; echo "FAIL: golden diff ($appearance)" >&2; exit 1; }
done

# 6 状態の**実寸**を pt で見る。画素の何 % では「30pt ずれた」も「影が濃い」も
# 同じ数字になり、どちらを先に直すか決まらない。2pt を超えたら落とす。
OUTGEO="$("$BIN" --selftest geometry "$ROOT/docs/golden-screenshots/geometry" || true)"
echo "$OUTGEO" | grep '^GEOMETRY ' || true; echo "$OUTGEO" | tail -1
[[ "$OUTGEO" == *SELFTEST_OK* || "$OUTGEO" == *SELFTEST_SKIP* ]] || {
  echo "FAIL: UI geometry (2pt)" >&2; exit 1; }

# 面は宣言した寸法（tokens.json）より大きくならない。screen_occupation は採点者に
# 訊かず、6 状態の窓の実寸を token の上限と突き合わせる。geometry の基準は
# --record で書き直せるが、この上限は token を変えない限り動かない。
OUTOCC="$("$BIN" --selftest occupation || true)"
echo "$OUTOCC" | grep '^OCCUPATION ' || true; echo "$OUTOCC" | tail -1
[[ "$OUTOCC" == *SELFTEST_OK* || "$OUTOCC" == *SELFTEST_SKIP* ]] || {
  echo "FAIL: screen occupation (token ceiling)" >&2; exit 1; }

# 面がどれだけ空いているかを測り、基準より悪くなったら落とす（歯止め）。
# 「良い UI」を目で言い合っても決まらないので数字にする。light だけで足りる。
density_status=0
OUTD="$("$BIN" --selftest density "$SHOTS_BASE-light" "$ROOT/docs/evidence/density-baseline.json")" || density_status=$?
echo "$OUTD" | tail -1
[[ "$density_status" -eq 0 && "$OUTD" == *SELFTEST_OK* ]] || { echo "$OUTD" >&2; echo "FAIL: density regression" >&2; exit 1; }

# §27 Plugin。同梱 manifest を読み、宣言だけでは呼べないことまで見る。
OUTP="$("$BIN" --selftest plugins "$ROOT/plugins/builtin")"; echo "$OUTP" | tail -1
[[ "$OUTP" == SELFTEST_OK* || "$OUTP" == SELFTEST_SKIP* ]] || { echo "FAIL: plugin runtime" >&2; exit 1; }

# Session UX の面。録音開始 → processing → ready を **実遷移で**撮る。
SESS_DIR="${ASTRA_SESSION_DIR:-/tmp/astra-session}"
for appearance in light dark; do
  ARG=""; [[ "$appearance" == dark ]] && ARG="dark"
  OUTS="$("$BIN" --selftest sessionshots "$SESS_DIR-$appearance" $ARG)"; echo "$appearance: $(echo "$OUTS" | tail -1)"
  [[ "$OUTS" == *SELFTEST_OK* ]] || { echo "$OUTS" >&2; echo "FAIL: Session UX ($appearance)" >&2; exit 1; }
done

# Task Dock の 8 状態。fixture ではなく **GenieStateStore の実遷移**で撮り、
# 各状態の実寸・top anchor 固定・窓が増えていないことまで見る。
DOCK_DIR="${ASTRA_DOCK_DIR:-/tmp/astra-dock}"
for appearance in light dark; do
  ARG=""; [[ "$appearance" == dark ]] && ARG="dark"
  dock_status=0
  OUTD="$(run_app_selftest dock8 "$DOCK_DIR-$appearance" $ARG)" || dock_status=$?
  echo "$appearance: $(echo "$OUTD" | tail -1)"
  [[ "$dock_status" -eq 0 && "$OUTD" == *SELFTEST_OK* ]] || { echo "$OUTD" >&2; echo "FAIL: Task Dock 8 states ($appearance)" >&2; exit 1; }
done

live_fail=0
for t in screenshot waveform livemic livemeeting livescreen sttrecognize sttstream guishot axtree a11ynames calendarask egress navtitle recoveryui focus upgrade breakpoints dictation state presence perf storage meetingiq vad browser dockanim invocation invocationaudio entry update secret recordbutton session uiscale acceptance sessionsync home-meeting-focus; do
  # `set -e` の下で $(…) が非 0 で返ると echo の前に落ち、どの検査が何と言って落ちたかが
  # ログに残らない（"^ FAILED" だけ）。出力を必ず残してから判定する。
  live_status=0
  OUT="$(run_app_selftest "$t")" || live_status=$?
  echo "$OUT"
  # Diagnostics may precede the result. Require this test's result on its own
  # line, and preserve the process exit status instead of matching the prefix.
  if [[ "$live_status" -ne 0 ]] ||
     ! grep -Eq "^SELFTEST_(OK|SKIP) ${t}:" <<<"$OUT" ||
     grep -q '^SELFTEST_FAIL' <<<"$OUT"; then
    echo "FAIL: macOS live $t" >&2; live_fail=1
  fi
done

[[ "$live_fail" -eq 0 ]] || exit 1
if [[ "$translation_status" -eq 2 ]]; then
  echo "RECORDING_PARTIAL: other recording checks finished; real-model translation fixture not run"
  exit 2
fi

#!/usr/bin/env bash
# Genie の「この環境で検証できる全て」を 1 コマンドで通す最終アクセプタンス。
# 実行時前提が要るもの（署名 .app への TCC・Windows 実機・実 OAuth 提供者）は各スクリプトが
# SELFTEST_SKIP / SKIP を未実施として集計する。未実施ありは PARTIAL/exit2、失敗は exit1。
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT/scripts/build-resource-env.sh" || exit 1
cd "$ROOT"
fail=0
REPORT_DIR="$(mktemp -d)" || exit 1
NOT_RUN_REPORT="$REPORT_DIR/not-run.txt"
: > "$NOT_RUN_REPORT" || exit 1
trap 'rm -rf "$REPORT_DIR"' EXIT
trap 'echo "VERIFY_ALL_NOT_RUN: interrupted; unfinished gates are not validated"; exit 130' INT
trap 'echo "VERIFY_ALL_NOT_RUN: terminated; unfinished gates are not validated"; exit 143' TERM
run() {
  local label="$1" status log="$REPORT_DIR/gate.log" markers="$REPORT_DIR/markers.txt"
  local -a command_status
  shift
  echo; echo "== $label =="
  "$@" 2>&1 | tee "$log"
  command_status=("${PIPESTATUS[@]}")
  status=${command_status[0]}
  if [[ "${command_status[1]}" -ne 0 ]]; then
    echo "  ^ FAILED (could not record gate output)"; fail=1
  fi
  # C/C# gates use CABI_SKIP / CS_SKIP. Unmeasured native checks may appear
  # as key=NOT_MEASURED(reason); neither spelling is a completed measurement.
  grep -E '(^|[[:space:]=])(([A-Z][A-Z0-9]*_)?SKIP|NOT_RUN|NOT_MEASURED|AUTOMATION_MISSING)([[:space:]:=(]|$)' "$log" > "$markers" || true
  # Test runners also report omitted cases in summaries without our uppercase
  # markers. A zero exit status with skipped cases is not a complete gate.
  grep -E '(^|[[:space:]|])[1-9][0-9]* skipped([[:space:])]|$)|^(#|ℹ)[[:space:]]+skip(ped)?[[:space:]]+[1-9][0-9]*([[:space:]]|$)|^OK \(skipped=[1-9][0-9]*\)|test result:.* [1-9][0-9]* ignored;' "$log" >> "$markers" || true
  if [[ -s "$markers" ]]; then
    while IFS= read -r marker; do printf '%s: %s\n' "$label" "$marker" >> "$NOT_RUN_REPORT"; done < "$markers"
  fi
  if grep -Eq '^(SELFTEST_FAIL|FAIL:)' "$log" ||
     { [[ "$status" -ne 0 ]] && { [[ "$status" -ne 2 ]] || [[ ! -s "$markers" ]]; }; }; then
    echo "  ^ FAILED (exit $status)"; fail=1
  fi
}

# Workspace packages export dist/. Tests must resolve this checkout's modules,
# including renamed design tokens, rather than a previous build's output.
if ! pnpm build; then
  echo "VERIFY_ALL_FAIL: current workspace packages could not be built"
  exit 1
fi

# Several gates invoke .build/debug/GenieMac directly. Build before the first
# consumer: a previous checkout's binary can otherwise reject current fixtures
# (or pass despite a source regression). Stop if the candidate cannot be built.
if [[ "$(uname -s)" == Darwin ]]; then
  echo "== current macOS debug candidate =="
  if ! swift build --package-path "$ROOT/apps/genie-macos" --jobs "$GENIE_SWIFT_BUILD_JOBS"; then
    echo "VERIFY_ALL_FAIL: current macOS candidate could not be built"
    exit 1
  fi
  # Recording automation requires a signed .app launched through LaunchServices.
  # Unless a caller explicitly selects a candidate, package this source instead
  # of silently picking an older distribution from dist/.
  if [[ -z "${ASTRA_RECORD_BIN:-}" ]]; then
    if ! bash "$ROOT/scripts/package-macos-app.sh"; then
      echo "VERIFY_ALL_FAIL: current signed macOS candidate could not be packaged"
      exit 1
    fi
    export ASTRA_RECORD_BIN="$ROOT/apps/genie-macos/.build/Genie.app/Contents/MacOS/GenieMac"
  fi
fi

# `cmd | grep ...` は grep の終了状態になるので、**テストが落ちても緑**になっていた。
# 実際に 1 件落ちたまま VERIFY_ALL_OK が出た。要約だけ見せつつ、状態は元のコマンドのものを返す。
# 落ちたときは要約だけでは追えない。**どのテストが落ちたか**を必ず残す。
run "genie-core tests"            bash -c "cd core/genie-core && out=\$(cargo test --quiet 2>&1); st=\$?; echo \"\$out\" | grep 'test result'; [ \$st -eq 0 ] || sed -n '/^failures:/,\$p' <<<\"\$out\" | head -40; exit \$st"
run "Tauri Rust regression"       bash scripts/verify-tauri-tests.sh
run "Tauri desktop JS regression" bash scripts/verify-desktop-tests.sh
run "TCC usage descriptions"     bash scripts/verify-usage-descriptions.sh
run "release consistency"        bash scripts/verify-release-consistency.sh
run "release aggregation regression" python3 -m unittest discover -s scripts/tests -p 'test_*.py'
run "managed preview lifecycle" node --test scripts/tests/managed-local-preview.test.mjs
run "transaction regression" bash scripts/verify-transactions.sh
run "computer vision contracts" node --test workers/agent-host/test/computer-vision.node.mjs workers/agent-host/test/computer-vision-integration.node.mjs workers/agent-host/test/background-vision.node.mjs workers/agent-host/test/computer-scroll-device.node.mjs workers/agent-host/test/cloud-budget.node.mjs scripts/tests/computer-use.test.mjs
if [[ "$(uname -s)" == Darwin ]]; then
  run "background text policy" bash scripts/test-background-text-edit.sh
  run "background scroll policy" bash scripts/test-background-scroll.sh
  run "background web link policy" bash scripts/test-background-web-policy.sh
fi
run "UI taste"                   bash scripts/verify-ui-taste.sh
run "permission JIT"             bash scripts/verify-permission-jit.sh
# 端末から出る道（Apple STT サーバ・録音の自動 upload・使っていない画面収録）が既定で閉じているか。
run "privacy egress"             bash scripts/verify-privacy-egress.sh
run "no contradiction"           bash scripts/verify-no-contradiction.sh
run "confirmation surface"       bash scripts/verify-confirmation.sh
# 声・会話・自動の経路から backend の承認を通せないこと（承認は確認カードで押された 1 回だけ）。
run "approval boundary"          bash scripts/verify-approval-boundary.sh
run "approval boundary selfcheck" bash scripts/verify-approval-boundary.sh --selfcheck
# 承認カードに**本物のキー**（OS のイベントの列）で答えられるか。待つ間に run loop を空回しすると届かない。
# 以前は固定の 0.8 秒待ちの後に送っていたので、起動直後は Dock が key になる前に送って 8 回に 1 回落ちた。
# いまはカード・「実行する」・key の窓が揃うのを確かめてから送り、揃わなければ NOT_READY と理由を出す
# （2026-09-26 に build 直後から 25 回続けて実行し 25 回通過）。落ちたら再実行で通さず、理由を読む。
run "approval boundary (real key)" bash scripts/verify-approval-boundary.sh --runtime
run "screen terms (one word each)" bash scripts/lint-terms.sh
# 操作ガイドの語は、アプリが今表示している語（UserFacingFacts）からしか来ない。写し違いは落ちる。
run "guide facts (app words only)" bash scripts/verify-guide-facts.sh
run "guide facts selfcheck"        bash scripts/verify-guide-facts.sh --selfcheck
run "liquid orb assets fresh"    node scripts/gen-liquid-orb.mjs --check
run "design tokens fresh"         node scripts/gen-design-tokens.mjs --check
run "type scale (no literals)"    node scripts/lint-type-literals.mjs
run "button hit area"             node scripts/lint-button-hit-area.mjs
run "swift bindings fresh"        bash scripts/gen-swift-bindings.sh --check
run "workspace fixture fresh"     node scripts/gen-workspace-fixture.mjs --check
run "conventions"                 node scripts/check-conventions.mjs
run "C ABI contract (3-way)"      node scripts/check-cabi-csharp.mjs
run "native path Tauri-free"      node scripts/check-native-tauri-free.mjs
run "WinUI XAML well-formed"      bash scripts/check-xaml-wellformed.sh
run "C# bridge -> core + gateway" bash scripts/verify-csharp-bridge.sh
run "Windows C# logic type-check" bash scripts/verify-csharp-logic.sh
run "C ABI round-trip (C)"        bash scripts/verify-c-abi.sh
run "macOS recording + live E2E"  bash scripts/verify-macos-recording.sh
run "liquid orb native lifecycle" "$ROOT/apps/genie-macos/.build/debug/GenieMac" --selftest liquid-orb /tmp/genie-liquid-orb-verify
run "initial profile native UI"  "$ROOT/apps/genie-macos/.build/debug/GenieMac" --selftest initialprofile /tmp/astra-initial-profile-verify
# 録音セッションの通し。**プロセスを跨いで** kill → 復元まで確かめる。
# CI が緑でもここが通らなければ未達、という位置づけのゲート。
run "recording experience E2E"    bash scripts/verify-recording-experience.sh
# 3 本の Journey を時間軸で通す（窓・鍵・面・遷移・出所 id の連続。層 A）。
run "journeys JA/JB/JC"           bash scripts/verify-journeys.sh
run "macOS swift unit tests"      bash scripts/verify-swift-tests.sh
if [[ "$(uname -s)" == Darwin ]]; then
  run "AppKit termination dispatch" bash scripts/test-app-termination.sh
  run "Keychain confirmation quit" bash scripts/test-keychain-recovery-quit.sh
fi

echo
not_run_count="$(sort -u "$NOT_RUN_REPORT" | wc -l | tr -d ' ')"
if [[ "$not_run_count" -gt 0 ]]; then
  echo "VERIFY_ALL_NOT_RUN: $not_run_count reported checks/scopes (not passes)"
  sort -u "$NOT_RUN_REPORT"
fi
if [[ "$fail" -ne 0 ]]; then echo "VERIFY_ALL_FAIL"; exit 1; fi
if [[ "$not_run_count" -gt 0 ]]; then
  echo "VERIFY_ALL_PARTIAL: no reported failures; $not_run_count checks/scopes not run"
  exit 2
fi
echo "VERIFY_ALL_OK: 全ゲート実施・未実施報告なし"

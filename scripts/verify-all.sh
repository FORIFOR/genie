#!/usr/bin/env bash
# Genie の「この環境で検証できる全て」を 1 コマンドで通す最終アクセプタンス。
# 実行時前提が要るもの（署名 .app への TCC・Windows 実機・実 OAuth 提供者）は各スクリプトが
# SELFTEST_SKIP / SKIP で正直に飛ばす。ここが緑なら「実装＋この環境で検証可能な範囲」は健全。
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
fail=0
run() { echo; echo "== $1 =="; shift; if "$@"; then :; else echo "  ^ FAILED"; fail=1; fi; }

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
  if ! swift build --package-path "$ROOT/apps/genie-macos"; then
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
run "genie-core tests"            bash -c "cd core/genie-core && out=\$(cargo test --quiet 2>&1); st=\$?; echo \"\$out\" | grep 'test result' | head -1; [ \$st -eq 0 ] || sed -n '/^failures:/,\$p' <<<\"\$out\" | head -40; exit \$st"
run "Tauri Rust regression"       bash -c "cd apps/desktop/src-tauri && out=\$(cargo test --quiet 2>&1); st=\$?; echo \"\$out\" | grep 'test result' | head -1; [ \$st -eq 0 ] || sed -n '/^failures:/,\$p' <<<\"\$out\" | head -40; exit \$st"
run "Tauri desktop JS regression" bash -c "out=\$(pnpm --filter @genie/desktop test 2>&1); st=\$?; echo \"\$out\" | grep -E 'Tests +[0-9]+ passed' | tail -1; [ \$st -eq 0 ] || { echo '--- 落ちたときの全文（末尾40行）---'; tail -40 <<<\"\$out\"; }; exit \$st"
run "TCC usage descriptions"     bash scripts/verify-usage-descriptions.sh
run "release consistency"        bash scripts/verify-release-consistency.sh
run "release aggregation regression" python3 -m unittest discover -s scripts/tests -p 'test_*.py'
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
run "macOS swift unit tests"      bash -c 'cd apps/genie-macos || exit; out=$(swift test 2>&1); st=$?; echo "$out" | grep -E "Executed [0-9]+ tests" | tail -1; if [ "$st" -ne 0 ]; then tail -40 <<<"$out"; fi; exit "$st"'

echo
if [[ $fail -eq 0 ]]; then echo "VERIFY_ALL_OK: この環境で検証できる全ゲートが緑"; else echo "VERIFY_ALL_FAIL"; exit 1; fi

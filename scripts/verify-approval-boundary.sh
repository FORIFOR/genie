#!/usr/bin/env bash
# APPROVAL_BOUNDARY — 声・会話・自動の経路から、backend の承認を通せないこと。
#
#   Voice → Conversation → Intent / Lane → Task Request ═ 安全の境界 ═ Approval / Policy → Execution
#
# 過去に起きた欠陥（どれも「宣言は正しいのに、本番の経路で効いていなかった」）:
#   - Dock の依頼が WAITING_APPROVAL を見ると、カードを出さずに decision: "APPROVED" を中継していた。
#   - 待つ時間を min(waitMs, 2000) に縮めていた（単体テスト ApprovalBoundaryTests が follow ごと数える。
#     ここでは書き戻しの形を字句で落とす）。
#   - 音声の「ストップ」「待って」「違う」が、実行中の仕事を /v1/tasks/:id/cancel で取り消していた。
#   - 確認カードを待つ間 run loop を空回ししていたので、人のクリック・キーがボタンへ届かず、
#     backend の承認は 120 秒後に必ず「承認しない」になっていた（--runtime が実キーで確かめる）。
#
# 守り方は 3 段:
#   1. 型（コンパイラ）: 証拠 `UserApproval` の init は GenieApproval モジュールの外から見えず（internal）、
#      コピーもできない（~Copyable、consuming で使い切る）。--selfcheck が偽造の書き方を実際に
#      コンパイルし、どれも通らないことを確かめる。
#      **型で守れていないもの:** 入口の `ApprovalLedger.issue(forPressedCard:)` は public なので、
#      GenieMac のどこからでも任意の UUID で呼べばコンパイルが通る。これを Confirm.approve の
#      1 か所に限るのは 2 の字句の検査（⑦）だけ（--selfcheck はその形がコンパイルは通ること・字句では落ちることの両方を確かめる）。
#   2. 字句（scripts/approval_boundary.py）: 型では縛れない入口の数と置き場所を数える。
#      行単位の正規表現ではなく、コメント・文字列・補間・括弧の入れ子を読んだ字句の並びで判定する
#      （改行をまたぐ extension・別名・.init の省略形・関数参照・補間の中の呼び出しも拾う）。
#   3. 実行（--runtime）: 本物のキーを OS のイベントの列から送り、カードに答えられることを見る。
#
#   bash scripts/verify-approval-boundary.sh              # 字句の検査
#   bash scripts/verify-approval-boundary.sh --selfcheck  # 過去の欠陥と抜け道を写しに書き戻し、本当に落ちるか（+ 型の偽造）
#   bash scripts/verify-approval-boundary.sh --runtime    # 実キーで承認カードに答える（.build/debug/GenieMac）
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/apps/genie-macos"
CHECK="$ROOT/scripts/approval_boundary.py"

check() { python3 "$CHECK" "$1"; }

if [[ "${1:-}" == "--runtime" ]]; then
  echo "== APPROVAL_BOUNDARY runtime（実キー）=="
  BIN="${ASTRA_APPROVAL_BIN:-$APP/.build/debug/GenieMac}"
  if [[ "$(uname -s)" != Darwin || ! -x "$BIN" ]]; then
    echo "APPROVAL_BOUNDARY_RUNTIME=SKIP（macOS の debug ビルドが無い: $BIN）"; exit 0
  fi
  OUT="$(mktemp -d)"; trap 'rm -rf "$OUT"' EXIT
  ASTRA_DATA_ROOT="$OUT/data" "$BIN" --selftest approval-press >"$OUT/out.txt" 2>"$OUT/err.txt" &
  pid=$!
  for _ in $(seq 1 120); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
  if kill -0 "$pid" 2>/dev/null; then kill "$pid"; echo "  ✗ 60 秒で終わらない"; cat "$OUT/out.txt"; exit 1; fi
  wait "$pid"; st=$?
  cat "$OUT/out.txt"
  if [[ "$st" -eq 0 ]] && grep -q '^SELFTEST_OK approval-press:' "$OUT/out.txt"; then echo "APPROVAL_BOUNDARY_RUNTIME=PASS"; exit 0; fi
  if grep -q '^SELFTEST_SKIP approval-press:' "$OUT/out.txt"; then echo "APPROVAL_BOUNDARY_RUNTIME=SKIP"; exit 0; fi
  tail -20 "$OUT/err.txt"; echo "APPROVAL_BOUNDARY_RUNTIME=FAIL"; exit 1
fi

if [[ "${1:-}" == "--selfcheck" ]]; then
  # 検査が本当に落ちるか。過去の欠陥（と、型や検査を黙って抜ける書き方）を 1 つずつ写しに書き戻す。
  TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
  mkdir -p "$TMP/app" "$TMP/orig"
  cp -cR "$APP/Sources" "$APP/Tests" "$TMP/app/" 2>/dev/null || cp -R "$APP/Sources" "$APP/Tests" "$TMP/app/"
  S="$TMP/app/Sources"
  VOICE_STATE="$S/GenieMac/VoiceHUD/VoiceHUDState.swift"
  CONFIRM_SRC="$S/GenieMac/Components/Confirm.swift"
  BRIDGE_SRC="$S/GenieMac/RecordingWorkspace/GenieCoreBridge.swift"
  DOCK_SRC="$S/GenieMac/VoiceHUD/VoiceHUDView.swift"
  MODULE_SRC="$S/GenieApproval/UserApproval.swift"
  TEST_SRC="$TMP/app/Tests/GenieMacTests/ApprovalBoundaryTests.swift"
  TOUCHED=("$VOICE_STATE" "$CONFIRM_SRC" "$BRIDGE_SRC" "$DOCK_SRC" "$MODULE_SRC" "$TEST_SRC")
  for f in "${TOUCHED[@]}"; do cp "$f" "$TMP/orig/$(basename "$f")"; done
  restore() { for f in "${TOUCHED[@]}"; do cp "$TMP/orig/$(basename "$f")" "$f"; done; }
  echo "== APPROVAL_BOUNDARY selfcheck =="
  if ! check "$TMP/app" >"$TMP/clean.txt"; then
    echo "  FAIL: 手を入れていない写しが通らない"; cat "$TMP/clean.txt"; exit 1
  fi
  bad=0
  verdict() {  # <名前>
    if check "$TMP/app" >"$TMP/out.txt"; then echo "  FAIL: 落ちなかった — $1"; bad=1
    else echo "  ✓ 落ちた — $1"; grep -m1 '✗' "$TMP/out.txt" | sed 's/^ */      /'; fi
    restore
  }
  # <名前> <書き戻す先> <足す行（\n で複数行）>
  inject() { printf '%b\n' "$3" >>"$2"; verdict "$1"; }

  # ── 過去の欠陥 ──
  inject '承認待ちを見たら APPROVED を中継（元の欠陥）' "$VOICE_STATE" \
    'func relay() { try? GenieCoreBridge.taskApprove(base, accessToken: token, taskId: id, approvalId: a, decision: "APPROVED") }'
  inject 'min(waitMs, 2000) で待つ時間を縮める（元の欠陥）' "$VOICE_STATE" \
    'extension VoiceHUDState { nonisolated static func short(_ w: UInt64) -> UInt64 { min(waitMs, 2000) } }'
  inject 'follow が区切りを通らずに waitTask を直接呼ぶ' "$VOICE_STATE" \
    'extension VoiceHUDState { nonisolated static func quick(_ o: TurnOutcome, base: String, token: String) throws -> TaskStatus { try GenieCoreBridge.waitTask(base, accessToken: token, taskId: o.taskId, timeoutMs: 2000) } }'
  inject '声の「ストップ」で仕事を取り消す（元の欠陥）' "$VOICE_STATE" \
    'func stop(_ t: String) { if VoiceInterruptionDetector.isInterruption(t) { cancelCurrentTask(reason: t) } }'
  inject '声の経路から /cancel を叩く' "$VOICE_STATE" \
    'let cancelURL = URL(string: "\\(base)/v1/tasks/\\(id)/cancel")'
  inject '声の経路から、カードの「やめる」以外で REJECTED を送る' "$VOICE_STATE" \
    'func stopByVoice() { try? GenieCoreBridge.taskReject(base, accessToken: token, taskId: id, approvalId: a) }'

  # ── 生の FFI・APPROVED の文字 ──
  inject '生の FFI を直接呼ぶ' "$VOICE_STATE" \
    'func relay() { try? apiTaskApprove(baseUrl: base, accessToken: token, taskId: id, approvalId: a, decision: d) }'
  inject '関数参照で生の FFI を運ぶ（let relay = apiTaskApprove）' "$VOICE_STATE" \
    'func relay() { let relay = apiTaskApprove; try? relay(base, token, id, a, "APP" + "ROVED") }'
  inject '文字列の補間の中に生の FFI を隠す' "$VOICE_STATE" \
    'let hidden = "\\(String(describing: try? apiTaskApprove(baseUrl: b, accessToken: t, taskId: i, approvalId: a, decision: "X")))"'
  inject 'GenieCoreBridge に証拠の要らない承認の入口を足す' "$BRIDGE_SRC" \
    'extension GenieCoreBridge { static func relayApproval(_ b: String, accessToken: String, taskId: String, approvalId: String) throws { try apiTaskApprove(baseUrl: b, accessToken: accessToken, taskId: taskId, approvalId: approvalId, decision: "APPROVED") } }'
  inject 'GenieApproval に証拠を受け取らない APPROVED の関数を足す' "$MODULE_SRC" \
    'extension ApprovalRelay { public static func approveNow(_ b: String, accessToken: String, taskId: String, approvalId: String) throws { try apiTaskApprove(baseUrl: b, accessToken: accessToken, taskId: taskId, approvalId: approvalId, decision: "APPROVED") } }'
  inject 'GenieApproval で decision を変数で渡す' "$MODULE_SRC" \
    'extension ApprovalRelay { public static func decide(_ d: String) throws { try apiTaskApprove(baseUrl: "", accessToken: "", taskId: "", approvalId: "", decision: d) } }'
  inject 'URLSession で /approve を叩く' "$VOICE_STATE" \
    'let approveURL = URL(string: "\\(base)/v1/tasks/\\(id)/approve")'

  # ── 証拠を GenieApproval の外で作る ──
  inject '証拠を GenieMac で作る' "$VOICE_STATE" \
    'func relay(_ c: ActionConfirmation) -> UserApproval { UserApproval(confirmationID: c.id) }'
  inject '別のファイルで証拠の init を足す' "$VOICE_STATE" \
    'extension UserApproval { init(voice: String) { self = ApprovalLedger.issue(forPressedCard: UUID()) } }'
  inject '別名（typealias）で extension を隠す' "$VOICE_STATE" \
    'typealias VoiceProof =\n    UserApproval\nextension VoiceProof { init(voice: String) { confirmationID = UUID(); answeredAt = Date() } }'
  inject 'extension の直後で改行する' "$VOICE_STATE" \
    'extension\nUserApproval { init(v: Int) { self.confirmationID = UUID(); self.answeredAt = Date() } }'
  inject '.init(…) の省略形で作る' "$VOICE_STATE" \
    'func voiceYes() { let p: UserApproval = .init(voice: "はい"); _ = p }'
  inject 'Unsafe…<UserApproval> で作る' "$VOICE_STATE" \
    'func forge() -> UserApproval { UnsafeMutablePointer<UserApproval>.allocate(capacity: 1).move() }'
  inject '証拠を JSON から decode できるようにする' "$CONFIRM_SRC" \
    'extension UserApproval: Decodable {}'
  inject 'カードを出さずに証拠を作る（Confirm.swift の中の近道）' "$CONFIRM_SRC" \
    'extension Confirm { @MainActor static func approveQuietly(_ c: ActionConfirmation) -> UserApproval { ApprovalLedger.issue(forPressedCard: c.id) } }'
  inject '証拠の入口を関数参照で持ち出す' "$VOICE_STATE" \
    'let mint = ApprovalLedger.issue'
  inject '検査から証拠の internal init を覗く（@testable import GenieApproval）' "$TEST_SRC" \
    '@testable import GenieApproval'
  # 置き換えの書き戻し（行を足すのではない）。
  perl -pi -e 's/^    init\(confirmationID: UUID\) \{/    public init(confirmationID: UUID) {/' "$MODULE_SRC"; verdict '証拠の init を public にする'
  perl -pi -e 's/struct UserApproval: ~Copyable, Sendable/struct UserApproval: Sendable/' "$MODULE_SRC"; verdict '証拠をコピーできる形にする（使い回せる）'

  # ── カードの答え ──
  inject '声で「はい」をカードの承認にする（id 無し）' "$VOICE_STATE" \
    'func sayYes() { GenieStateStore.shared.resolveConfirmation(approved: true) }'
  inject '声で「はい」をカードの承認にする（id 付き）' "$VOICE_STATE" \
    'func sayYes(_ c: ActionConfirmation) { GenieStateStore.shared.resolveConfirmation(id: c.id, approved: true) }'
  inject 'Dock のボタンが描いたカードでなく現在値に答える' "$DOCK_SRC" \
    'struct AnyCardButton: View { var body: some View { Button("") { GenieStateStore.shared.resolveConfirmation(approved: true) } } }'
  # どれも待っている Confirm.approve を true で起こすので、正規の 1 か所で証拠が作られてしまう形。
  inject '声で「はい」を、型名付きの .confirmationResolved で流す' "$VOICE_STATE" \
    'func sayYes(_ c: ActionConfirmation) { GenieEventBus.shared.publish(GenieEvent.confirmationResolved(id: c.id, approved: true)) }'
  inject '声で「はい」を、変数に入れた .confirmationResolved で流す' "$VOICE_STATE" \
    'func sayYes(_ c: ActionConfirmation) { let e: GenieEvent = .confirmationResolved(id: c.id, approved: true); GenieEventBus.shared.publish(e) }'
  inject '声で「はい」を、resolveConfirmation の関数参照で答える' "$VOICE_STATE" \
    'func sayYes(_ c: ActionConfirmation) { let r: (UUID, Bool, [String: String]) -> Void = GenieStateStore.shared.resolveConfirmation; r(c.id, true, [:]) }'
  inject '声で「はい」を、UIProbe.tap で「実行する」を押して答える' "$VOICE_STATE" \
    'func sayYes() { UIProbe.tap("confirmProceed") }'
  inject 'appendingPathComponent("approve") で承認の URL を組む' "$VOICE_STATE" \
    'let approveURL = URL(string: "http://127.0.0.1")!.appendingPathComponent("approve")'
  # 型では拒めない（issue は public）。字句の ⑦ だけが落とす。
  inject '証拠の入口を任意の UUID で呼ぶ（型では通る）' "$VOICE_STATE" \
    'func mint() -> UserApproval { ApprovalLedger.issue(forPressedCard: UUID()) }'

  # ── 端末のローカル HTTP サーバから承認を中継する（scripts/computer-use-ui.mjs の元の欠陥）──
  mkdir -p "$TMP/scripts"
  cp "$ROOT/scripts/computer-use-ui.mjs" "$TMP/scripts/"
  if ! python3 "$CHECK" --servers "$TMP/scripts" >"$TMP/srv.txt"; then
    echo "  FAIL: 手を入れていない scripts の写しが通らない"; cat "$TMP/srv.txt"; bad=1
  fi
  printf '%s\n' "const relay = (b, id, a) => fetch(\`\${b}/v1/tasks/\${id}/approve\`, { method: 'POST', body: JSON.stringify({ approval_id: a, decision: 'APPROVED' }) });" \
    >>"$TMP/scripts/computer-use-ui.mjs"
  if python3 "$CHECK" --servers "$TMP/scripts" >"$TMP/srv.txt"; then echo "  FAIL: 落ちなかった — ローカル HTTP サーバが APPROVED を中継する"; bad=1
  else echo "  ✓ 落ちた — ローカル HTTP サーバが APPROVED を中継する"; grep -m1 '✗' "$TMP/srv.txt" | sed 's/^ */      /'; fi

  # ── 型の上で偽造できないこと（コンパイラに実際に通させる）──
  echo
  MOD=""
  for d in "$APP/.build/debug/Modules" "$APP/.build/arm64-apple-macosx/debug/Modules" "$APP/.build/x86_64-apple-macosx/debug/Modules"; do
    [[ -f "$d/GenieApproval.swiftmodule" || -d "$d/GenieApproval.swiftmodule" ]] && { MOD="$d"; break; }
  done
  FFI_INC="$APP/Sources/GenieCoreFFI/include"
  if [[ -z "$MOD" ]] || ! command -v xcrun >/dev/null 2>&1; then
    echo "  · 型の偽造: GenieApproval が未ビルド（swift build の後に確かめる）"
  else
    compile() {  # <本文> → 0 ならコンパイルが通った
      printf 'import Foundation\nimport GenieApproval\n%b\n' "$1" >"$TMP/forge.swift"
      xcrun swiftc -emit-sil -swift-version 5 -I "$MOD" -I "$FFI_INC" -Xcc -fmodule-map-file="$FFI_INC/module.modulemap" \
        "$TMP/forge.swift" -o /dev/null >"$TMP/forge.txt" 2>&1
    }
    # 検査の道具そのものが動いていること（通るはずのものが通る）。
    if ! compile 'func ok(_ a: consuming UserApproval) throws { try ApprovalRelay.approve("", accessToken: "", taskId: "", approvalId: "1", approval: a) }'; then
      echo "  FAIL: 型の検査の道具が動かない"; head -5 "$TMP/forge.txt"; bad=1
    else
      forge() {  # <名前> <本文>
        if compile "$2"; then echo "  FAIL: コンパイルが通った — $1"; bad=1
        else echo "  ✓ 型が拒む — $1"; grep -m1 'error:' "$TMP/forge.txt" | sed 's/.*error: /      /'; fi
      }
      forge 'GenieMac から直接 init' 'func f() -> UserApproval { UserApproval(confirmationID: UUID()) }'
      forge '.init(…) の省略形' 'func f() { let p: UserApproval = .init(confirmationID: UUID()); _ = p }'
      forge '別名 + extension で let を埋める' 'typealias VoiceProof = UserApproval\nextension VoiceProof { init(voice: String) { confirmationID = UUID(); answeredAt = Date() } }'
      forge '改行をまたぐ extension' 'extension\nUserApproval { init(v: Int) { self.confirmationID = UUID(); self.answeredAt = Date() } }'
      forge 'JSON から decode' 'extension UserApproval: Decodable { public init(from d: Decoder) throws { fatalError() } }'
      forge '1 回の証拠を 2 件の承認に使う' 'func f(_ a: consuming UserApproval) throws { try ApprovalRelay.approve("", accessToken: "", taskId: "", approvalId: "1", approval: a); try ApprovalRelay.approve("", accessToken: "", taskId: "", approvalId: "2", approval: a) }'
      forge '証拠をループで使い回す' 'func f(_ a: consuming UserApproval) throws { for id in ["1", "2"] { try ApprovalRelay.approve("", accessToken: "", taskId: "", approvalId: id, approval: a) } }'
      forge 'unsafeBitCast で作る' 'func f() -> UserApproval { unsafeBitCast((UUID(), Date()), to: UserApproval.self) }'
      forge '証拠なしで ApprovalRelay.approve' 'func f() throws { try ApprovalRelay.approve("", accessToken: "", taskId: "", approvalId: "1") }'
      # 型で守れていない所を、守れているように見せない。通るなら通ると書く（字句の ⑦ が落とすことは上で確かめた）。
      if compile 'func f() -> UserApproval { ApprovalLedger.issue(forPressedCard: UUID()) }'; then
        echo "  · 型では拒まない — ApprovalLedger.issue(forPressedCard: 任意の UUID)（public。字句の ⑦ だけが落とす）"
      else
        echo "  ✓ 型が拒む — ApprovalLedger.issue(forPressedCard: 任意の UUID)（注釈の「型では拒まない」を直す）"
      fi
    fi
  fi
  echo
  if [[ "$bad" == "0" ]]; then echo "APPROVAL_BOUNDARY_SELFCHECK=PASS"; else echo "APPROVAL_BOUNDARY_SELFCHECK=FAIL"; exit 1; fi
  exit 0
fi

echo "== APPROVAL_BOUNDARY =="
st=0
check "$APP" || st=1
python3 "$CHECK" --servers "$ROOT/scripts" || st=1
if [[ "$st" == 0 ]]; then echo "APPROVAL_BOUNDARY=PASS"; else echo "APPROVAL_BOUNDARY=FAIL"; exit 1; fi

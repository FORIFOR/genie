#!/usr/bin/env python3
"""APPROVAL_BOUNDARY の検査本体（`scripts/verify-approval-boundary.sh` から呼ぶ）。

行単位の正規表現では、改行をまたぐ extension・別名（typealias）・`.init(` の省略形・
関数参照（`let f = apiTaskApprove`）・文字列の補間の中の呼び出しを見落とした。
ここでは Swift の字句（コメント・文字列・補間・括弧の入れ子）を読み、字句の並びと
「どの関数の中か / どの呼び出しの引数の中か」で判定する。

型で守っていること（`UserApproval` の init は GenieApproval モジュールの外から見えず、コピーもできない）は
コンパイラが強制する。ただし入口の `ApprovalLedger.issue` は public で、GenieMac のどこからでも任意の
UUID で呼べばコンパイルは通る。**そこは型ではなく、ここ（⑦）だけが守っている。**
ここで数えるのは、型では縛れない**入口の数と置き場所**:
  - 生の FFI（decision を文字で渡せる apiTaskApprove）は GenieApproval の中だけ
  - 証拠を作る入口（ApprovalLedger）は Confirm.approve の 1 か所だけ
  - カードの「実行する」は、人が押すボタンから、描いたカードの id 付きでだけ
    （答えの知らせ .confirmationResolved を流すのは GenieStateStore だけ・resolveConfirmation を関数参照で
    持ち出さない・UIProbe.tap（検査の自動操作）は SelfTest の外で使わない）
  - 端末のローカル HTTP サーバ（scripts/*.mjs の createServer）は backend の承認を中継しない
  - 声の経路は仕事を取り消さない
  - 承認待ちの待ち方を縮めない（min(waitMs, …) の書き戻し）

  python3 scripts/approval_boundary.py <apps/genie-macos に当たる dir>
  python3 scripts/approval_boundary.py --servers <scripts に当たる dir>
"""
import os
import re
import sys

APPROVAL_DIR = 'Sources/GenieApproval/'
FFI = 'Sources/GenieCore/genie_core.swift'           # uniffi が生成した束縛（宣言だけが在る）
BRIDGE = 'Sources/GenieMac/RecordingWorkspace/GenieCoreBridge.swift'
CONFIRM = 'Sources/GenieMac/Components/Confirm.swift'
PRESENTER = 'Sources/GenieMac/Action/ConfirmationPresenter.swift'
DOCK = 'Sources/GenieMac/VoiceHUD/VoiceHUDView.swift'  # ConfirmationDock のボタン
STORE = 'Sources/GenieMac/Core/GenieStateStore.swift'
EVENT_BUS = 'Sources/GenieMac/Core/GenieEventBus.swift'   # GenieEvent の宣言
VOICE_STATE = 'Sources/GenieMac/VoiceHUD/VoiceHUDState.swift'
VOICE = ('Sources/GenieMac/VoiceHUD/', 'Sources/GenieMac/Audio/', 'Sources/GenieMac/Context/Dictation.swift')
GUARDED = ('UserApproval', 'ApprovalLedger', 'ApprovalRelay')
RAW_FFI = {'apiTaskApprove', 'api_task_approve', 'uniffi_genie_core_fn_func_api_task_approve',
           'uniffi_genie_core_checksum_func_api_task_approve'}


# ─── 字句 ────────────────────────────────────────────────────────────────

class Tok:
    __slots__ = ('kind', 'text', 'line')

    def __init__(self, kind, text, line):
        self.kind, self.text, self.line = kind, text, line

    def __repr__(self):
        return f'{self.kind}:{self.text}@{self.line}'


IDENT_START = re.compile(r'[A-Za-z_\u0080-￿$]')
IDENT_CHAR = re.compile(r'[A-Za-z0-9_\u0080-￿$]')


def lex(src):
    """Swift の字句に分ける。コメントは捨て、文字列は 1 つの 'str' にまとめ（補間の中は字句として出す）。"""
    toks = []
    i, n, line = 0, len(src), 1

    def lex_code(stop_paren):
        """stop_paren なら、対応する ')' で止まる（補間の中）。"""
        nonlocal i, line
        depth = 0
        while i < n:
            c = src[i]
            if c == '\n':
                line += 1; i += 1; continue
            if c in ' \t\r':
                i += 1; continue
            if src.startswith('//', i):
                while i < n and src[i] != '\n': i += 1
                continue
            if src.startswith('/*', i):
                nest = 0
                while i < n:
                    if src.startswith('/*', i): nest += 1; i += 2; continue
                    if src.startswith('*/', i):
                        nest -= 1; i += 2
                        if nest == 0: break
                        continue
                    if src[i] == '\n': line += 1
                    i += 1
                continue
            # 文字列（#"…"# の raw、""" の複数行を含む）
            m = re.match(r'(#*)("""|")', src[i:])
            if m:
                lex_string(len(m.group(1)), m.group(2)); continue
            if IDENT_START.match(c):
                j = i + 1
                while j < n and IDENT_CHAR.match(src[j]): j += 1
                toks.append(Tok('id', src[i:j], line)); i = j; continue
            if c == '`':
                j = src.find('`', i + 1)
                j = n if j < 0 else j
                toks.append(Tok('id', src[i + 1:j], line)); i = j + 1; continue
            if c.isdigit():
                j = i + 1
                while j < n and (src[j].isalnum() or src[j] in '_.'):
                    if src[j] == '.' and not (j + 1 < n and src[j + 1].isdigit()): break
                    j += 1
                toks.append(Tok('num', src[i:j], line)); i = j; continue
            if c == '(':
                depth += 1
            elif c == ')':
                if stop_paren and depth == 0:
                    i += 1; return
                depth -= 1
            toks.append(Tok('p', c, line)); i += 1

    def lex_string(hashes, quote):
        nonlocal i, line
        start_line = line
        i += hashes + len(quote)
        close = quote + '#' * hashes
        interp = '\\' + '#' * hashes + '('
        buf = []
        while i < n:
            if src.startswith(close, i):
                i += len(close); break
            if src.startswith(interp, i):
                i += len(interp)
                # 補間の中はコード。字句として出す（呼び出しを文字列に隠させない）。
                lex_code(True)
                continue
            if hashes == 0 and src[i] == '\\' and i + 1 < n:
                buf.append(src[i:i + 2]); i += 2; continue
            if src[i] == '\n':
                line += 1
                if quote == '"': break
            buf.append(src[i]); i += 1
        toks.append(Tok('str', ''.join(buf), start_line))

    lex_code(False)
    return toks


# ─── 構造（どの関数の中か・どの呼び出しの中か）─────────────────────────────

class Frame:
    __slots__ = ('open', 'callee', 'func', 'sig', 'head')

    def __init__(self, open_, callee=None, func=None, sig=None, head=()):
        self.open, self.callee, self.func, self.sig, self.head = open_, callee, func, sig, head


def decl_head(toks, k):
    """toks[k] が '{' のとき、その宣言の頭（直前の { } ; まで）の字句。"""
    j = k - 1
    while j >= 0 and toks[j].text not in ('{', '}', ';'): j -= 1
    return tuple(t.text for t in toks[j + 1:k])


def annotate(toks):
    """各字句に、その時点で開いている枠（括弧・波括弧）の列を付ける。"""
    stack, out = [], []
    pending = None          # (func 名, signature の開始位置, 開始時の括弧の深さ)
    last_closed_callee = None
    for k, t in enumerate(toks):
        out.append(list(stack))
        if t.kind == 'id' and t.text in ('func', 'init', 'subscript') and not (k > 0 and toks[k - 1].text == '.'):
            name = t.text
            if t.text == 'func' and k + 1 < len(toks): name = toks[k + 1].text
            pending = (name, k, sum(1 for f in stack if f.open == '('))
            continue
        if t.kind != 'p': continue
        if t.text == '(':
            prev = toks[k - 1] if k > 0 else None
            callee = prev.text if prev is not None and prev.kind == 'id' else None
            stack.append(Frame('(', callee=callee))
        elif t.text == ')':
            while stack and stack[-1].open != '(': stack.pop()
            if stack: last_closed_callee = stack.pop().callee
        elif t.text == '{':
            prev = toks[k - 1] if k > 0 else None
            parens = sum(1 for f in stack if f.open == '(')
            if pending is not None and parens == pending[2]:
                stack.append(Frame('{', func=pending[0], sig=toks[pending[1]:k]))
                pending = None
            else:
                callee = None
                if prev is not None and prev.kind == 'p' and prev.text == ')': callee = last_closed_callee
                elif prev is not None and prev.kind == 'id': callee = prev.text
                stack.append(Frame('{', callee=callee, head=decl_head(toks, k)))
        elif t.text == '}':
            while stack and stack[-1].open != '{': stack.pop()
            if stack: stack.pop()
            pending = None      # 本体の無い宣言（protocol の func）を次の { に付けない
    return out


def prv_(toks, k):
    return toks[k - 1].text if k > 0 else ''


def enclosing_func(frames):
    for f in reversed(frames):
        if f.func is not None: return f
    return None


def inside_call(frames, names):
    return any(f.callee in names for f in frames)


def call_args(toks, open_index):
    """toks[open_index] が '(' の呼び出しの引数を {label: [字句]} で返す（入れ子は丸ごと）。"""
    args, label, cur, depth = {}, None, [], 0
    k = open_index + 1
    while k < len(toks):
        t = toks[k]
        if t.kind == 'p' and t.text in '([{': depth += 1
        if t.kind == 'p' and t.text in ')]}':
            if depth == 0:
                args[label] = cur; break
            depth -= 1
        if depth == 0 and t.kind == 'p' and t.text == ',':
            args[label] = cur; label, cur = None, []; k += 1; continue
        if depth == 0 and not cur and t.kind == 'id' and k + 1 < len(toks) and toks[k + 1].text == ':':
            label = t.text; k += 2; continue
        cur.append(t); k += 1
    return args, k


def sig_has_consuming_user_approval(sig):
    texts = [t.text for t in sig]
    for k in range(len(texts) - 1):
        if texts[k] == 'consuming' and texts[k + 1] == 'UserApproval': return True
        if texts[k] == 'consuming' and texts[k + 1] == 'GenieApproval' and k + 3 < len(texts) and texts[k + 3] == 'UserApproval':
            return True
    return False


# ─── 検査 ────────────────────────────────────────────────────────────────

def check(app):
    files = {}
    for top in ('Sources', 'Tests'):
        for d, _, names in os.walk(os.path.join(app, top)):
            for name in names:
                if name.endswith('.swift'):
                    p = os.path.join(d, name)
                    rel = os.path.relpath(p, app)
                    toks = lex(open(p, encoding='utf-8').read())
                    files[rel] = (toks, annotate(toks))

    fails = []

    def fail(rel, t, why):
        fails.append(f'  ✗ {rel}:{t.line if t is not None else "?"} {why}')

    ledger_uses = []
    approved_decisions, rejected_decisions = [], []

    for rel, (toks, frames) in sorted(files.items()):
        in_module = rel.startswith(APPROVAL_DIR)
        selftest = (re.search(r'/App/(SelfTest[^/]*|SurfaceMotionGate)\.swift$', rel) is not None
                    or rel.startswith('Tests/'))
        voice = rel.startswith(VOICE)
        texts = [t.text for t in toks]

        def nxt(k, m=1):
            return toks[k + m].text if k + m < len(toks) else ''

        def prv(k, m=1):
            return toks[k - m].text if k - m >= 0 else ''

        for k, t in enumerate(toks):
            fr = frames[k]
            func = enclosing_func(fr)

            # ① 生の FFI（decision を文字で渡せる）は GenieApproval の中だけ。呼び出しに限らず、
            #    名前が出ること（関数参照・補間の中）を数える。
            if t.kind == 'id' and t.text in RAW_FFI and rel != FFI:
                if not in_module:
                    fail(rel, t, f'生の {t.text} を GenieApproval の外で参照している（関数参照・補間の中も数える）')
                elif nxt(k) != '(' or (prv(k) == '.' and prv(k, 2) != 'GenieCore'):
                    fail(rel, t, f'{t.text} を呼び出し以外の形で使っている（関数参照で decision を運ばせない）')
                else:
                    args, _ = call_args(toks, k + 1)
                    decision = args.get('decision', [])
                    if len(decision) != 1 or decision[0].kind != 'str' or decision[0].text not in ('APPROVED', 'REJECTED'):
                        fail(rel, t, 'decision を文字の定数（APPROVED / REJECTED）以外で渡している')
                    elif decision[0].text == 'APPROVED':
                        approved_decisions.append((rel, t, func))
                    else:
                        rejected_decisions.append((rel, t, func))

            # ② 「APPROVED」の文字は GenieApproval の中の 1 か所だけ（検査の自動操作の表示は除く）。
            if t.kind == 'str' and t.text == 'APPROVED' and not in_module and not selftest:
                fail(rel, t, '"APPROVED" を GenieApproval の外で書いている')
            # 「/approve」だけでなく、appendingPathComponent("approve") のように区切りの無い形も数える。
            if t.kind == 'str' and re.search(r'(?:^|/)approve(?:$|[/?#])', t.text) and rel != FFI:
                fail(rel, t, '/approve を直接組み立てている（GenieApproval の ApprovalRelay を通す）')

            # ③ 証拠（UserApproval）を GenieApproval の外で作らない・広げない・別名にしない。
            if not in_module:
                if t.kind == 'id' and t.text == 'import' and prv(k) == 'testable' and nxt(k) == 'GenieApproval':
                    fail(rel, t, '@testable import GenieApproval（証拠の internal init が見える）')
                if t.kind == 'id' and t.text == 'UserApproval':
                    if nxt(k) == '(' or (nxt(k) == '.' and nxt(k, 2) in ('init', 'self')):
                        fail(rel, t, f'UserApproval{"(" if nxt(k) == "(" else "." + nxt(k, 2)} を GenieApproval の外で使っている')
                    if nxt(k) == '=' and nxt(k, 2) == '.' and nxt(k, 3) == 'init':
                        fail(rel, t, 'UserApproval を .init(…) の省略形で作っている')
                    if prv(k) == '<' or nxt(k) == '>':
                        fail(rel, t, 'UserApproval を型引数に渡している（Unsafe…<UserApproval> で作れる形）')
                if t.kind == 'id' and t.text == 'typealias':
                    # 右辺の型（A.B<C, D> の形。改行をまたいでも読む）に、数えるべき名前があるか。
                    j = k + 1
                    while j < len(toks) and toks[j].text != '=' and toks[j].text not in ('{', '}', ';'): j += 1
                    rhs, depth, j = [], 0, j + 1
                    while j < len(toks):
                        x = toks[j]
                        if x.text == '<': depth += 1
                        elif x.text == '>': depth -= 1
                        elif depth == 0 and rhs and rhs[-1].text != '.' and x.text != '.': break
                        rhs.append(x); j += 1
                    hit = next((x.text for x in rhs if x.text in GUARDED), None)
                    if hit:
                        fail(rel, t, f'{hit} に別名を付けている（数えるべき入口を名前から隠せる）')
                if t.kind == 'id' and t.text == 'extension':
                    j = k + 1
                    while j < len(toks) and toks[j].text not in ('{', ':', 'where'):
                        if toks[j].text in GUARDED:
                            fail(rel, t, f'extension {toks[j].text}（改行をまたいでも数える）を GenieApproval の外で書いている'); break
                        j += 1
                if t.kind == 'id' and t.text in ('unsafeBitCast', 'unsafeDowncast') and 'UserApproval' in texts:
                    fail(rel, t, f'{t.text} を UserApproval と同じファイルで使っている')
                # 証拠を作る入口は Confirm.approve の 1 か所だけ。
                if t.kind == 'id' and t.text == 'ApprovalLedger':
                    ledger_uses.append((rel, t, func))
                # backend の承認に答える入口は GenieCoreBridge の taskApprove / taskReject だけ。
                if t.kind == 'id' and t.text == 'ApprovalRelay':
                    ok = (rel == BRIDGE and func is not None and (
                        (func.func == 'taskApprove' and nxt(k, 2) == 'approve' and sig_has_consuming_user_approval(func.sig))
                        or (func.func == 'taskReject' and nxt(k, 2) == 'reject')))
                    if not ok:
                        fail(rel, t, 'ApprovalRelay を GenieCoreBridge.taskApprove / taskReject の外で使っている')

            # ④ カードの答え。人が押す面は、描いたカードの id 付きで答える。
            if t.kind == 'id' and t.text == 'resolveConfirmation' and nxt(k) == '(' and prv(k) != 'func' and not selftest:
                args, _ = call_args(toks, k + 1)
                if 'id' not in args:
                    fail(rel, t, 'resolveConfirmation を id 無しで呼んでいる（描いたカードでなく store の現在値に答える）')
                approved = args.get('approved', [])
                if len(approved) == 1 and approved[0].text == 'true':
                    if not (rel == DOCK and inside_call(fr, {'Button', 'ProbeButton'})):
                        fail(rel, t, 'resolveConfirmation(approved: true) を Dock のボタン以外から呼んでいる')
                elif not (len(approved) == 1 and approved[0].text == 'false') and rel not in (CONFIRM, PRESENTER, STORE):
                    fail(rel, t, 'resolveConfirmation に変数の答えを渡している（Confirm / 確認の面の外）')
            # 答えの知らせを流すのは GenieStateStore だけ。GenieEvent.confirmationResolved(…) の型名付き・
            # 変数に入れてから publish する形も数える。許すのは受け取る側の `case .confirmationResolved`
            # （if case / switch の型の照合）と、GenieEvent の宣言だけ。
            if t.kind == 'id' and t.text == 'confirmationResolved' and rel != STORE:
                matching = prv(k) == '.' and (prv(k, 2) == 'case' or (prv(k, 2) in ('let', 'var') and prv(k, 3) == 'case'))
                declared = rel == EVENT_BUS and prv(k) == 'case'
                if not (matching or declared):
                    fail(rel, t, '.confirmationResolved を GenieStateStore の外で作っている（型名付き・変数経由の発行も数える）')
            # 関数参照で持ち出すと、上の「id 付き・Dock のボタンから」の検査を名前から隠せる。
            if t.kind == 'id' and t.text == 'resolveConfirmation' and nxt(k) != '(' and prv(k) != 'func':
                fail(rel, t, 'resolveConfirmation を呼び出し以外の形（関数参照）で使っている')
            # UIProbe.tap は画面の部品（confirmProceed / cardProceed を含む）を押す検査の自動操作。
            # 本番の経路から呼べば、人が押さずにカードの「実行する」が押せる。
            if t.kind == 'id' and t.text == 'tap' and prv(k) == '.' and prv(k, 2) == 'UIProbe' and not selftest:
                fail(rel, t, 'UIProbe.tap（検査の自動操作）を SelfTest の外で使っている')

            # ⑤ 声の経路は仕事を取り消さない（声を止めても仕事は止めない）。
            if voice:
                if t.kind == 'str' and re.search(r'/cancel\b', t.text):
                    fail(rel, t, '声の経路から /cancel を組み立てている')
                if t.kind == 'id' and t.text in ('VoiceInterruptionDetector', 'cancelCurrentTask', 'isInterruption', 'taskCancel', 'apiTaskCancel'):
                    fail(rel, t, f'声の経路から仕事を取り消している（{t.text}。キーワードでの取り消しは戻さない）')
                if t.kind == 'id' and t.text == 'taskReject' and not (func is not None and func.func == 'settleApprovals'):
                    fail(rel, t, '声の経路で、確認カードの「やめる」以外から REJECTED を送っている')

            # ⑥ 承認待ちの待ち方を縮めない。
            if t.kind == 'id' and t.text == 'min' and nxt(k) == '(' and nxt(k, 2) == 'waitMs':
                fail(rel, t, 'min(waitMs, …) で待つ時間を縮めている')
            if rel == VOICE_STATE and t.kind == 'id' and t.text == 'waitTask' and prv(k) == '.' and prv(k, 2) == 'GenieCoreBridge':
                if not (func is not None and func.func == 'live'):
                    fail(rel, t, 'follow が waitForTask の区切りを通らずに waitTask を呼んでいる（TaskReader.live の外）')

    # ⑦ 証拠を作る入口（ApprovalLedger）は Confirm.approve の 1 か所だけ。
    good = [u for u in ledger_uses if u[0] == CONFIRM and u[2] is not None and u[2].func == 'approve']
    if len(ledger_uses) != 1 or len(good) != 1:
        where = ', '.join(f'{r}:{t.line}' for r, t, _ in ledger_uses) or 'なし'
        fails.append(f'  ✗ 証拠を作る入口（ApprovalLedger）は Confirm.approve の 1 か所だけのはず（{where}）')

    # ⑧ GenieApproval モジュールの形。
    module = {r: v for r, v in files.items() if r.startswith(APPROVAL_DIR)}
    if not module:
        fails.append(f'  ✗ {APPROVAL_DIR} が無い（証拠の型をモジュールで閉じていない）')
    if len(approved_decisions) != 1:
        fails.append(f'  ✗ decision "APPROVED" を送る所が {len(approved_decisions)} か所（ApprovalRelay.approve の 1 か所だけのはず）')
    for rel, t, func in approved_decisions:
        if func is None or not sig_has_consuming_user_approval(func.sig):
            fail(rel, t, 'APPROVED を、証拠（consuming UserApproval）を受け取らない関数から送っている')
    if len(rejected_decisions) > 1:
        fails.append(f'  ✗ decision "REJECTED" を送る所が {len(rejected_decisions)} か所')
    struct_seen = False
    for rel, (toks, frames) in module.items():
        texts = [t.text for t in toks]
        n_approved_str = sum(1 for t in toks if t.kind == 'str' and t.text == 'APPROVED')
        if n_approved_str > 1:
            fails.append(f'  ✗ {rel}: "APPROVED" が {n_approved_str} か所')
        mints = []
        for k, t in enumerate(toks):
            if t.kind == 'id' and t.text == 'UserApproval' and k + 1 < len(toks) and toks[k + 1].text == '(':
                mints.append((t, enclosing_func(frames[k])))
            if t.kind == 'id' and ((t.text == 'init' and k > 0 and toks[k - 1].text == '.' and k + 1 < len(toks) and toks[k + 1].text == '(')
                                   or (t.text == 'Self' and k + 1 < len(toks) and toks[k + 1].text == '(')):
                fail(rel, t, '.init( / Self( で証拠を作る道を足している')
            if t.kind == 'id' and t.text == 'struct' and k + 1 < len(toks) and toks[k + 1].text == 'UserApproval':
                struct_seen = True
                head = []
                j = k + 2
                while j < len(toks) and toks[j].text != '{': head.append(toks[j].text); j += 1
                if '~' not in head or 'Copyable' not in head:
                    fail(rel, t, 'UserApproval が ~Copyable ではない（1 回の「実行する」を使い回せる）')
            # UserApproval の宣言・extension の中身（頭に UserApproval を持つ { } の中）。
            owner = next((f for f in reversed(frames[k]) if f.open == '{' and f.func is None and f.head), None)
            owns = owner is not None and 'UserApproval' in owner.head and ('struct' in owner.head or 'extension' in owner.head)
            if t.kind == 'p' and t.text == '{' and k > 0:
                head = decl_head(toks, k)
                if 'UserApproval' in head and ('struct' in head or 'extension' in head) and any(h in ('Codable', 'Decodable') for h in head):
                    fail(rel, t, 'UserApproval を decode で作れる形にしている')
            if owns and t.kind == 'id' and t.text == 'init' and prv_(toks, k) != '.':
                mods = [toks[j].text for j in range(max(0, k - 4), k)]
                if any(m in ('public', 'open', 'package') for m in mods):
                    fail(rel, t, 'UserApproval の init が public / package（GenieMac から作れる）')
        if len(mints) != 1 or mints[0][1] is None or mints[0][1].func != 'issue':
            fails.append(f'  ✗ {rel}: UserApproval を作るのは ApprovalLedger.issue の 1 か所だけのはず（{len(mints)} か所）')
    if module and not struct_seen:
        fails.append(f'  ✗ {APPROVAL_DIR}: struct UserApproval が無い')

    print(f'  files {len(files)} / 証拠を作る入口 {len(ledger_uses)} / APPROVED を送る所 {len(approved_decisions)} / 違反 {len(fails)}')
    for f in fails: print(f)
    return 1 if fails else 0


def check_servers(scripts):
    """端末で開くローカル HTTP サーバは backend の承認を中継しない。

    `scripts/computer-use-ui.mjs` は 127.0.0.1 で認証なし・CORS * のまま、`/api/tasks/:id/approve` を
    サーバの dev token で APPROVED にして中継していた。ブラウザで開いた任意のサイトから、人がカードを
    見ないまま画面操作を承認できた。承認は macOS アプリの確認カードだけに任せる。
    """
    fails, servers = [], 0
    for d, _, names in os.walk(scripts):
        if 'node_modules' in d: continue
        for name in names:
            if not name.endswith(('.mjs', '.js', '.ts')): continue
            p = os.path.join(d, name)
            src = open(p, encoding='utf-8').read()
            if not re.search(r'\bcreateServer\b', src): continue
            servers += 1
            rel = os.path.relpath(p, os.path.dirname(scripts.rstrip('/')))
            for n, line in enumerate(src.splitlines(), 1):
                if re.search(r'/approve\b', line) or re.search(r'''['"`]APPROVED['"`]''', line):
                    fails.append(f'  ✗ {rel}:{n} ローカル HTTP サーバが承認を中継している（承認は確認カードだけ）')
    print(f'  local servers {servers} / 違反 {len(fails)}')
    for f in fails: print(f)
    return 1 if fails else 0


if __name__ == '__main__':
    if sys.argv[1] == '--servers':
        sys.exit(check_servers(sys.argv[2]))
    sys.exit(check(sys.argv[1]))

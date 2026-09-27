#!/usr/bin/env bash
# 「AI が作った感」を機械的に止める。
#
# 生成された UI にありがちな癖は、見れば分かるのに、気づいたときには全体へ
# 広がっている。増えたところで落として、入り口で止める。
#
# 上限は**今日の数**（2026-09-01 時点）。正しい数ではなく、そこから増やさないための
# 天井。減らすのは自由。増やしたいなら、上限とその理由をここへ書く
# —— 「なんとなく足した」が積み上がるのを止めるのが目的なので、
# 理由を書けるなら通してよい。
#
# Gradient と巨大角丸だけは 0。いま 1 つも無く、Genie には要らないため。
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/apps/genie-macos/Sources/GenieMac"
fail=0

# 見るのは製品のコードだけ。撮影・検査の足場は数えない。
sources() { find "$SRC" -name '*.swift' ! -name 'SelfTest.swift' ! -name 'UIGeometry.swift' ! -name 'UIDiffImage.swift'; }

check() {  # $1=名前 $2=上限 $3=理由 $4=パターン
  name="$1"; limit="$2"; why="$3"; pattern="$4"
  n="$(python3 "$ROOT/scripts/ui-taste-count.py" "$SRC" "$name" "$pattern" "$ROOT/docs/release-evidence/2026-09-13-genie/ui-taste-review.json")" || { fail=1; return; }
  if [ "$n" -gt "$limit" ]; then
    echo "  ${name}: ${n} 箇所（上限 ${limit}）— ${why}" >&2
    sources | xargs grep -lE "$pattern" 2>/dev/null | sed "s|$ROOT/||" | head -3 | sed 's/^/      /' >&2
    fail=1
  else
    printf "  %-20s %3d / %3d\n" "$name" "$n" "$limit"
  fi
}

echo "== UI の癖 =="

# Gradient。意味のある 1 つ（Orb の呼吸）までは許す。面や札に敷き始めたら止める。
check "gradient" 4 "面や札に gradient を敷いていないか。色は 1 アクセントで足りる" \
  "LinearGradient|RadialGradient|AngularGradient"

# 巨大な角丸。tokens の最大は 28（Workspace）。それを超える直書きは行き過ぎ。
check "角丸 >28pt" 0 "巨大な角丸。tokens の範囲（<=28）で足りる" \
  "cornerRadius: *(29|[3-9][0-9]|[1-9][0-9][0-9])"

# 過剰な Glass。Material と VisualEffect は Dock の地 1 つで足りている。
# Liquid Glass（glassEffect）も同じ数に入れる（Dock の外殻の 1 つは ui-taste-review.json で確認済み）。
check "material/blur" 8 "すりガラスの多用。地は 1 つで足りる" \
  "\.ultraThinMaterial|\.thinMaterial|\.regularMaterial|NSVisualEffectView|\.glassEffect\("

# Sparkle icon。AI っぽさの記号。意味のある箇所（Agents/AI 操作）までに留める。
check "sparkles アイコン" 6 "意味の無い sparkles。AI らしさの飾りにしない" \
  "systemName: \"sparkles"

# RC追加箇所の用途レビューは docs/release-evidence/2026-09-13-genie/ui-taste-review.json。
# ソースhashが変わると失効。全体上限を一律に緩めず、未レビューの追加は従来どおり落とす。
# 何でも Pill 化。Capsule は波形・チップなど本当に丸いものだけ。
check "Capsule" 20 "何でも Pill にしていないか" \
  "Capsule\(\)"

# 影。面が浮きすぎる。Dock は窓の影に任せてある。
check "shadow" 9 "影の多用。面を浮かせすぎない" \
  "\.shadow\("

# 説明文だらけ。画面の文字は短く。長い日本語リテラルの数で見る。
check "40字超の文言" 6 "説明文が多すぎないか。画面は読ませる場所ではない" \
  "Text\(\"[^\"]{40,}\""

echo
if [[ $fail -eq 0 ]]; then
  echo "UI_TASTE_OK: 癖は上限内"
else
  echo "UI_TASTE_FAIL: 増えたぶんに理由があるなら、上限とその理由をこのスクリプトへ書く" >&2
  exit 1
fi

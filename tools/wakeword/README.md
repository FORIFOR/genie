# 「ジーニー」呼びかけ検出モデル

Mac の中だけで動く呼びかけ検出（`apps/genie-macos/Resources/wake/genie_ja.onnx`）の作り方。
標準の音声認識（文字起こし）は使わない。検出の後の聞き取り・返答は Gemini Live。

- 前処理: livekit-wakeword（Apache-2.0）同梱の凍結モデル（mel・speech embedding）。`scripts/fetch-wakeword-runtime.sh` が固定コミットで取る
- 学習するのは最後の分類器だけ（入力 `embeddings` (1,16,96) → 出力 `score` (1,1)）

## 作り直す

```bash
# 1. 学習用の声を Gemini TTS で作る（正例 8 文・負例 26 文 × 声と話し方 30 通り。キーは表示しない）
GEMINI_API_KEY=... python3 tools/wakeword/generate_gemini.py <data_dir> --per-phrase 30
# 2. 学習（numpy / onnxruntime / scikit-learn / onnx。軽い。memguard の下で）
python3 scripts/memguard.py --log m.log --report m.json -- \
  python tools/wakeword/train.py <data_dir> apps/genie-macos/Vendor/LiveKitWakeWord/Resources out.onnx
# 3. アプリと同じ判定で確かめる（マイク・外部送信なし）
open -n -W --stdout r.txt apps/genie-macos/build/Genie.app --args --selftest wakemodel out.onnx <wav...>
```

学習はアプリと同じ見方（2 秒の窓を 0.2 秒ずつ）で、正は「ジーニー」を言い終えてから 1.2 秒以内の窓、
「ジーニー、調子どう？」の「調子どう？」だけの窓は負。間違えやすい負の窓を足して 2 回学び直す。

## 2026-10-05 の版（genie_ja.onnx）

学習に使っていない 5 つの声で、アプリと同じ判定（0.8 を 2 回続けて）:

| | 学習側（Python） | アプリ（Swift） |
|---|---|---|
| 「ジーニー」を検出 | 41/46 | 40/46 |
| 起きてはいけない音で起きた | 3/116（地味に 2・ジーンズ 1） | 4/116 |

合成音声だけで作った最初の版。本人の声・部屋の雑音・長時間の日常音での誤起動はまだ測っていない。

# 声で本人を見分けるモデル（speaker_ecapa_int8.onnx）

「声を覚える」（2 回）と、呼びかけのたびの本人確認に使う。アプリでの使い方は
`apps/genie-macos/Sources/GenieMac/Audio/SpeakerPrint.swift`。

- 元のモデル: [speechbrain/spkrec-ecapa-voxceleb](https://huggingface.co/speechbrain/spkrec-ecapa-voxceleb)（ECAPA-TDNN、Apache-2.0）
- `export_onnx.py`: 16 kHz の波形 → 192 次元の特徴を 1 本の ONNX に（Fbank・正規化もモデルの中）。PyTorch 版との差は cosine 1.0
- int8 にした（`onnxruntime.quantization.quantize_dynamic`、84 MB → 22 MB）。精度はほぼ同じ（下の表）

## 作り直し方

```bash
python3.11 -m venv .venv && source .venv/bin/activate
pip install torch torchaudio speechbrain soundfile numpy silero-vad onnx onnxruntime onnxscript
python export_onnx.py out/speaker_ecapa.onnx
python -c "from onnxruntime.quantization import quantize_dynamic, QuantType; quantize_dynamic('out/speaker_ecapa.onnx', 'out/speaker_ecapa_int8.onnx', weight_type=QuantType.QInt8)"
cp out/speaker_ecapa_int8.onnx ../../apps/genie-macos/Resources/wake/
```

## 測った値（2026-10-20）

`calibrate.py`: LibriSpeech test-clean / dev-clean（CC BY 4.0、各 40 人）。各発話から声のある部分を切り出し、
各話者 2 回で覚えて 10 回で確かめる（本人 1,600 組・他人 62,400 組）。

| 声の長さ | 覚えた回数 | 他人 0.1% に抑えたとき本人 | しきい値 |
|---|---|---|---|
| 1 秒 | 1 | 56〜62% | 0.33〜0.35 |
| 1 秒 | 2 | 77〜83% | 0.34〜0.37 |
| 2 秒 | 1 | 94% | 0.37〜0.38 |
| 2 秒 | 2 | 97〜98% | 0.39 |

アプリのしきい値は 0.42（2 秒・2 回で本人 95.6%・他人 0.11%、int8 で `compare_onnx.py`）。
0.38 だと、実際の誤反応の録音（`~/Library/Application Support/Genie/wake/false`）1 本が本人の声の特徴を超えた。

- 他人の声の見本でならす S-norm は、ほとんど効かなかった（使っていない）
- 英語・毎回違う文での値。アプリは登録も確認も「ジーニー」なので、これより良くなる見込み（日本語での測定は未）
- 声の前後に 0.2 秒の無音を足すと特徴が大きく変わる（似かた 0.51）。登録と待ち受けで同じ切り出し
  （`SpeakerEncoder.voiced`）を使うこと

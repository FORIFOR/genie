"""ONNX 版（fp32 / fp16 / int8）が PyTorch 版と同じ判定をするかを、LibriSpeech の 2 秒・登録 2 回で比べる。"""
import sys
from collections import defaultdict
from pathlib import Path
import numpy as np, soundfile as sf, torch, onnxruntime as ort
from silero_vad import load_silero_vad
sys.argv = ["x", "x"]
exec(open("calibrate.py").read().split("def embeddings")[0])  # speech_crop など
vad = load_silero_vad()
crops = defaultdict(list)
for name in ("test-clean", "dev-clean"):
    by = defaultdict(list)
    for f in sorted(Path(f"data/librispeech/LibriSpeech/{name}").rglob("*.flac")):
        by[f.parent.parent.name].append(f)
    for s, files in sorted(by.items()):
        for f in files:
            c = speech_crop(sf.read(f, dtype="float32")[0], vad, 2.0, len(crops[s]) % 3)
            if c is not None:
                crops[s].append(c.numpy())
            if len(crops[s]) == 12:
                break
ref = np.load("cache_test-clean_2.0.npz")
for f in ("out/speaker_ecapa_int8.onnx",):
    sess = ort.InferenceSession(f)
    emb = {s: np.array([sess.run(None, {"wav": c[None, :]})[0][0] for c in cs]) for s, cs in crops.items()}
    own, other = [], []
    for s, e in emb.items():
        prof = e[:2].mean(0); prof /= np.linalg.norm(prof)
        for t, e2 in emb.items():
            (own if t == s else other).extend(e2[2:] @ prof)
    own, other = np.array(own), np.array(other)
    for th in (0.38, 0.42):
        print(f"{Path(f).name}: しきい値 {th} 本人が通る {np.mean(own >= th):.1%}  他人が通る {np.mean(other >= th):.3%}")

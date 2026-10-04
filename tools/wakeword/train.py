#!/usr/bin/env python3
"""「ジーニー」呼びかけ検出の分類器を学習し、livekit-wakeword の Swift 検出器が読める ONNX に書き出す。

アプリと同じ見方で学ぶ: 2 秒の窓を 0.2 秒ずつずらして評価する（`LiveKitWakeDetector`）。
- 正: 「ジーニー」を言い終えてから 1.2 秒以内で、窓の中に「ジーニー」全体がある窓
- 負: 「ジーニー」を少しも含まない窓（「ジーニー、調子どう？」の「調子どう？」だけの窓を含む）、似た音・普通の文・雑音
- あいまい（「ジーニー」の一部だけ・言い終えてから時間が経った）窓は使わない
- 1 回学習したら、負の窓で点が高かったもの（間違えやすい窓）を足して学び直す
検証は学習に使わない声で、アプリと同じ判定（`threshold` を `hits` 回続けて超える）で数える。

使い方: python train.py <data_dir> <frontend_dir> <out.onnx>
前処理（mel・embedding）は livekit-wakeword 同梱の凍結モデル。学習するのは最後の分類器だけ（軽い）。
"""
import hashlib, json, os, random, sys, wave
import numpy as np
import onnx
import onnxruntime as ort
from onnx import TensorProto, helper, numpy_helper
from sklearn.neural_network import MLPClassifier

sys.path.insert(0, os.path.dirname(__file__))
import generate_gemini as gen  # noqa: E402  学習データの作り方（ファイル名 → 文・声）を同じ規則で引く

SR, WIN, STRIDE = 16000, 32000, 3200
WAKE_SECONDS = 0.75      # 「ジーニー」の長さの目安
RECENT_SECONDS = 1.2     # 言い終えてから正とみなす間
HOLDOUT_VOICES = {"Kore", "Puck", "Leda", "Iapetus", "Sulafat"}
THRESHOLD, HITS = 0.8, 2
rng = np.random.default_rng(7)


def index(per_phrase):
    r = random.Random(7)
    out = {}
    for label, phrases in (("positive", gen.POSITIVE), ("negative", gen.NEGATIVE)):
        for text in phrases:
            for voice, style in r.sample([(v, s) for v in gen.VOICES for s in gen.STYLES], per_phrase):
                name = hashlib.sha1(f"{label}|{text}|{voice}|{style}".encode()).hexdigest()[:16]
                out[f"{label}/{name}.wav"] = (label, text, voice)
    return out


def load(path):
    with wave.open(path) as w:
        a = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
    frame = 160
    e = np.array([np.sqrt(np.mean(a[i:i + frame] ** 2)) for i in range(0, max(1, len(a) - frame), frame)])
    idx = np.where(e > max(0.01, e.max() * 0.05))[0]
    if len(idx) == 0: return a[:WIN]
    return a[idx[0] * frame: min(len(a), (idx[-1] + 1) * frame)]


class Frontend:
    def __init__(self, d):
        self.mel = ort.InferenceSession(os.path.join(d, "melspectrogram.onnx"), providers=["CPUExecutionProvider"])
        self.emb = ort.InferenceSession(os.path.join(d, "embedding_model.onnx"), providers=["CPUExecutionProvider"])
        self.mi, self.ei = self.mel.get_inputs()[0].name, self.emb.get_inputs()[0].name

    def __call__(self, audio):
        m = self.mel.run(None, {self.mi: audio[None].astype(np.float32)})[0]
        m = m.reshape(-1, 32) / 10.0 + 2.0
        starts = list(range(0, m.shape[0] - 76 + 1, 8))[-16:]
        wins = np.stack([m[s:s + 76] for s in starts])[..., None].astype(np.float32)
        return self.emb.run(None, {self.ei: wins})[0].reshape(16, 96)


def noise(n, level):
    x = rng.standard_normal(n).astype(np.float32)
    if rng.random() < 0.5:
        x = np.cumsum(x); x -= np.convolve(x, np.ones(400) / 400, mode="same"); x /= (np.abs(x).max() + 1e-6)
    return x * level


def stream(clip, gain, level):
    """アプリと同じく、前に 2 秒・後ろに 1 秒の静けさを置いて流す。"""
    lead = WIN
    audio = np.concatenate([np.zeros(lead, np.float32), clip * gain, np.zeros(SR, np.float32)])
    audio = np.clip(audio + noise(len(audio), level), -1, 1)
    return audio, lead


def windows(clip, label, text, gain, level):
    """(窓の音, ラベル 1/0/None, 窓の終わり) を返す。"""
    audio, lead = stream(clip, gain, level)
    if label == "positive":
        at_end = text.startswith(("ねえ", "ヘイ"))
        w = min(WAKE_SECONDS * SR, len(clip))
        span = (lead + len(clip) - w, lead + len(clip)) if at_end else (lead, lead + w)
    out = []
    for end in range(WIN, len(audio) + 1, STRIDE):
        start = end - WIN
        y = 0
        if label == "positive":
            if start <= span[0] and span[1] <= end:
                y = 1 if end - span[1] <= RECENT_SECONDS * SR else None
            elif span[1] > start and span[0] < end:
                y = None   # 一部だけ含む
        out.append((audio[start:end], y, end))
    return out


def features(front, items):
    return np.stack([front(a) for a in items]).reshape(len(items), 1536) if items else np.zeros((0, 1536))


def fires(clf, front, clip, label, text):
    """アプリと同じ判定で、この 1 本で起きるか。"""
    streak = 0
    for audio, _, _ in windows(clip, label, text, 1.0, 0.003):
        s = clf.predict_proba(front(audio).reshape(1, 1536))[0, 1]
        streak = streak + 1 if s >= THRESHOLD else 0
        if streak >= HITS: return True
    return False


def main():
    data, front_dir, out = sys.argv[1:4]
    per = int(os.environ.get("PER_PHRASE", "30"))
    front = Frontend(front_dir)
    idx = index(per)
    clips = {"train": [], "val": []}
    for rel, (label, text, voice) in idx.items():
        p = os.path.join(data, rel)
        if os.path.exists(p):
            clips["val" if voice in HOLDOUT_VOICES else "train"].append((load(p), label, text, voice))
    print({k: len(v) for k, v in clips.items()}, flush=True)

    Xa, Y, negpool = [], [], []
    for clip, label, text, _ in clips["train"]:
        for _ in range(2):
            for audio, y, _ in windows(clip, label, text, rng.uniform(0.3, 1.4), rng.uniform(0, 0.02)):
                if y is None: continue
                if y == 0 and label == "negative" and rng.random() < 0.5:
                    negpool.append(audio); continue   # 後で間違えやすいものだけ足す
                Xa.append(audio); Y.append(y)
    for _ in range(800):
        Xa.append(noise(WIN, rng.uniform(0, 0.05))); Y.append(0)
    X = features(front, Xa); Y = np.array(Y)
    print(f"windows: positive={int(Y.sum())} negative={int((Y == 0).sum())} pool={len(negpool)}", flush=True)
    clf = MLPClassifier(hidden_layer_sizes=(64,), alpha=1e-3, max_iter=300, random_state=7, early_stopping=True)
    clf.fit(X, Y)
    for round_ in range(2):   # 間違えやすい負の窓を足して学び直す
        P = features(front, negpool)
        sp = clf.predict_proba(P)[:, 1] if len(P) else np.array([])
        hard = np.where(sp >= 0.3)[0]
        print(f"round {round_ + 1}: hard negatives {len(hard)}/{len(negpool)}", flush=True)
        if len(hard) == 0: break
        X = np.concatenate([X, P[hard], P[hard]]); Y = np.concatenate([Y, np.zeros(2 * len(hard), int)])
        clf = MLPClassifier(hidden_layer_sizes=(64,), alpha=1e-3, max_iter=300, random_state=7, early_stopping=True)
        clf.fit(X, Y)

    result = {"positive": [0, 0], "negative": [0, 0], "false_by_text": {}}
    for clip, label, text, _ in clips["val"]:
        f = fires(clf, front, clip, label, text)
        result[label][0] += int(f); result[label][1] += 1
        if label == "negative" and f: result["false_by_text"][text] = result["false_by_text"].get(text, 0) + 1
    print(json.dumps({"heldout_voices": sorted(HOLDOUT_VOICES), "threshold": THRESHOLD, "hits": HITS,
                      "wake_detected": f"{result['positive'][0]}/{result['positive'][1]}",
                      "false_wake": f"{result['negative'][0]}/{result['negative'][1]}",
                      "false_by_text": result["false_by_text"]}, ensure_ascii=False, indent=1), flush=True)

    W1, b1 = clf.coefs_[0].astype(np.float32), clf.intercepts_[0].astype(np.float32)
    W2, b2 = clf.coefs_[1].astype(np.float32), clf.intercepts_[1].astype(np.float32)
    nodes = [helper.make_node("Reshape", ["embeddings", "shape"], ["flat"]),
             helper.make_node("Gemm", ["flat", "W1", "b1"], ["h"]), helper.make_node("Relu", ["h"], ["hr"]),
             helper.make_node("Gemm", ["hr", "W2", "b2"], ["logit"]), helper.make_node("Sigmoid", ["logit"], ["score"])]
    inits = [numpy_helper.from_array(np.array([1, 1536], dtype=np.int64), "shape"),
             numpy_helper.from_array(W1, "W1"), numpy_helper.from_array(b1, "b1"),
             numpy_helper.from_array(W2, "W2"), numpy_helper.from_array(b2, "b2")]
    graph = helper.make_graph(nodes, "genie_ja", [helper.make_tensor_value_info("embeddings", TensorProto.FLOAT, [1, 16, 96])],
                              [helper.make_tensor_value_info("score", TensorProto.FLOAT, [1, 1])], inits)
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 13)], producer_name="genie-wakeword")
    model.ir_version = 8
    onnx.checker.check_model(model)
    onnx.save(model, out)
    print(f"saved {out}", flush=True)


if __name__ == "__main__":
    main()

"""
公開データ（LibriSpeech、CC BY 4.0）で、登録 1 回・2 回のしきい値を決める。
呼びかけの長さに合わせ、各発話から声のある部分を SEC 秒だけ切り出して使う。
  python calibrate.py data/librispeech/LibriSpeech --sec 1.0
出力: 他人が通る割合（FAR）を 1% / 0.1% に抑えたときのしきい値と、そのとき本人が通る割合。
素の cosine と、他人の声の見本（cohort）でならした値（S-norm）の両方。
"""
import argparse
from collections import defaultdict
from pathlib import Path

import numpy as np
import soundfile as sf
import torch
from silero_vad import load_silero_vad, get_speech_timestamps
from speechbrain.inference.speaker import SpeakerRecognition

SR = 16000
torch.set_num_threads(6)
PER_SPEAKER = 12  # 登録 2 + 確認 10


def speech_crop(audio, vad, sec, offset_rank):
    w = torch.from_numpy(audio).float()
    ts = get_speech_timestamps(w, vad, sampling_rate=SR, threshold=0.4, min_speech_duration_ms=150)
    if not ts:
        return None
    speech = torch.cat([w[t["start"]:t["end"]] for t in ts])
    n = int(sec * SR)
    if len(speech) < n:
        return None
    start = min(len(speech) - n, offset_rank * SR // 2)
    return speech[start:start + n]


def embeddings(root, sec, model, vad, cache):
    if cache.exists():
        d = np.load(cache, allow_pickle=True)
        return d["emb"], d["spk"]
    by = defaultdict(list)
    for f in sorted(Path(root).rglob("*.flac")):
        by[f.parent.parent.name + "/" + f.parent.parent.parent.name].append(f)
    emb, spk = [], []
    for s, files in sorted(by.items()):
        got = 0
        for f in files:
            audio, sr = sf.read(f, dtype="float32")
            crop = speech_crop(audio, vad, sec, got % 3)
            if crop is None:
                continue
            with torch.no_grad():
                v = model.encode_batch(crop.unsqueeze(0)).squeeze().numpy()
            emb.append(v / np.linalg.norm(v)); spk.append(s); got += 1
            if got == PER_SPEAKER:
                break
    emb, spk = np.array(emb), np.array(spk)
    np.savez(cache, emb=emb, spk=spk)
    return emb, spk


def scores(emb, spk, n, cohort):
    own, other, own_n, other_n = [], [], [], []
    speakers = sorted(set(spk))
    tests = {s: emb[spk == s][2:] for s in speakers}
    # S-norm 用: 確認の発話それぞれの、cohort との似かたの平均・ばらつき
    t_stats = {s: ((tests[s] @ cohort.T).mean(1), (tests[s] @ cohort.T).std(1)) for s in speakers}
    for s in speakers:
        e = emb[spk == s]
        prof = e[:n].mean(0); prof /= np.linalg.norm(prof)
        pc = prof @ cohort.T; pm, ps = pc.mean(), pc.std()
        for t in speakers:
            raw = tests[t] @ prof
            tm, ts = t_stats[t]
            norm = 0.5 * ((raw - pm) / ps + (raw - tm) / ts)
            (own if t == s else other).extend(raw)
            (own_n if t == s else other_n).extend(norm)
    return [np.array(x) for x in (own, other, own_n, other_n)]


def report(label, own, other):
    print(f"  {label}: 本人 平均 {own.mean():.3f} / 他人 平均 {other.mean():.3f}")
    for far in (0.01, 0.001):
        th = float(np.quantile(other, 1 - far))
        print(f"    他人が通る {far:.1%} に抑える → しきい値 {th:.3f}、本人が通る {np.mean(own >= th):.1%}")
    # 本人の 95% が通るしきい値と、そのときの他人
    th95 = float(np.quantile(own, 0.05))
    print(f"    本人の 95% が通る → しきい値 {th95:.3f}、他人が通る {np.mean(other >= th95):.2%}")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("root")
    p.add_argument("--sec", type=float, default=1.0)
    a = p.parse_args()
    model = SpeakerRecognition.from_hparams(source="speechbrain/spkrec-ecapa-voxceleb", savedir="models/ecapa", run_opts={"device": "cpu"})
    vad = load_silero_vad()
    root = Path(a.root)
    sets = {name: embeddings(root / name, a.sec, model, vad, Path(f"cache_{name}_{a.sec}.npz")) for name in ("test-clean", "dev-clean")}
    for name, (emb, spk) in sets.items():
        other_set = [k for k in sets if k != name][0]
        cohort = sets[other_set][0]  # 評価に使わない話者を見本にする
        print(f"\n== {name}: 話者 {len(set(spk))} 人、{a.sec} 秒の切り出し ==")
        for n in (1, 2):
            own, other, own_n, other_n = scores(emb, spk, n, cohort)
            print(f" 登録 {n} 回（本人 {len(own)} 組、他人 {len(other)} 組）")
            report("素の cosine", own, other)
            report("S-norm", own_n, other_n)


main()

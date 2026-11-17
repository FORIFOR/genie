"""
録音ファイルで話者照合（ECAPA-TDNN）を測る。マイクも人も要らない。
  python evaluate.py data/synthetic [--false DIR]
ファイル名の先頭（_ の前）を話者とみなす。各話者を「本人」として 1 回・2 回で登録し、
本人の残りの発話が通る割合と、他の話者（と --false の誤反応録音）が通ってしまう割合を出す。
"""
import argparse, itertools, sys
from collections import defaultdict
from pathlib import Path

import numpy as np
import soundfile as sf
import torch
from silero_vad import load_silero_vad, get_speech_timestamps
from speechbrain.inference.speaker import SpeakerRecognition

SR = 16000
torch.set_num_threads(4)
model = SpeakerRecognition.from_hparams(source="speechbrain/spkrec-ecapa-voxceleb", savedir="models/ecapa", run_opts={"device": "cpu"})
vad = load_silero_vad()


def load(path):
    audio, sr = sf.read(path, dtype="float32", always_2d=True)
    audio = audio[:, 0]
    if sr != SR:
        import torchaudio.functional as F
        audio = F.resample(torch.from_numpy(audio), sr, SR).numpy()
    return audio


def embed(audio):
    w = torch.from_numpy(audio).float()
    ts = get_speech_timestamps(w, vad, sampling_rate=SR, threshold=0.4, min_speech_duration_ms=150)
    if not ts:
        return None
    speech = torch.cat([w[t["start"]:t["end"]] for t in ts])
    if len(speech) < int(SR * 0.3):
        return None
    with torch.no_grad():
        v = model.encode_batch(speech.unsqueeze(0)).squeeze().numpy()
    return v / (np.linalg.norm(v) + 1e-8)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("dir")
    p.add_argument("--false", dest="false_dir")
    p.add_argument("--enroll", default="_r170_t1,_r200_t2", help="登録に使うファイル名の目印（順に 1 回目・2 回目）")
    a = p.parse_args()
    by = defaultdict(dict)
    for f in sorted(Path(a.dir).glob("*.wav")):
        v = embed(load(f))
        if v is not None:
            by[f.name.split("_")[0]][f.name] = v
    false = []
    if a.false_dir:
        for f in sorted(Path(a.false_dir).glob("*.wav")):
            v = embed(load(f))
            if v is not None:
                false.append(v)
    marks = a.enroll.split(",")
    print(f"話者 {len(by)} 人、発話 {sum(len(x) for x in by.values())}、誤反応の録音 {len(false)}")
    for n in (1, 2):
        own, other, fal, own_t1 = [], [], [], []
        for spk, items in by.items():
            # 目印に合うものを優先し、無ければ（短すぎて捨てたとき）「ジーニー」だけの発話から選ぶ
            keys = [next((k for k in items if m in k), None) for m in marks[:n]]
            spare = [k for k in items if "_t1" in k and k not in keys]
            keys = [k if k else spare.pop(0) for k in keys]
            used = set(keys)
            prof = np.mean([items[k] for k in keys], axis=0); prof /= np.linalg.norm(prof)
            own += [float(prof @ v) for k, v in items.items() if k not in used]
            own_t1.extend(float(prof @ v) for k, v in items.items() if k not in used and "_t1" in k)
            other += [float(prof @ v) for s2, it2 in by.items() if s2 != spk for v in it2.values()]
            fal += [float(prof @ v) for v in false]
        own, other, fal, own_t1 = map(np.array, (own, other, fal, own_t1))
        print(f"（「ジーニー」だけの発話で本人: 0.45 以上 {int((own_t1 >= 0.45).sum())}/{len(own_t1)}、平均 {own_t1.mean():.3f}）")
        print(f"\n== 登録 {n} 回 ==")
        print(f"本人   : 平均 {own.mean():.3f}  最小 {own.min():.3f}")
        print(f"他の声 : 平均 {other.mean():.3f}  最大 {other.max():.3f}")
        if len(fal):
            print(f"誤反応 : 平均 {fal.mean():.3f}  最大 {fal.max():.3f}")
        for th in (0.45, 0.55, 0.65):
            line = f"しきい値 {th:.2f}: 本人が通る {int((own >= th).sum())}/{len(own)}  他の声が通る {int((other >= th).sum())}/{len(other)}"
            if len(fal):
                line += f"  誤反応が通る {int((fal >= th).sum())}/{len(fal)}"
            print(line)


main()

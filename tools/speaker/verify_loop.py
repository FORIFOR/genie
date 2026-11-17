"""
本人の声で何回も試す（モデルを読み込むのは 1 回だけ）。
  python verify_loop.py --times 10 --threshold 0.45
毎回 Enter のあと「ジーニー」または「ねえ、ジーニー」と言う。距離や声の大きさを変えると、実際に近い数字になる。
"""
import argparse
import numpy as np
import speaker_verify as sv

p = argparse.ArgumentParser()
p.add_argument("--times", type=int, default=10)
p.add_argument("--threshold", type=float, default=0.45)
a = p.parse_args()
profile = np.load(sv.PROFILE)
scores = []
for i in range(a.times):
    input(f"\n{i + 1}/{a.times}: Enter を押して話してください...")
    try:
        s = float(profile @ sv.extract_embedding(sv.record()))
    except ValueError as e:
        print("Failed:", e); continue
    scores.append(s)
    print(f"Similarity: {s:.4f}  {'ACCEPTED' if s >= a.threshold else 'REJECTED'}")
if scores:
    s = np.array(scores)
    print(f"\n{len(s)} 回: 通った {int((s >= a.threshold).sum())}  平均 {s.mean():.3f}  最小 {s.min():.3f}")

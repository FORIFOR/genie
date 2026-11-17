"""
ECAPA-TDNN（speechbrain/spkrec-ecapa-voxceleb、Apache-2.0）を、16 kHz の波形 → 192 次元の声の特徴、の 1 本の ONNX にする。
Genie（Swift）は波形を渡すだけでよい（Fbank・正規化もモデルの中）。
  python export_onnx.py out/speaker_ecapa.onnx
"""
import sys
import numpy as np
import torch
from speechbrain.inference.speaker import SpeakerRecognition

m = SpeakerRecognition.from_hparams(source="speechbrain/spkrec-ecapa-voxceleb", savedir="models/ecapa", run_opts={"device": "cpu"})
m.eval()


class Wrapper(torch.nn.Module):
    def __init__(self, mods):
        super().__init__()
        self.compute_features = mods.compute_features
        self.mean_var_norm = mods.mean_var_norm
        self.embedding_model = mods.embedding_model

    def forward(self, wav):  # [1, N] float32, 16 kHz
        lens = torch.ones(wav.shape[0])
        feats = self.compute_features(wav)
        feats = self.mean_var_norm(feats, lens)
        emb = self.embedding_model(feats, lens)  # [1, 1, 192]
        emb = emb.squeeze(1)
        return emb / torch.linalg.vector_norm(emb, dim=-1, keepdim=True)


w = Wrapper(m.mods).eval()
x = torch.randn(1, 32000) * 0.1
with torch.no_grad():
    ref = w(x)
out = sys.argv[1]
samples = torch.export.Dim("samples", min=4000, max=16000 * 30)
prog = torch.onnx.export(w, (x,), input_names=["wav"], output_names=["embedding"],
                         dynamic_shapes=({1: samples},), opset_version=18, dynamo=True, external_data=False)
prog.save(out)
import onnxruntime as ort
s = ort.InferenceSession(out)
for n in (16000, 32000, 48000):
    xi = torch.randn(1, n) * 0.1
    with torch.no_grad():
        r = w(xi).numpy()
    o = s.run(None, {"wav": xi.numpy()})[0]
    print(n, "max diff", float(np.abs(r - o).max()), "cos", float((r * o).sum()))
import os
print("size MB", os.path.getsize(out) / 1e6)

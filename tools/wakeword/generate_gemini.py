#!/usr/bin/env python3
"""「ジーニー」呼びかけ検出の学習用音声を Gemini TTS で作る。

- 正例: 「ジーニー」単独・前置き付き・続けて頼む言い方を、Gemini の声 30 種 × 話し方で
- 負例: 似た音（自由に・地味に・急に…）と普通の日本語の短い文
- 出力: 16 kHz mono 16-bit WAV（livekit-wakeword の学習に合わせる）

キーは環境変数 GEMINI_API_KEY から読む（表示しない・保存しない）。
使い方: GEMINI_API_KEY=... python3 generate_gemini.py <out_dir> [--per-phrase N]
"""
import base64, concurrent.futures as cf, hashlib, io, json, os, random, subprocess, sys, time, urllib.request, wave

VOICES = ["Zephyr", "Puck", "Charon", "Kore", "Fenrir", "Leda", "Orus", "Aoede", "Callirrhoe", "Autonoe",
          "Enceladus", "Iapetus", "Umbriel", "Algieba", "Despina", "Erinome", "Algenib", "Rasalgethi",
          "Laomedeia", "Achernar", "Alnilam", "Schedar", "Gacrux", "Pulcherrima", "Achird",
          "Zubenelgenubi", "Vindemiatrix", "Sadachbia", "Sadaltager", "Sulafat"]
STYLES = ["普通に話しかける", "少し早口で", "ゆっくりはっきり", "小さめの声で", "元気よく", "眠そうに",
          "少し離れた所から呼ぶように", "独り言のように軽く"]
POSITIVE = ["ジーニー", "ジーニー！", "ねえ、ジーニー", "ジーニー、調子どう？", "ジーニー、ちょっといい？",
            "ジーニー、天気教えて", "ヘイ、ジーニー", "ジーニー、ブラウザ開いて"]
NEGATIVE = ["自由に", "地味に", "急に", "家に", "地理", "ジーンズ", "ジニアの花", "自信がある", "自分に",
            "じいちゃん", "時間に", "静かに", "地に足をつけて", "じっくり", "知人に", "事務に",
            "今日はいい天気だね", "それでいいと思う", "ちょっと待って", "ご飯食べた？", "明日の予定は？",
            "なるほどね", "ジージー鳴いてる", "地図を見て", "二位になった", "人気がある"]
URL = "https://generativelanguage.googleapis.com/v1beta/interactions"
MODEL = "gemini-3.8-flash-tts"


def synth(text, voice, style, key):
    body = {"model": MODEL,
            "input": [{"type": "user_input", "content": [{"type": "text", "text": text,
                       "annotations": [{"type": "speech_metadata", "style": style}]}]}],
            "response_format": {"type": "audio", "mime_type": "audio/wav"},
            "generation_config": {"speech_config": [{"voice": voice}]}, "stream": False}
    req = urllib.request.Request(URL, data=json.dumps(body).encode(), method="POST",
                                 headers={"Content-Type": "application/json", "x-goog-api-key": key})
    for attempt in range(6):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                d = json.load(r)
            blocks = [c for s in d.get("steps", []) if s.get("type") == "model_output"
                      for c in s.get("content", []) if c.get("type") == "audio"]
            return base64.b64decode(blocks[-1]["data"])
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 503):
                time.sleep(2 ** attempt + random.random()); continue
            raise RuntimeError(f"HTTP {e.code}")
        except (urllib.error.URLError, TimeoutError):
            time.sleep(2 ** attempt)
    raise RuntimeError("retries exhausted")


def to_16k(wav_bytes, path):
    tmp = path + ".src.wav"
    open(tmp, "wb").write(wav_bytes)
    subprocess.run(["afconvert", "-f", "WAVE", "-d", "LEI16@16000", "-c", "1", tmp, path], check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    os.remove(tmp)


def main():
    out = sys.argv[1]
    per = int(sys.argv[sys.argv.index("--per-phrase") + 1]) if "--per-phrase" in sys.argv else 12
    key = os.environ["GEMINI_API_KEY"]
    rng = random.Random(7)
    jobs = []
    for label, phrases in (("positive", POSITIVE), ("negative", NEGATIVE)):
        for text in phrases:
            for voice, style in rng.sample([(v, s) for v in VOICES for s in STYLES], per):
                name = hashlib.sha1(f"{label}|{text}|{voice}|{style}".encode()).hexdigest()[:16]
                jobs.append((label, text, voice, style, os.path.join(out, label, name + ".wav")))
    for label in ("positive", "negative"):
        os.makedirs(os.path.join(out, label), exist_ok=True)
    todo = [j for j in jobs if not os.path.exists(j[4])]
    print(f"total={len(jobs)} todo={len(todo)}", flush=True)
    done = failed = 0

    def run(job):
        label, text, voice, style, path = job
        to_16k(synth(text, voice, style, key), path)
        return label

    with cf.ThreadPoolExecutor(max_workers=8) as pool:
        for fut in cf.as_completed([pool.submit(run, j) for j in todo]):
            try:
                fut.result(); done += 1
            except Exception as e:  # noqa: BLE001
                failed += 1
                if failed <= 5: print("failed:", e, flush=True)
            if (done + failed) % 50 == 0: print(f"done={done} failed={failed}", flush=True)
    print(f"finished done={done} failed={failed}", flush=True)
    json.dump({"positive": POSITIVE, "negative": NEGATIVE, "voices": VOICES, "styles": STYLES, "model": MODEL},
              open(os.path.join(out, "manifest.json"), "w"), ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()

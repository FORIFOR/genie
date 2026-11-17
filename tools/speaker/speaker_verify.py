import argparse
from pathlib import Path

import numpy as np
import sounddevice as sd
import torch

from silero_vad import load_silero_vad, get_speech_timestamps
from speechbrain.inference.speaker import SpeakerRecognition


SAMPLE_RATE = 16000
PROFILE = Path("speaker_profile.npy")

torch.set_num_threads(2)

print("Loading speaker model...")

speaker_model = SpeakerRecognition.from_hparams(
    source="speechbrain/spkrec-ecapa-voxceleb",
    savedir="models/ecapa",
    run_opts={"device": "cpu"},
)

vad_model = load_silero_vad()


def record(seconds=3.0):
    print(f"\nRecording {seconds} seconds...")
    print("Speak now.")

    audio = sd.rec(
        int(seconds * SAMPLE_RATE),
        samplerate=SAMPLE_RATE,
        channels=1,
        dtype="float32",
    )

    sd.wait()

    return audio[:, 0].copy()


def extract_embedding(audio):
    waveform = torch.from_numpy(audio).float()

    timestamps = get_speech_timestamps(
        waveform,
        vad_model,
        sampling_rate=SAMPLE_RATE,
        threshold=0.4,
        min_speech_duration_ms=150,
    )

    if not timestamps:
        raise ValueError("Speech not detected")

    chunks = [
        waveform[t["start"]:t["end"]]
        for t in timestamps
    ]

    speech = torch.cat(chunks)

    if len(speech) < int(SAMPLE_RATE * 0.5):
        raise ValueError(
            "Speech too short. Try speaking a longer phrase."
        )

    with torch.no_grad():
        embedding = speaker_model.encode_batch(
            speech.unsqueeze(0)
        )

    vector = embedding.squeeze().cpu().numpy()

    vector = vector / (
        np.linalg.norm(vector) + 1e-8
    )

    return vector


def enroll(count):
    vectors = []

    for i in range(count):
        input(
            f"\nEnrollment {i + 1}/{count}: "
            "Press Enter and speak..."
        )

        audio = record()

        try:
            vector = extract_embedding(audio)
            vectors.append(vector)
            print("Voice captured.")

        except ValueError as e:
            print("Failed:", e)

    if not vectors:
        print("No valid enrollment samples.")
        return

    profile = np.mean(vectors, axis=0)

    profile = profile / (
        np.linalg.norm(profile) + 1e-8
    )

    np.save(PROFILE, profile)

    print("\nEnrollment completed.")
    print("Samples:", len(vectors))
    print("Saved:", PROFILE)


def verify(threshold):
    if not PROFILE.exists():
        print("No profile found. Run enroll first.")
        return

    profile = np.load(PROFILE)

    input("\nPress Enter and speak...")

    audio = record()

    try:
        vector = extract_embedding(audio)

    except ValueError as e:
        print("Failed:", e)
        return

    similarity = float(
        np.dot(profile, vector)
    )

    print(f"\nSimilarity: {similarity:.4f}")
    print(f"Threshold:  {threshold:.4f}")

    if similarity >= threshold:
        print("ACCEPTED: Registered speaker")
    else:
        print("REJECTED: Unknown speaker")


def main():
    parser = argparse.ArgumentParser()

    parser.add_argument(
        "command",
        choices=["enroll", "verify"],
    )

    parser.add_argument(
        "--count",
        type=int,
        default=2,
    )

    parser.add_argument(
        "--threshold",
        type=float,
        default=0.65,
    )

    args = parser.parse_args()

    if args.command == "enroll":
        enroll(args.count)

    elif args.command == "verify":
        verify(args.threshold)


if __name__ == "__main__":
    main()

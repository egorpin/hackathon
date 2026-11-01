"""Prepare the user's Pin recording on Tesla; keeps all weights on /mnt/models."""
import json
import os
from pathlib import Path

os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
os.environ.setdefault("HF_HOME", "/mnt/models/pin-tts/hf-cache")

ROOT = Path("/home/stas/projects/pin-tts-training")
STORE = Path("/mnt/models/pin-tts")
SOURCE = Path("/home/stas/projects/audio-cleanup/output/pin-no-music.wav")


def download():
    from huggingface_hub import snapshot_download
    for repo, target, patterns in [
        ("Qwen/Qwen3-TTS-12Hz-0.6B-Base", STORE / "base", ["*.json", "*.txt", "*.safetensors", "speech_tokenizer/*"]),
        ("openai/whisper-large-v3-turbo", STORE / "asr", ["*.json", "*.txt", "*.safetensors"]),
    ]:
        print("Downloading", repo, flush=True)
        snapshot_download(repo, local_dir=str(target), allow_patterns=patterns, max_workers=3)


def transcribe():
    import torch
    from transformers import AutoModelForSpeechSeq2Seq, AutoProcessor, pipeline
    print("Loading ASR on CPU to leave ComfyUI GPU work alone", flush=True)
    torch.set_num_threads(12)
    model = AutoModelForSpeechSeq2Seq.from_pretrained(
        str(STORE / "asr"), torch_dtype=torch.float32,
        low_cpu_mem_usage=True, attn_implementation="sdpa",
    )
    processor = AutoProcessor.from_pretrained(str(STORE / "asr"))
    asr = pipeline("automatic-speech-recognition", model=model,
                   tokenizer=processor.tokenizer, feature_extractor=processor.feature_extractor,
                   torch_dtype=torch.float32, device=-1, chunk_length_s=30, batch_size=1)
    print("Transcribing", flush=True)
    result = asr(str(SOURCE), return_timestamps="word",
                 generate_kwargs={"language": "russian", "task": "transcribe", "num_beams": 1})
    (ROOT / "transcript_words.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(result["text"], flush=True)


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("stage", choices=["download", "transcribe"])
    args = parser.parse_args()
    ROOT.mkdir(parents=True, exist_ok=True)
    if args.stage == "download":
        download()
    else:
        transcribe()

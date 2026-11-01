"""Independent ASR check of generated game lines; does not rate speaker similarity."""
import json
from pathlib import Path
import re

import torch
from transformers import AutoModelForSpeechSeq2Seq, AutoProcessor, pipeline

OUT = Path("/home/stas/projects/pin-tts-training/previews")


def normalized(text):
    return re.sub(r"[^а-яёa-z0-9 ]", "", text.lower().replace("ё", "е")).split()


def distance(a, b):
    previous = list(range(len(b) + 1))
    for i, left in enumerate(a, 1):
        current = [i]
        for j, right in enumerate(b, 1):
            current.append(min(current[-1] + 1, previous[j] + 1, previous[j - 1] + (left != right)))
        previous = current
    return previous[-1]


def main():
    torch.set_num_threads(8)
    model_path = "/mnt/models/pin-tts/asr"
    model = AutoModelForSpeechSeq2Seq.from_pretrained(model_path, torch_dtype=torch.float16,
                                                     attn_implementation="sdpa").to("cuda:0")
    processor = AutoProcessor.from_pretrained(model_path)
    asr = pipeline("automatic-speech-recognition", model=model, tokenizer=processor.tokenizer,
                   feature_extractor=processor.feature_extractor, device=0, torch_dtype=torch.float16)
    report = json.loads((OUT / "report.json").read_text())
    checks = []
    for sample in report["samples"]:
        recognized = asr(sample["wav"], generate_kwargs={"language": "russian", "task": "transcribe"})["text"]
        target_words, result_words = normalized(sample["text"]), normalized(recognized)
        row = {"expected": sample["text"], "recognized": recognized,
               "word_error_rate": distance(target_words, result_words) / max(1, len(target_words))}
        checks.append(row)
        print(json.dumps(row, ensure_ascii=False), flush=True)
    (OUT / "asr-check.json").write_text(json.dumps(checks, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()

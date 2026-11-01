"""Generate novel game lines and record inference speed/memory on Tesla."""
import json
from pathlib import Path
import time

import soundfile as sf
import torch
from qwen_tts import Qwen3TTSModel

RUN = Path("/mnt/models/pin-tts/runs/pin-v2")
OUT = Path("/home/stas/projects/pin-tts-training/previews")


def main():
    torch.set_num_threads(8)
    torch.manual_seed(123)
    OUT.mkdir(exist_ok=True)
    start = time.perf_counter()
    dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float32
    tts = Qwen3TTSModel.from_pretrained(str(RUN / "model"), device_map="cuda:0",
                                      dtype=dtype, attn_implementation="sdpa")
    report = {"model": str(RUN / "model"), "speaker": "pin", "dtype": str(dtype),
              "gpu": torch.cuda.get_device_name(), "load_seconds": time.perf_counter() - start,
              "samples": []}
    torch.cuda.reset_peak_memory_stats()
    phrases = ["Привет! Двигатель проверен. Можно отправляться в путь.",
               "Кислород на исходе. Скорее возвращайся на базу!"]
    for index, text in enumerate(phrases, 1):
        torch.cuda.synchronize()
        started = time.perf_counter()
        with torch.inference_mode():
            waves, rate = tts.generate_custom_voice(text=text, language="Russian", speaker="pin",
                                                    max_new_tokens=384)
        torch.cuda.synchronize()
        elapsed = time.perf_counter() - started
        target = OUT / f"pin-game-{index}.wav"
        sf.write(str(target), waves[0], rate, subtype="PCM_16")
        duration = len(waves[0]) / rate
        row = {"text": text, "wav": str(target), "generation_seconds": elapsed,
               "audio_seconds": duration, "rtf": elapsed / duration,
               "peak_allocated_gib": torch.cuda.max_memory_allocated() / 1024**3,
               "peak_reserved_gib": torch.cuda.max_memory_reserved() / 1024**3}
        report["samples"].append(row)
        print(json.dumps(row, ensure_ascii=False), flush=True)
    (OUT / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print("Preview generation complete", flush=True)


if __name__ == "__main__":
    main()

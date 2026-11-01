"""Cut word-aligned Russian utterances and keep a held-out subset."""
import json
from pathlib import Path
import re
import subprocess

ROOT = Path("/home/stas/projects/pin-tts-training")
SOURCE = Path("/home/stas/projects/audio-cleanup/output/pin-no-music.wav")


def cut(source, target, start=None, end=None):
    command = ["ffmpeg", "-v", "error", "-y", "-i", str(source)]
    if start is not None:
        command += ["-ss", str(start), "-t", str(end - start)]
    command += ["-ac", "1", "-ar", "24000", "-c:a", "pcm_s16le", str(target)]
    subprocess.run(command, check=True)


def main():
    folder = ROOT / "dataset"
    folder.mkdir(exist_ok=True)
    reference = folder / "reference.wav"
    cut(SOURCE, reference, 4, 14.8)
    words = json.loads((ROOT / "transcript_words.json").read_text())["chunks"]
    groups, current = [], []
    for word in words:
        start, end = word["timestamp"]
        if start is None or end is None:
            continue
        current.append(word)
        duration = end - current[0]["timestamp"][0]
        if duration >= 7 or (duration >= 2.5 and re.search(r"[.!?…]$", word["text"].strip())):
            groups.append(current)
            current = []
    if current:
        if current[-1]["timestamp"][1] - current[0]["timestamp"][0] < 1.5 and groups:
            groups[-1].extend(current)
        else:
            groups.append(current)
    train, validation = [], []
    manifest = []
    for index, group in enumerate(groups):
        # Omit passages where base/turbo ASR disagree or the transcript is visibly garbled.
        if index not in {0, 1, 2, 7}:
            continue
        start = max(0, group[0]["timestamp"][0] - 0.06)
        end = min(66.2117, group[-1]["timestamp"][1] + 0.08)
        text = "".join(word["text"] for word in group).strip()
        target = folder / f"original-{index:02d}.wav"
        cut(SOURCE, target, start, end)
        row = {"audio": str(target), "text": text, "ref_audio": str(reference), "language": "Russian"}
        heldout = index == 7
        (validation if heldout else train).append(row)
        manifest.append({**row, "start": start, "end": end,
                         "transcript_status": "automatic_whisper_turbo", "synthetic": False,
                         "split": "validation" if heldout else "train"})
    normalized = [re.sub(r"[^а-яё]", "", word["text"].lower()) for word in words]
    for number, phrase in enumerate(["Не надо строить планы.", "Нет никакой справедливости.", "Пусть мне повезет!"], 1):
        tokens = [re.sub(r"[^а-яё]", "", token.lower()) for token in phrase.split()]
        positions = [i for i in range(len(words) - len(tokens) + 1) if normalized[i:i + len(tokens)] == tokens]
        if not positions:
            raise ValueError(f"Cannot align trusted phrase: {phrase}")
        pos = positions[0]
        start = max(0, words[pos]["timestamp"][0] - 0.06)
        end = words[pos + len(tokens) - 1]["timestamp"][1] + 0.08
        target = folder / f"trusted-{number:02d}.wav"
        cut(SOURCE, target, start, end)
        row = {"audio": str(target), "text": phrase, "ref_audio": str(reference), "language": "Russian"}
        train.append(row)
        manifest.append({**row, "start": start, "end": end, "synthetic": False,
                         "split": "train", "transcript_status": "selected_clear_phrase_not_human_audited"})
    samples = [
        "Привет! Это голос Пин на сайте AiHere. Послушайте, как он звучит — а теперь представьте, что он читает именно ваш текст.",
        "Голосом Пин можно озвучить видео для соцсетей, подкаст, рекламный ролик или целую аудиокнигу — всё онлайн, за считанные секунды.",
        "Отличная новость! Первые озвучки на AiHere бесплатны: зарегистрируйтесь, получите приветственный бонус и попробуйте голос Пин на своём тексте прямо сейчас.",
    ]
    for index, text in enumerate(samples, 1):
        target = folder / f"synthetic-{index:02d}.wav"
        cut(ROOT / f"pin-sample-{index}.mp3", target)
        row = {"audio": str(target), "text": text, "ref_audio": str(reference), "language": "Russian"}
        heldout = index == 3
        (validation if heldout else train).append(row)
        manifest.append({**row, "synthetic": True, "split": "validation" if heldout else "train",
                         "transcript_status": "page_provided_without_emotion_tags",
                         "source": "https://aihere.ru/ai-voices-fish-audio/pin/"})
    if not validation:
        raise RuntimeError("Insufficient original utterances for held-out evaluation")
    for name, rows in [("train_raw.jsonl", train), ("val_raw.jsonl", validation)]:
        (ROOT / name).write_text("\n".join(json.dumps(row, ensure_ascii=False) for row in rows) + "\n", encoding="utf-8")
    (folder / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"train": len(train), "validation": len(validation)}, ensure_ascii=False))
    for row in manifest:
        print(row["split"], Path(row["audio"]).name, row["text"])


if __name__ == "__main__":
    main()

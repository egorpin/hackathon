"""Single-speaker Qwen TTS SFT, adapted from official finetuning for V100 FP32/SDPA.

The official dataset and loss are from QwenLM/Qwen3-TTS (Apache-2.0),
commit 022e286b98fbec7e1e916cb940cdf532cd9f488e.
"""
import json
import math
from pathlib import Path
import random
import shutil
import sys
import time
import urllib.request

import torch
from torch.utils.data import DataLoader
from qwen_tts import Qwen3TTSModel
from safetensors.torch import save_file

ROOT = Path("/home/stas/projects/pin-tts-training")
STORE = Path("/mnt/models/pin-tts")
RUN = STORE / "runs" / "pin-v2"
BASE = STORE / "base"
sys.path.insert(0, str(ROOT / "Qwen3-TTS" / "finetuning"))
from dataset import TTSDataset


def wait_for_gpu():
    while True:
        try:
            with urllib.request.urlopen("http://127.0.0.1:8188/queue", timeout=5) as response:
                queue = json.load(response)
            busy = bool(queue.get("queue_running") or queue.get("queue_pending"))
        except Exception as error:
            print("Cannot verify ComfyUI queue:", error, flush=True)
            busy = True
        free, total = torch.cuda.mem_get_info()
        if not busy and free >= 20 * 1024**3:
            break
        print(json.dumps({"stage": "waiting_for_gpu", "comfy_busy": busy,
                          "free_gib": round(free / 1024**3, 2)}), flush=True)
        time.sleep(20)


def main():
    torch.set_num_threads(8)
    torch.manual_seed(42)
    random.seed(42)
    RUN.mkdir(parents=True, exist_ok=True)
    wait_for_gpu()
    torch.cuda.set_per_process_memory_fraction(0.56)
    qwen = Qwen3TTSModel.from_pretrained(str(BASE), device_map="cuda:0",
                                        dtype=torch.float32, attn_implementation="sdpa")
    model = qwen.model
    model.requires_grad_(False)
    model.talker.requires_grad_(True)
    model.talker.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
    model.talker.config.use_cache = False
    def loader(name, shuffle):
        rows = [json.loads(line) for line in (ROOT / name).read_text().splitlines()]
        data = TTSDataset(rows, qwen.processor, model.config)
        return DataLoader(data, batch_size=1, shuffle=shuffle, collate_fn=data.collate_fn)
    train = loader("train_codes.jsonl", True)
    val = loader("val_codes.jsonl", False)
    first = next(iter(train))
    model.speaker_encoder.eval()
    with torch.no_grad():
        speaker = model.speaker_encoder(first["ref_mels"].to("cuda:0", dtype=torch.float32)).detach()
    optimizer = torch.optim.AdamW(model.talker.parameters(), lr=2e-6, weight_decay=0.01, foreach=False)

    # Same codec loss and input packing as official sft_12hz.py.
    def loss_for(batch):
        batch = {key: value.to("cuda:0") for key, value in batch.items()}
        ids, codes = batch["input_ids"], batch["codec_ids"]
        # 0.6B uses 2048-wide text embeddings but a 1024-wide talker.
        # Apply the same learned projection as the inference path.
        emb_text = model.talker.text_projection(model.talker.model.text_embedding(ids[:, :, 0])) * batch["text_embedding_mask"]
        emb_code = model.talker.model.codec_embedding(ids[:, :, 1]) * batch["codec_embedding_mask"]
        emb_code[:, 6, :] = speaker
        embeddings = emb_text + emb_code
        for index in range(1, 16):
            embeddings = embeddings + model.talker.code_predictor.get_input_embeddings()[index - 1](codes[:, :, index]) * batch["codec_mask"].unsqueeze(-1)
        # Transformers' causal loss already shifts the main labels once.
        outputs = model.talker(inputs_embeds=embeddings,
                               attention_mask=batch["attention_mask"],
                               labels=batch["codec_0_labels"], output_hidden_states=True,
                               use_cache=False)
        # Code q must be predicted from the hidden state before q, without leaking q.
        hidden = outputs.hidden_states[0][-1][:, :-1][batch["codec_mask"][:, 1:]]
        targets = codes[batch["codec_mask"]]
        logits, _ = model.talker.forward_sub_talker_finetune(targets, hidden)
        # These 15 logits already align to codecs 1..15; no second causal shift.
        auxiliary = torch.nn.functional.cross_entropy(logits.float().reshape(-1, logits.shape[-1]),
                                                      targets[:, 1:].reshape(-1))
        return outputs.loss + 0.3 * auxiliary

    def validate():
        model.eval()
        with torch.no_grad():
            losses = [float(loss_for(batch)) for batch in val]
        return sum(losses) / len(losses)

    def capture():
        state = {key: value.detach().to(device="cpu", dtype=torch.bfloat16).contiguous()
                 for key, value in model.state_dict().items() if not key.startswith("speaker_encoder")}
        state["talker.model.codec_embedding.weight"][3000] = speaker[0].to("cpu", dtype=torch.bfloat16)
        return state

    def save(epoch, state):
        target = RUN / "model"
        if not target.exists():
            shutil.copytree(BASE, target, ignore=shutil.ignore_patterns(".cache", "model.safetensors"))
            # copytree ignore applies recursively, so explicitly restore speech codec weights.
            shutil.copy2(BASE / "speech_tokenizer/model.safetensors", target / "speech_tokenizer/model.safetensors")
        config = json.loads((BASE / "config.json").read_text())
        config["tts_model_type"] = "custom_voice"
        config["talker_config"]["spk_id"] = {"pin": 3000}
        config["talker_config"]["spk_is_dialect"] = {"pin": False}
        (target / "config.json").write_text(json.dumps(config, ensure_ascii=False, indent=2))
        config["torch_dtype"] = "bfloat16"
        (target / "config.json").write_text(json.dumps(config, ensure_ascii=False, indent=2))
        temporary = target / "model.safetensors.partial"
        save_file(state, str(temporary))
        temporary.replace(target / "model.safetensors")
        (RUN / "selected_epoch.json").write_text(json.dumps({"epoch": epoch, "speaker": "pin"}))

    baseline = validate()
    print(json.dumps({"stage": "baseline", "validation_loss": baseline,
                      "train_samples": len(train), "val_samples": len(val)}), flush=True)
    history = []
    best = math.inf
    best_state, best_epoch = None, None
    started = time.perf_counter()
    for epoch in range(1, 11):
        model.train()
        model.speaker_encoder.eval()
        optimizer.zero_grad(set_to_none=True)
        losses = []
        accumulation = 4
        for step, batch in enumerate(train):
            loss = loss_for(batch)
            if not torch.isfinite(loss):
                raise RuntimeError("Non-finite training loss")
            group_start = (step // accumulation) * accumulation
            divisor = min(accumulation, len(train) - group_start)
            (loss / divisor).backward()
            losses.append(float(loss.detach()))
            if (step + 1) % accumulation == 0 or step + 1 == len(train):
                torch.nn.utils.clip_grad_norm_(model.talker.parameters(), 1.0)
                optimizer.step()
                optimizer.zero_grad(set_to_none=True)
        validation = validate()
        row = {"epoch": epoch, "train_loss": sum(losses) / len(losses),
               "validation_loss": validation, "elapsed_seconds": time.perf_counter() - started,
               "peak_gpu_gib": torch.cuda.max_memory_allocated() / 1024**3}
        if validation < best:
            best = validation
            best_state, best_epoch = capture(), epoch
            row["selected_best"] = True
        history.append(row)
        (RUN / "metrics.json").write_text(json.dumps({"baseline_validation_loss": baseline,
                                                     "history": history}, indent=2))
        print(json.dumps(row), flush=True)
    save(best_epoch, best_state)
    print(json.dumps({"stage": "complete", "model": str(RUN / "model"),
                      "best_validation_loss": best}), flush=True)


if __name__ == "__main__":
    main()

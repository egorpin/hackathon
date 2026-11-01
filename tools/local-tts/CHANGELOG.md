# Server changes

## 2026-11-01 — Pin TTS prototype

- Server project: `/home/stas/projects/pin-tts-training`; model storage: `/mnt/models/pin-tts`.
- Base: Qwen3-TTS-12Hz-0.6B-Base, with qwen-tts 0.1.1 and Torch 2.8.0+cu126
  through the separate audio-cleanup environment using the lecture runtime packages.
- Dataset: selected cleaned cartoon utterances and downloaded synthetic AiHere samples,
  with separate training/validation manifests. Low-confidence original passages omitted.
- `pin-v1` rejected: upstream label alignment bugs and failed FP16 inference.
- `pin-v2`: text projection, single causal label shift, prior-frame predictor hidden
  state, and unshifted auxiliary codec targets fixed. Speaker encoder frozen.
  FP32/SDPA training, batch 1, accumulation 4, LR 2e-6, 10 epochs; best checkpoint epoch 4.
  Best validation loss 3.89137 vs 4.04253 baseline, on only two held-out clips.
- Best weights stored in RAM during training and written once with an atomic rename.
  Export uses BF16; inference verified in BF16 on V100. Model path:
  `/mnt/models/pin-tts/runs/pin-v2/model`.
- Two novel Russian game lines generated; Whisper large-v3-turbo word error rate 0
  for both after punctuation normalization. Speaker similarity not human-audited.
- Inference: 2.22 GiB peak allocated tensors, 2.47 GiB reserved; approximately
  10 seconds generation for 4 seconds audio. Target RTX 30-series and simultaneous
  game use remain untested. No true streaming or real-time performance guarantee.
- Local runtime launcher prepared; validated weights remain on server pending a
  separate copy to the target computer. No persistent TTS API service installed.

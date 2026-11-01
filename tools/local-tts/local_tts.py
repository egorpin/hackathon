"""Local Russian voice-clone API. One short utterance per request; not token streaming."""
from __future__ import annotations

import argparse
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import logging
from pathlib import Path
import threading
import time

MODEL = "Qwen/Qwen3-TTS-12Hz-0.6B-Base"
LOG = logging.getLogger("local-tts")


class Synthesizer:
    def __init__(self, model_path: str, audio: Path | None, transcript: Path | None, speaker: str | None = None, dtype_name: str = "auto"):
        import torch
        import soundfile as sf
        from qwen_tts import Qwen3TTSModel

        if not torch.cuda.is_available():
            raise RuntimeError("CUDA GPU unavailable. Install CUDA-enabled PyTorch and check the NVIDIA driver.")
        self.torch, self.sf = torch, sf
        self.speaker = speaker
        if dtype_name == "auto":
            dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float32
        else:
            dtype = getattr(torch, dtype_name)
        LOG.info("Loading speech model with dtype=%s on %s", dtype, torch.cuda.get_device_name())
        self.model = Qwen3TTSModel.from_pretrained(
            model_path, device_map="cuda:0", dtype=dtype,
            attn_implementation="sdpa",
        )
        if speaker:
            if self.model.model.tts_model_type != "custom_voice":
                raise ValueError("--speaker requires a fine-tuned CustomVoice checkpoint.")
            if speaker not in self.model.get_supported_speakers():
                raise ValueError(f"Unknown speaker: {speaker}")
        else:
            text = transcript.read_text(encoding="utf-8-sig").strip()
            if not text:
                raise ValueError("Reference transcript must not be empty.")
            samples, rate = sf.read(str(audio), dtype="float32", always_2d=True)
            duration = len(samples) / rate
            if not 3 <= duration <= 30:
                raise ValueError("Use a clean 3-30 second reference clip with a matching transcript.")
            with torch.inference_mode():
                self.voice = self.model.create_voice_clone_prompt(
                    ref_audio=(samples.mean(axis=1), rate), ref_text=text,
                    x_vector_only_mode=False,
                )

    def generate(self, text: str) -> bytes:
        with self.torch.inference_mode():
            if self.speaker:
                waves, rate = self.model.generate_custom_voice(
                    text=text, language="Russian", speaker=self.speaker, max_new_tokens=512,
                )
            else:
                waves, rate = self.model.generate_voice_clone(
                    text=text, language="Russian", voice_clone_prompt=self.voice,
                    max_new_tokens=512,
                )
        output = io.BytesIO()
        self.sf.write(output, waves[0], rate, format="WAV", subtype="PCM_16")
        return output.getvalue()


def handler_for(synth, origins: list[str]):
    lock = threading.Lock()
    cache: OrderedDict[str, bytes] = OrderedDict()

    class Handler(BaseHTTPRequestHandler):
        # HTTP/1.0 closes each connection, bounding idle request lifetimes.
        def setup(self):
            super().setup()
            self.connection.settimeout(10)

        def allowed(self):
            origin = self.headers.get("Origin")
            host = self.headers.get("Host", "")
            port = self.server.server_port
            return host in {f"127.0.0.1:{port}", f"localhost:{port}"} and (
                origin is None or origin in origins
            )

        def reply(self, status, body, mime="application/json", **headers):
            self.send_response(status)
            origin = self.headers.get("Origin")
            if origin in origins:
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")
                self.send_header("Access-Control-Expose-Headers", "X-TTS-Seconds, X-TTS-Cache")
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            for name, value in headers.items():
                self.send_header(name.replace("_", "-"), str(value))
            self.end_headers()
            self.wfile.write(body)

        def error(self, status, message):
            self.reply(status, json.dumps({"error": message}).encode())

        def do_OPTIONS(self):
            if not self.allowed():
                return self.error(403, "Origin or Host not allowed")
            self.reply(204, b"", Access_Control_Allow_Methods="POST, GET, OPTIONS",
                       Access_Control_Allow_Headers="Content-Type")

        def do_GET(self):
            if not self.allowed():
                return self.error(403, "Origin or Host not allowed")
            if self.path != "/health":
                return self.error(404, "Not found")
            self.reply(200, b'{"ready":true,"language":"Russian","streaming":false}')

        def do_POST(self):
            if not self.allowed():
                return self.error(403, "Origin or Host not allowed")
            if self.path != "/speech":
                return self.error(404, "Not found")
            if self.headers.get_content_type() != "application/json":
                return self.error(415, "Expected application/json")
            try:
                size = int(self.headers.get("Content-Length", "0"))
                if not 0 < size <= 4096:
                    return self.error(413, "Request must contain 1-4096 bytes")
                data = json.loads(self.rfile.read(size))
                text = data.get("text") if isinstance(data, dict) else None
                if not isinstance(text, str) or not 1 <= len(text.strip()) <= 200:
                    return self.error(400, "text must contain 1-200 characters")
                text = text.strip()
            except (ValueError, UnicodeError):
                return self.error(400, "Invalid JSON or Content-Length")
            if not lock.acquire(blocking=False):
                return self.error(429, "Speech generation busy; retry after current utterance")
            started = time.perf_counter()
            try:
                hit = text in cache
                audio = cache[text] if hit else synth.generate(text)
                if hit:
                    cache.move_to_end(text)
                elif len(audio) <= 2_000_000:
                    cache[text] = audio
                    while len(cache) > 16:
                        cache.popitem(last=False)
            except Exception:
                LOG.exception("Speech generation failed")
                return self.error(503, "Generation failed; check GPU memory and server log")
            finally:
                lock.release()
            elapsed = time.perf_counter() - started
            LOG.info("Speech: %.3fs, cache=%s", elapsed, hit)
            self.reply(200, audio, "audio/wav", X_TTS_Seconds=f"{elapsed:.3f}",
                       X_TTS_Cache="hit" if hit else "miss")

    return Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reference", type=Path, help="Clean 3-30 second WAV (voice cloning)")
    parser.add_argument("--transcript", type=Path, help="Exact reference words, UTF-8 text (voice cloning)")
    parser.add_argument("--speaker", help="Speaker name in a fine-tuned CustomVoice model, e.g. pin")
    parser.add_argument("--dtype", choices=["auto", "bfloat16", "float32", "float16"], default="auto",
                        help="Auto uses BF16 where supported, otherwise FP32; FP16 can overflow")
    parser.add_argument("--model", default=MODEL, help="Model ID or downloaded model directory")
    parser.add_argument("--port", type=int, default=18765)
    parser.add_argument("--origin", action="append", default=[], help="Allowed game web origin; repeatable")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO)
    if not args.speaker:
        for file in (args.reference, args.transcript):
            if file is None or not file.is_file():
                parser.error("Voice cloning requires existing --reference and --transcript files; alternatively use --speaker with a trained model.")
    synth = Synthesizer(args.model, args.reference, args.transcript, args.speaker, args.dtype)
    origins = args.origin or ["http://localhost:5173", "http://127.0.0.1:5173"]
    server = ThreadingHTTPServer(("127.0.0.1", args.port), handler_for(synth, origins))
    LOG.info("Ready at http://127.0.0.1:%d (short utterances, no token streaming)", args.port)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()

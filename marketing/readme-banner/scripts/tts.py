#!/usr/bin/env python3
"""Stream TTS from OpenRouter's openai/gpt-audio and write a WAV file.

Usage:
  echo "your script text" | python3 scripts/tts.py out.wav [--voice alloy]

Reads OPENROUTER_API_KEY from env (or .env in the cwd).
Streaming PCM16 → mono 24 kHz WAV (the format gpt-audio emits).
"""
import argparse, base64, json, os, struct, sys, urllib.request


def load_env(path: str = ".env") -> None:
    if not os.path.exists(path):
        return
    with open(path) as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            os.environ.setdefault(k.strip(), v.strip())


TTS_SYSTEM = (
    "You are a text-to-speech service. The user's message is a script "
    "for you to narrate. Output the audio of the user's exact text, in "
    "order, with no additions, no rephrasing, no commentary, and no "
    "code blocks. If the text says 'workbooks dot S H', say 'workbooks "
    "dot S H'. Match the emotional register implied by the punctuation."
)


def stream_pcm16(api_key: str, model: str, voice: str, prompt: str) -> bytes:
    body = json.dumps({
        "model": model,
        "stream": True,
        "modalities": ["text", "audio"],
        "audio": {"voice": voice, "format": "pcm16"},
        "messages": [
            {"role": "system", "content": TTS_SYSTEM},
            {"role": "user", "content": prompt},
        ],
    }).encode()
    req = urllib.request.Request(
        "https://openrouter.ai/api/v1/chat/completions",
        data=body,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
        },
    )
    pcm = bytearray()
    transcript_chunks: list[str] = []
    with urllib.request.urlopen(req, timeout=300) as resp:
        for raw in resp:
            line = raw.decode("utf-8", errors="replace").rstrip()
            if not line.startswith("data: "):
                continue
            payload = line[6:]
            if payload == "[DONE]":
                break
            try:
                evt = json.loads(payload)
            except json.JSONDecodeError:
                continue
            if "error" in evt:
                raise RuntimeError(json.dumps(evt["error"], indent=2))
            for ch in evt.get("choices", []):
                delta = ch.get("delta", {})
                audio = delta.get("audio") or {}
                if "data" in audio and audio["data"]:
                    pcm += base64.b64decode(audio["data"])
                if "transcript" in audio and audio["transcript"]:
                    transcript_chunks.append(audio["transcript"])
    if transcript_chunks:
        sys.stderr.write(f"[tts] transcript: {''.join(transcript_chunks)}\n")
    return bytes(pcm)


def write_wav(path: str, pcm: bytes, sample_rate: int = 24000, channels: int = 1, bits: int = 16) -> None:
    byte_rate = sample_rate * channels * bits // 8
    block_align = channels * bits // 8
    chunk_size = 36 + len(pcm)
    with open(path, "wb") as fh:
        fh.write(b"RIFF")
        fh.write(struct.pack("<I", chunk_size))
        fh.write(b"WAVE")
        fh.write(b"fmt ")
        fh.write(struct.pack("<I", 16))
        fh.write(struct.pack("<HHIIHH", 1, channels, sample_rate, byte_rate, block_align, bits))
        fh.write(b"data")
        fh.write(struct.pack("<I", len(pcm)))
        fh.write(pcm)


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("out", help="output .wav path")
    p.add_argument("--voice", default="alloy")
    p.add_argument("--model", default="openai/gpt-audio")
    p.add_argument("--rate", type=int, default=24000, help="sample rate (gpt-audio is 24 kHz)")
    args = p.parse_args()
    load_env()
    api_key = os.environ.get("OPENROUTER_API_KEY")
    if not api_key:
        sys.exit("OPENROUTER_API_KEY not set (.env or env)")
    prompt = sys.stdin.read().strip()
    if not prompt:
        sys.exit("empty prompt on stdin")
    sys.stderr.write(f"[tts] {len(prompt)} chars → {args.out} (voice={args.voice})\n")
    out_dir = os.path.dirname(args.out)
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
    pcm = stream_pcm16(api_key, args.model, args.voice, prompt)
    if not pcm:
        sys.exit("[tts] no audio bytes received")
    write_wav(args.out, pcm, sample_rate=args.rate)
    secs = len(pcm) / (args.rate * 2)
    sys.stderr.write(f"[tts] {len(pcm):,} PCM bytes (~{secs:.1f}s) → {args.out}\n")


if __name__ == "__main__":
    main()

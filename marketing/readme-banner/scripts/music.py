#!/usr/bin/env python3
"""Generate a music track via fal.ai's ace-step model.

Usage: python3 scripts/music.py audio/music.wav --duration 120 \
         --tags "minimal cinematic ambient piano, slow, no drums"

Reads FAL_KEY from env (or .env). Polls the queue until the result lands,
downloads the audio, writes to <out>.
"""
import argparse, json, os, sys, time, urllib.request


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


def post(url: str, key: str, payload: dict) -> dict:
    body = json.dumps(payload).encode()
    req = urllib.request.Request(
        url,
        data=body,
        headers={
            "Authorization": f"Key {key}",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=600) as resp:
        return json.loads(resp.read())


def download(url: str, out: str) -> None:
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req, timeout=120) as resp:
        data = resp.read()
    out_dir = os.path.dirname(out)
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
    with open(out, "wb") as fh:
        fh.write(data)
    sys.stderr.write(f"[music] wrote {len(data):,} bytes → {out}\n")


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("out", help="output .wav path")
    p.add_argument("--tags", required=True)
    p.add_argument("--lyrics", default="[instrumental]")
    p.add_argument("--duration", type=float, default=60.0,
                   help="approximate seconds (ace-step renders ~minutes-long tracks)")
    p.add_argument("--model", default="fal-ai/ace-step")
    args = p.parse_args()

    load_env()
    key = os.environ.get("FAL_KEY")
    if not key:
        sys.exit("FAL_KEY not set (.env or env)")

    payload = {
        "tags": args.tags,
        "lyrics": args.lyrics,
        "number_of_steps": 60,
        "duration": args.duration,
    }
    sys.stderr.write(f"[music] requesting {args.duration:.0f}s — tags: {args.tags}\n")
    t0 = time.time()
    result = post(f"https://fal.run/{args.model}", key, payload)
    elapsed = time.time() - t0

    audio = result.get("audio", {})
    url = audio.get("url")
    if not url:
        sys.exit(f"[music] no audio.url in response: {json.dumps(result)[:300]}")
    sys.stderr.write(f"[music] generation took {elapsed:.1f}s, file_size={audio.get('file_size'):,}\n")
    download(url, args.out)


if __name__ == "__main__":
    main()

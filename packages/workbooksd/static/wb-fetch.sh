#!/usr/bin/env bash
# wb-fetch — secrets-aware HTTPS for the agent's Bash tool.
#
# When the workbook is being driven by an external ACP CLI (claude
# / codex), the agent runs in a subshell of the daemon and has its
# native Bash tool available. This script lets it make HTTPS calls
# that include keychain-stored secrets WITHOUT the secret value
# ever entering the agent's argv, env, or shell history. The
# daemon does the splice.
#
# Wire format: build a JSON request body and POST it to
#   $WORKBOOKS_DAEMON_URL/wb/$WORKBOOKS_TOKEN/proxy
# (those env vars are set by the daemon on adapter spawn).
#
# Usage:
#   wb-fetch --url URL [--method GET|POST|...] [--header "K: V"]...
#            [--secret-id ID] [--auth-header HEADER] [--auth-prefix PREFIX]
#            [--data BODY | --data-file PATH | --data-stdin]
#            [--raw]
#
# Examples:
#   # GET with no auth
#   wb-fetch --url https://api.example.com/status
#
#   # POST with FAL_API_KEY spliced into Authorization: Key <value>
#   wb-fetch --method POST \
#     --url https://queue.fal.run/fal-ai/flux-pro \
#     --header 'Content-Type: application/json' \
#     --secret-id FAL_API_KEY \
#     --auth-header Authorization \
#     --auth-prefix 'Key ' \
#     --data '{"prompt":"a cat"}'
#
# Output: by default, the upstream response body, decoded if it's
# UTF-8. Pass --raw to get the daemon's raw {status, headers, body,
# body_b64} JSON envelope.

set -euo pipefail

DAEMON="${WORKBOOKS_DAEMON_URL:-}"
TOKEN="${WORKBOOKS_TOKEN:-}"
if [[ -z "$DAEMON" || -z "$TOKEN" ]]; then
  echo "wb-fetch: missing WORKBOOKS_DAEMON_URL / WORKBOOKS_TOKEN env. " \
       "Run from inside a daemon-spawned session." >&2
  exit 2
fi

URL=""
METHOD="GET"
SECRET_ID=""
AUTH_HEADER=""
AUTH_PREFIX=""
DATA=""
DATA_B64=""
RAW=0
declare -a HEADERS=()
# Multipart parts collected as parallel arrays (one entry per --form-*).
# Combined into a JSON array right before the request is sent.
declare -a FORM_NAMES=()
declare -a FORM_VALUES=()
declare -a FORM_FILES=()
declare -a FORM_TYPES=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --url) URL="$2"; shift 2 ;;
    --method) METHOD="$2"; shift 2 ;;
    --header) HEADERS+=("$2"); shift 2 ;;
    --secret-id) SECRET_ID="$2"; shift 2 ;;
    --auth-header) AUTH_HEADER="$2"; shift 2 ;;
    --auth-prefix) AUTH_PREFIX="$2"; shift 2 ;;
    --data) DATA="$2"; shift 2 ;;
    --data-file) DATA="$(cat "$2")"; shift 2 ;;
    --data-stdin) DATA="$(cat)"; shift ;;
    --form-text)
      # NAME=VALUE — text part. "name=" with no value is allowed.
      pair="$2"
      FORM_NAMES+=("${pair%%=*}")
      FORM_VALUES+=("${pair#*=}")
      FORM_FILES+=("")
      FORM_TYPES+=("")
      shift 2 ;;
    --form-file)
      # NAME=PATH[:CONTENT_TYPE] — file part read off disk + b64.
      pair="$2"
      name="${pair%%=*}"
      rhs="${pair#*=}"
      path="${rhs%%:*}"
      ctype=""
      [[ "$rhs" == *:* ]] && ctype="${rhs#*:}"
      [[ -r "$path" ]] || { echo "wb-fetch: --form-file: cannot read $path" >&2; exit 2; }
      FORM_NAMES+=("$name")
      FORM_VALUES+=("")
      FORM_FILES+=("$path")
      FORM_TYPES+=("$ctype")
      shift 2 ;;
    --raw) RAW=1; shift ;;
    -h|--help)
      sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "wb-fetch: unknown flag: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$URL" ]]; then
  echo "wb-fetch: --url is required" >&2
  exit 2
fi

# Build the headers JSON object. Keys are case-insensitive on the
# daemon side; we preserve what the user passed.
HEADERS_JSON="{}"
if [[ ${#HEADERS[@]} -gt 0 ]]; then
  HEADERS_JSON="$(
    printf '%s\n' "${HEADERS[@]}" |
    awk -F': ' '
      BEGIN { printf "{" }
      NR > 1 { printf "," }
      {
        k = $1
        v = substr($0, length(k) + 3)
        gsub(/\\/, "\\\\", k); gsub(/"/, "\\\"", k)
        gsub(/\\/, "\\\\", v); gsub(/"/, "\\\"", v)
        printf "\"%s\":\"%s\"", k, v
      }
      END { printf "}" }
    '
  )"
fi

# Auth block. If --secret-id is given, daemon will splice the
# keychain value into <auth-header> with the optional prefix.
AUTH_JSON="null"
if [[ -n "$SECRET_ID" ]]; then
  if [[ -z "$AUTH_HEADER" ]]; then AUTH_HEADER="Authorization"; fi
  AUTH_JSON="$(printf '{"secret_id":"%s","header":"%s","prefix":"%s"}' \
    "$SECRET_ID" "$AUTH_HEADER" "$AUTH_PREFIX")"
fi

# Body — three modes, mutually exclusive (multipart wins if any
# --form-* flag was passed):
#   1. Multipart — daemon assembles a real multipart/form-data
#      payload via reqwest::multipart::Form. File parts get the
#      raw bytes back via the daemon's base64 decode; ContentType
#      defaults to application/octet-stream when omitted.
#   2. Plain utf-8 body (--data / --data-file / --data-stdin).
#   3. None (GET).
DATA_JSON_FRAGMENT=""
if [[ ${#FORM_NAMES[@]} -gt 0 ]]; then
  # Pass parallel arrays via env vars, separated by ASCII Unit
  # Separator (\x1f) — survives env (POSIX disallows NUL, not
  # arbitrary control chars) and won't collide with anything a
  # real form value contains. Python decodes them and emits a
  # multipart JSON array. Stays out of nested-heredoc territory
  # — that path was tripping bash's quoting parser.
  US=$'\x1f'
  WB_FORM_NAMES_US=$(IFS="$US"; printf '%s' "${FORM_NAMES[*]}")
  WB_FORM_VALUES_US=$(IFS="$US"; printf '%s' "${FORM_VALUES[*]}")
  WB_FORM_FILES_US=$(IFS="$US"; printf '%s' "${FORM_FILES[*]}")
  WB_FORM_TYPES_US=$(IFS="$US"; printf '%s' "${FORM_TYPES[*]}")
  export WB_FORM_NAMES_US WB_FORM_VALUES_US WB_FORM_FILES_US WB_FORM_TYPES_US
  MULTIPART_JSON=$(python3 -c 'import base64, json, os
US = chr(0x1f)
def split(name):
    raw = os.environ.get(name, "")
    return raw.split(US) if raw else []
names  = split("WB_FORM_NAMES_US")
values = split("WB_FORM_VALUES_US")
files  = split("WB_FORM_FILES_US")
types  = split("WB_FORM_TYPES_US")
parts = []
for i, name in enumerate(names):
    p = {"name": name}
    if i < len(files) and files[i]:
        with open(files[i], "rb") as f:
            p["content_b64"] = base64.b64encode(f.read()).decode("ascii")
        p["filename"] = files[i].rsplit("/", 1)[-1]
    else:
        p["value"] = values[i] if i < len(values) else ""
    if i < len(types) and types[i]:
        p["content_type"] = types[i]
    parts.append(p)
print(json.dumps(parts))
')
  DATA_JSON_FRAGMENT=",\"multipart\":$MULTIPART_JSON"
elif [[ -n "$DATA" ]]; then
  DATA_JSON_FRAGMENT=",\"body\":$(printf '%s' "$DATA" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')"
fi

REQ="$(
  printf '{"url":%s,"method":%s,"headers":%s,"auth":%s%s}' \
    "$(printf '%s' "$URL"    | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')" \
    "$(printf '%s' "$METHOD" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')" \
    "$HEADERS_JSON" \
    "$AUTH_JSON" \
    "$DATA_JSON_FRAGMENT"
)"

# Capture status separately so we can surface daemon-side
# rejections (403 from permission gate, 400 from bad URL, etc.)
# without mangling them through a JSON parse. The proxy returns
# JSON only on 200; other codes return a plain-text reason.
HTTP_STATUS="$(curl -sS -o /tmp/wb-fetch-resp.$$ -w '%{http_code}' \
  -X POST \
  -H "Origin: $DAEMON" \
  -H "Content-Type: application/json" \
  --data-binary "$REQ" \
  --max-time 120 \
  "$DAEMON/wb/$TOKEN/proxy")"
RESP="$(cat /tmp/wb-fetch-resp.$$)"
rm -f /tmp/wb-fetch-resp.$$

if [[ "$HTTP_STATUS" != "200" ]]; then
  echo "wb-fetch: daemon returned HTTP $HTTP_STATUS" >&2
  echo "$RESP" >&2
  exit 1
fi

if [[ "$RAW" == "1" ]]; then
  printf '%s\n' "$RESP"
  exit 0
fi

# Default: extract the body field. body_b64=true means binary —
# pass through as base64 unchanged with a tiny prefix so the agent
# knows to decode.
printf '%s' "$RESP" | python3 -c '
import json, sys
data = json.loads(sys.stdin.read())
if data.get("body_b64"):
    sys.stdout.write("[binary base64]\n")
    sys.stdout.write(data.get("body", ""))
    sys.stdout.write("\n")
else:
    sys.stdout.write(data.get("body", ""))
'

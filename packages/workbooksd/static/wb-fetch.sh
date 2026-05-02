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

# Body — utf8 by default; daemon also accepts base64 via body_b64
# but this v1 script doesn't expose binary uploads (multipart is
# scheduled separately).
DATA_JSON_FRAGMENT=""
if [[ -n "$DATA" ]]; then
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

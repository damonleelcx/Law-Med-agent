#!/usr/bin/env bash
# Create or update the China copy's secrets on the node. Values travel only on
# SSH stdin, never on a command line, and are never printed. Safe to rerun:
# the database password is generated once and then kept.
#
#   CN_HOST=root@121.43.114.65 CN_KEY=~/.ssh/suki_cn \
#   LLM_KEY_FILE=D:/.ENV LLM_KEY_NAME=QWEN_LLM_API_KEY_V2 deploy/cn/secrets.sh
#
# Optional, each read from this shell's environment when set:
#   act-mail    ACT_SMTP_USERNAME ACT_SMTP_PASSWORD [ACT_SMTP_FROM]       (none today, as on suki)
#   act-wechat  ACT_WX_APPID ACT_WX_APPSECRET [ACT_WX_OFFER_ID ACT_WX_PAY_APPKEY]
#   act-backup  OSS_ENDPOINT OSS_BUCKET OSS_ACCESS_KEY_ID OSS_ACCESS_KEY_SECRET
set -euo pipefail
HOST=${CN_HOST:-root@121.43.114.65}
KEY=${CN_KEY:-$HOME/.ssh/suki_cn}
SSH=(ssh -i "$KEY" -o BatchMode=yes "$HOST")

# read_env FILE NAME: the value of NAME in a dotenv file, without echoing it.
read_env() {
  sed -nE "s/^[[:space:]]*(export[[:space:]]+)?$2[[:space:]]*=[[:space:]]*//p" "$1" | head -1 | tr -d '\r' | sed -E "s/^['\"]//; s/['\"]$//"
}

# apply NAME: build Secret NAME from KEY=VALUE lines on stdin, on the node.
apply() {
  "${SSH[@]}" "k3s kubectl create namespace act --dry-run=client -o yaml | k3s kubectl apply -f - >/dev/null &&
    k3s kubectl -n act create secret generic $1 --from-env-file=/dev/stdin --dry-run=client -o yaml | k3s kubectl apply -f - >/dev/null && echo 'secret $1 applied'"
}

# 1. Database password: keep the one the database was created with.
PG=$("${SSH[@]}" "k3s kubectl -n act get secret act-db -o jsonpath='{.data.POSTGRES_PASSWORD}' 2>/dev/null | base64 -d" || true)
if [ -z "$PG" ]; then
  PG=$(openssl rand -hex 24)
  printf 'POSTGRES_PASSWORD=%s\n' "$PG" | apply act-db
fi

# 2. The app: database URL and model key.
: "${LLM_KEY_FILE:?set LLM_KEY_FILE (dotenv file holding the model key)}"
LLM=$(read_env "$LLM_KEY_FILE" "${LLM_KEY_NAME:-ACT_LLM_API_KEY}")
[ -n "$LLM" ] || { echo "${LLM_KEY_NAME:-ACT_LLM_API_KEY} not found in $LLM_KEY_FILE" >&2; exit 1; }
printf 'ACT_DATABASE_URL=postgres://act:%s@postgres.act.svc.cluster.local:5432/act?sslmode=disable\nACT_LLM_API_KEY=%s\n' "$PG" "$LLM" | apply act

# 3. Optional pieces.
if [ -n "${ACT_SMTP_USERNAME:-}" ] && [ -n "${ACT_SMTP_PASSWORD:-}" ]; then
  { printf 'ACT_SMTP_USERNAME=%s\nACT_SMTP_PASSWORD=%s\n' "$ACT_SMTP_USERNAME" "$ACT_SMTP_PASSWORD"
    [ -n "${ACT_SMTP_FROM:-}" ] && printf 'ACT_SMTP_FROM=%s\n' "$ACT_SMTP_FROM"; } | apply act-mail
fi
if [ -n "${ACT_WX_APPID:-}" ] && [ -n "${ACT_WX_APPSECRET:-}" ]; then
  { printf 'ACT_WX_APPID=%s\nACT_WX_APPSECRET=%s\n' "$ACT_WX_APPID" "$ACT_WX_APPSECRET"
    [ -n "${ACT_WX_OFFER_ID:-}" ] && printf 'ACT_WX_OFFER_ID=%s\nACT_WX_PAY_APPKEY=%s\n' "$ACT_WX_OFFER_ID" "${ACT_WX_PAY_APPKEY:?}"; } | apply act-wechat
fi
if [ -n "${OSS_BUCKET:-}" ]; then
  printf 'OSS_ENDPOINT=%s\nOSS_BUCKET=%s\nOSS_ACCESS_KEY_ID=%s\nOSS_ACCESS_KEY_SECRET=%s\n' \
    "${OSS_ENDPOINT:?}" "$OSS_BUCKET" "${OSS_ACCESS_KEY_ID:?}" "${OSS_ACCESS_KEY_SECRET:?}" | apply act-backup
fi

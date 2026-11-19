#!/usr/bin/env bash
# Build and deploy the China copy (Alibaba Cloud ECS, Hangzhou, vera.zhiyuwujie.top).
#
#   CN_HOST=root@121.43.114.65 CN_KEY=~/.ssh/suki_cn deploy/cn/deploy.sh
#
# The node is the k3s server ai-social-network's China copy runs on. Docker Hub
# and ECR are slow or blocked from mainland China, so the amd64 image is built
# here and streamed into the node's containerd over SSH. Secrets come from
# deploy/cn/secrets.sh and never appear in these manifests. HTTPS is the shared
# Caddy in the synagent namespace (ai-social-network/deploy/cn/50-caddy.yaml),
# which must route vera.zhiyuwujie.top here; this script checks that it does.
set -euo pipefail
cd "$(dirname "$0")/../.."
HOST=${CN_HOST:-root@121.43.114.65}
KEY=${CN_KEY:-$HOME/.ssh/suki_cn}
SSH=(ssh -i "$KEY" -o BatchMode=yes "$HOST")
say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

[ -z "$(git status --porcelain -- cmd internal web go.mod go.sum Dockerfile)" ] || { echo "commit first: the image is tagged with HEAD" >&2; exit 1; }
TAG=cn-$(git rev-parse --short HEAD)-amd64
IMAGE=docker.io/library/act:$TAG

say "secrets present?"
"${SSH[@]}" 'k3s kubectl -n act get secret act act-db -o name' || { echo "run deploy/cn/secrets.sh first" >&2; exit 1; }

say "image $IMAGE"
if ! "${SSH[@]}" "k3s ctr images ls -q | grep -qx '$IMAGE'"; then
  # The Dockerfile defaults TARGETARCH to arm64 for the US node; this node is x86.
  docker buildx build --platform linux/amd64 --build-arg TARGETARCH=amd64 --provenance=false --sbom=false -t "act:$TAG" --load .
  docker save "act:$TAG" | gzip -1 | "${SSH[@]}" 'gunzip | k3s ctr images import - >/dev/null'
fi

say "rendering manifests"
OUT=$(mktemp)
trap 'rm -f "$OUT"' EXIT
for f in deploy/k8s/00-namespace.yaml deploy/cn/20-config.yaml deploy/cn/30-postgres.yaml deploy/cn/40-app.yaml deploy/cn/70-backup.yaml; do
  # A separator between files, never a plain cat: concatenation silently
  # merges the last document of one file into the first of the next.
  printf -- '---\n'
  sed -E "s#^([[:space:]]*image:[[:space:]]*)ACT_IMAGE[[:space:]]*\$#\1${IMAGE}#" "$f" | tr -d '\r'
  printf '\n'
done > "$OUT"
grep -Eq "image:[[:space:]]*ACT_IMAGE" "$OUT" && { echo "unsubstituted ACT_IMAGE" >&2; exit 1; }

say "applying"
"${SSH[@]}" 'set -e; K="k3s kubectl"; $K apply -f - ;
  $K -n act rollout status statefulset/postgres --timeout=300s;
  $K -n act rollout status deploy/act-web --timeout=300s;
  $K -n act rollout status deploy/act-worker --timeout=300s;
  $K -n act get pods -o wide' < "$OUT"

say "edge"
if "${SSH[@]}" "k3s kubectl -n synagent get configmap caddy -o jsonpath='{.data.Caddyfile}' | grep -q 'vera.zhiyuwujie.top'"; then
  echo "caddy routes vera.zhiyuwujie.top"
else
  echo "caddy has no vera.zhiyuwujie.top route yet: add it in ai-social-network/deploy/cn/50-caddy.yaml and apply that file" >&2
  exit 1
fi
curl -fsS -o /dev/null -w 'https://vera.zhiyuwujie.top/readyz → %{http_code}\n' https://vera.zhiyuwujie.top/readyz || echo "not reachable yet (DNS or certificate still pending?)"

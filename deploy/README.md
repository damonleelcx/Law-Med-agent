# Deploying ACT

Target: the `heros-prod` k3s node (`i-05f4712279b04fac5`, arm64, reached over
SSM), serving **https://act.heros-agent.space**. ACT shares that node's Postgres,
mail relay, cert-manager and Traefik with forge and opportunity-bridge. It gets
its own namespace, database and role.

## Release (routine)

```bash
INSTANCE=i-05f4712279b04fac5 deploy/release.sh
```

This builds the linux/arm64 image (cross-compiled, no emulation), pushes it to
ECR `act` under an immutable tag, and runs `deploy.sh` pinned by digest.
`deploy.sh` is idempotent. It:

1. renders `k8s/*.yaml` with the digest, and ships it gzip+base64 over SSM with a checksum verified on the node;
2. creates or updates the `act` role and database on `heros/postgres-0`, reading the DSN on the node with the node's IAM role so the password never enters the SSM payload. It revokes `CONNECT` from `PUBLIC`;
3. admits `act` pods (namespace **and** label) to the heros `postgres` and `mail` NetworkPolicies. These are additive patches, skipped when present;
4. adds `act` to the nightly `postgres-backup` job;
5. applies, then waits for both deployments to roll out.

`--dry-run` skips every mutation and runs a server-side dry-run apply. On a
first install it will report `namespace not found`, which is expected.

Check the mail path without sending anything:

```bash
k3s kubectl -n act exec deploy/act-worker -- /act mailcheck
```

## One-time setup (done 2026-09-23)

| What | Where |
|---|---|
| ECR repository `act` (immutable tags, scan on push) | us-east-1 |
| Secrets Manager `act/prod`: `ACT_DATABASE_URL`, `ACT_LLM_API_KEY` | us-east-1 |
| Inline policy `ActSecretsRead` on role `heros-vm` → `secret:act/*` | IAM |
| Route53 `A act.heros-agent.space → 23.21.75.162` | zone heros-agent.space |
| Mail login | reuses the `heros/platform` relay login, like forge; sends as `support@heros-agent.space` |

## Topology

- `act-web` (1 replica): HTTP, SSE, auth. `ACT_WORKERS=0`.
- `act-worker` (1 replica, 3 worker goroutines + the scheduler): all background work. Scale with `replicas`; leases and fencing make that safe, and exactly one scheduler leads (advisory lock).
- Egress policy `act-egress`: DNS, heros postgres :5432, heros mail :587, and public :443 only.
- The TLS certificate comes from cert-manager `letsencrypt-prod`. HTTP redirects to HTTPS. An edge rate limit applies.

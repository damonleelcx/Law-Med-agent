# ACT · 维拉 — the mainland China copy

**https://vera.zhiyuwujie.top**, on the Alibaba Cloud ECS
`launch-advisor-20261106suki-cn` (`i-bp1br6mdasrmfudtli5v`, Hangzhou,
`121.43.114.65`). It shares that node's k3s and its Caddy edge with
ai-social-network's China copy (suki.zhiyuwujie.top), in its own `act`
namespace with its own Postgres.

| Piece | Where |
|---|---|
| Web + API (`act-web`), background work (`act-worker`) | `40-app.yaml`, image built here and streamed over SSH |
| Postgres 17 with a 10Gi local volume, reachable only by ACT | `30-postgres.yaml` |
| Nightly `pg_dump` to `/var/backups/act` on the node (14 days); copying it off the node to OSS is still to do | `70-backup.yaml` |
| HTTPS (Let's Encrypt) and routing | the shared Caddy: `ai-social-network/deploy/cn/50-caddy.yaml` |
| Config: Chinese-first site, no Google Fonts, ICP footer, Qwen (Beijing), DirectMail | `20-config.yaml` |

Differences from the US copy: `ACT_REGION=cn` makes the site open in Chinese,
drop Google Fonts (blocked in mainland China) and show `ACT_ICP_BEIAN` in the
footer. Mail goes through Alibaba Cloud DirectMail instead of the US relay.

## One-time setup

1. **SSH**: a key that can log in as root (`~/.ssh/suki_cn`, same as ai-social-network).
2. **DNS**: `A vera.zhiyuwujie.top → 121.43.114.65` (zone on Alibaba Cloud DNS).
3. **Edge**: the `vera.zhiyuwujie.top` block in `ai-social-network/deploy/cn/50-caddy.yaml`, applied.
4. **Secrets** (values over SSH stdin only):

   ```bash
   LLM_KEY_FILE=D:/.ENV LLM_KEY_NAME=QWEN_LLM_API_KEY_V2 deploy/cn/secrets.sh
   ```

   Optional, by exporting before running it: DirectMail login (`ACT_SMTP_USERNAME`,
   `ACT_SMTP_PASSWORD`, `ACT_SMTP_FROM`), WeChat (`ACT_WX_*`), OSS backups (`OSS_*`).
5. **ICP**: put the domain's filing number in `ACT_ICP_BEIAN` (`20-config.yaml`).

## Release

```bash
deploy/cn/deploy.sh
```

Commit first: the image is tagged with HEAD. Check mail without sending:

```bash
k3s kubectl -n act exec deploy/act-worker -- /act mailcheck
```

Restore: `pg_restore -h postgres -U act -d act --clean /var/backups/act/latest.dump`
from a pod in the namespace.

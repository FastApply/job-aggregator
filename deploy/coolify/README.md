# Coolify VPS: the board API, search index and worker

Replaces the three Render services (~$250/mo) with one VPS running Coolify (~$59/mo).
Postgres stays on Heroku (`fastapply-board`, Standard-0, $50/mo). Moved on 2026-09-25.

| | |
|---|---|
| Server | netcup VPS 4000 G12.5: 12 vCore / 32 GB / 512 GB, **Manassas, VA** (next to Heroku us-east) |
| IP | `152.53.192.224`, Debian 13, SSH key-only |
| API | `https://board.fastapply.co` |
| Coolify dashboard | `https://coolify.fastapply.co` (ports 8000/6001/6002 are closed to the internet) |
| DNS | Cloudflare, A records `board` and `coolify` → the IP, DNS-only (grey cloud) |

## What runs on it (all Coolify resources)

| Resource | Source | Notes |
|---|---|---|
| Meilisearch | `meilisearch.compose.yml` | Internal only, no domain. Apps reach it as `http://meilisearch-<uuid>:7700` |
| Web | branch `render-web`, `node src/web.js`, port 10000, `/health` | Domain `https://board.fastapply.co`. Auto-deploy **off** |
| Worker | branch `render-deploy`, `node scripts/render-worker.js` | No domain, no health check. Auto-deploy **on** |

Env templates: `web.env.example`, `worker.env.example`. The values live in Coolify only.

## The one rule: exactly one worker

Search stays current through one outbox column, `jobs.index_dirty_at`. The worker ships dirty rows
to Meilisearch and **clears the flag**. Two workers pointed at two indexes would each clear rows the
other never shipped, and both indexes would silently lose jobs. When moving or rebuilding, stop the
old worker **before** starting the new one.

## Rebuild the search index from scratch

The box holds no data that can't be rebuilt. Postgres is the source of truth. From the worker's
Coolify terminal:

```bash
node scripts/meili-init.js --probe                          # create index + settings
nohup node scripts/meili-backfill.js > /tmp/backfill.log 2>&1 &
tail -f /tmp/backfill.log
```

~9.5M jobs took about 4 hours, limited by Meilisearch indexing at ~45–50k docs/min. Progress is
checkpointed to `/tmp/meili-backfill.pos`. A redeploy wipes `/tmp`, so resume with
`FROM_ID=<last logged lastId>`. Re-sending documents is harmless: the index upserts.

## Verify search is served by the index

```bash
SEC="$(heroku config:get API_SECRET -a fastapply-board)" && T=$(SEC="$SEC" node -e \
  "console.log(require('jsonwebtoken').sign({sub:'check'},process.env.SEC,{expiresIn:'10m'}))") && \
curl -s -H "Authorization: Bearer $T" "https://board.fastapply.co/api/jobs?q=Software%20Engineer&limit=5" \
  | python3 -c "import json,sys; m=json.load(sys.stdin)['meta']; print(m['servedBy'], m['total'])"
```

`meili` is correct. `postgres` means the web app can't reach the index: check `MEILI_HOST`,
`MEILI_MASTER_KEY`, that `SEARCH_ENGINE` is unset, and that Meilisearch has "Connect to Predefined
Network" on.

## Gotchas hit during the move

- **Copying Render's env copies Render's `MEILI_HOST`** (`meilisearch-6fmu:10000`), which doesn't
  exist here. Search then falls back to Postgres without any error.
- **A worker with no `DATABASE_URL` doesn't fail.** It silently uses a local SQLite file
  (`src/db/connection.js`) and logs `claim failed: near "'60 minutes'": syntax error`.
- **Coolify domain changes need a redeploy.** Until then Traefik serves `TRAEFIK DEFAULT CERT`.
- **Docker-published ports bypass the host firewall.** `bootstrap-vps.sh BLOCK_PORTS=1` filters
  them in `DOCKER-USER` and survives reboots through `block-coolify-ports.service`.
- The Heroku role allows 200 connections (`rolconnlimit`), not the 40 older docs mention.

## Still to do at cutover

1. Point the board app and the extension at `https://board.fastapply.co`.
2. Watch it for a day: Telegram alerts, `index_dirty_at` backlog near 0, no 5xx.
3. Suspend Render web + Meilisearch. After a week, delete them **and the `meili-data` disk**. A
   suspended disk still bills.
4. Once the VPS crawl is confirmed, stop the Mac crawl fleet (`scripts/launch-local-crawlers.sh`).

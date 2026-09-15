# Handover verification

Work through this after cloning. It is designed around one problem: **most of the ways this
system fails are silent.** The API can serve perfectly while ingestion is dead, and nothing
alerts — the board just goes stale over weeks.

Every check below has an expected value taken from ~52 hours of measured production behaviour.
If a number is outside the range, that is the finding — say so rather than moving on.

---

## What you should have been given

These are **not in the repo** and nothing works without the first one:

- [ ] `.env` contents (`DATABASE_URL`, `API_SECRET`, `MEILI_HOST`, `MEILI_MASTER_KEY`)
- [ ] `data/logo/processed.txt` — 40,268 reviewed companies, exists only on the old machine
- [ ] `job-board-health.log` — the behavioural baseline these numbers come from
- [ ] Heroku access (`fastapply-board`), Render access, GitHub push access

---

## 1. The API is alive

```bash
npm install
cp .env.example .env        # fill in DATABASE_URL, NODE_ENV=production
npm run start:web
curl -s localhost:3000/health
```

Expect roughly:
```json
{"status":"ok","companies_tracked":88813,"total_active_jobs":5165522}
```

`total_active_jobs` well below ~5,000,000 means something has been retiring jobs without
replacing them. `NODE_ENV=production` is required — it enables the TLS that Heroku demands.

## 2. Search is served by Meilisearch, not Postgres

`BOARD_API_TOKEN` is a **JWT signed with `API_SECRET`**, not `API_SECRET` itself — see
`src/api/middleware/auth.js`, which calls `jwt.verify(token, config.API_SECRET)`. Sending the
raw secret returns `401 Invalid or expired token`, which reads like a credential you do not
have rather than a token you built wrong. Mint one:

```bash
BOARD_API_TOKEN=$(SEC="$(heroku config:get API_SECRET -a fastapply-board)" node -e \
  "console.log(require('jsonwebtoken').sign({sub:'check'}, process.env.SEC, {expiresIn:'10m'}))")

curl -s -H "Authorization: Bearer $BOARD_API_TOKEN" \
  "https://job-aggregator-web-gt9m.onrender.com/api/jobs?q=Software%20Engineer&limit=20" \
  | python3 -c "import json,sys; m=json.load(sys.stdin)['meta']; print(m['servedBy'], m['total'])"
```

Expect `meili` and a large total, in **under 2 seconds**. A `total` of exactly 10000 is
`COUNT_CAP`, not an error — broad queries stop counting there. Measured 2026-08-30:
`meili 10000` in 0.55s.

`servedBy: postgres` is a **failure**, not a fallback working as intended. Postgres cannot serve
this query set at 5M rows; it is the exact path that took the board down on 2026-08-20.

## 3. Ingestion is running — the check people skip

The crawler fleet does not run on a server. It runs on **your laptop**, and it stops when the
laptop sleeps. Nothing tells you it stopped.

```bash
heroku config:get DATABASE_URL -a fastapply-board > ~/.fastapply-database-url
chmod 600 ~/.fastapply-database-url

bash scripts/launch-local-crawlers.sh
pgrep -fl crawl-companies-local.js | wc -l      # expect 11
pgrep -fl prune-dead-jobs-local.js | wc -l      # expect 2
```

**Stop the previous maintainer's fleet before starting yours.** Two fleets crawl the same
companies and compete for a hard 40-connection Postgres limit.

## 4. It is actually producing — wait one hour

Set up the hourly monitor, then leave it:

```bash
crontab -e
# 0 * * * * /FULL/PATH/TO/job-aggregator/scripts/log-health.sh >/dev/null 2>&1

tail ~/job-board-health.log
```

One line per hour. Measured healthy ranges over 52 hours:

| field | healthy | what it means if wrong |
|---|---|---|
| `retired_1h` | **3,000–12,000** | in the low hundreds = the fleet is not really running, usually the machine slept |
| `fallbacks_1h` | **0** (51 of 52 hours) | non-zero and sustained = search is degrading toward the 2026-08-20 outage |
| `meili p90` | **27–90 ms** | hundreds of ms sustained = indexing pressure or the index is struggling |
| `absent3` | **drifting down** (508 → 389 over 3 days) | climbing = the absence signal drifted; turn `SYNC_ABSENCE_REMOVAL` off in the launcher |
| `crawlers` / `pruners` | **11 / 2** | anything less = wrappers died |
| `conns` | **15–27 of 40** | near 40 = something is leaking connections |

## 5. Deploys reach production

Three branches, and they are **not** copies of each other:

| branch | deploys | autodeploy |
|---|---|---|
| `main` | nothing — canonical source | — |
| `render-web` | the API | **off**, trigger manually |
| `render-deploy` | the worker | **on**, a push ships it |

The deploy branches are trimmed, service-specific trees that differ from `main` by 100+ files.
**Do not merge `main` into either** — it would push the whole crawler fleet into a 512MB service.
Port the individual hunk instead; the workflow is in `README.md`.

```bash
render deploys list srv-d9q9serm8hqs73e9uio0   # web
render deploys list srv-d9q2ke9t0dsc73c50b50   # worker
```

## 6. Known-bad things — do not treat these as new bugs

- The Render worker OOMs and self-restarts **13–18 times a day**. It is a 512MB instance running
  six jobs. Long-standing, self-healing, predates the handover.
- `BRIGHT_DATA_API_KEY` returns **HTTP 407**; `BRIGHT_DATA_API_KEY_STANDBY` works. Anything routed
  through the BrightData unlocker fails silently until they are swapped.
- Workable descriptions have **no working path** — it IP-blocks and the IPRoyal proxy account
  died 2026-08-08.
- Occasional `db_error=getaddrinfo ENOTFOUND` in the health log is **local DNS**, not the
  database. The machine resolves through a single router; adding 1.1.1.1 as a second resolver
  fixes it.

---

## The two rules

**Anything that deletes rows runs in shadow mode first.** On 2026-08-25 a plausible retirement
rule looked like it would clear ~3,000,000 rows. HTTP-testing 60 of those candidates found **48
still alive** — it would have deleted ~2.5M live jobs. Removal is always soft (`removed_at`),
never `DELETE`.

**Never mass-restart the database clients.** Restarting all 11 crawlers at once pins the
40-connection limit and takes the live API down. One at a time, waiting for each to come back.

---

## Report back

State plainly which checks passed, which failed with the actual numbers, and anything that
looked wrong but is on the known-bad list above. Do not report success on a check you could not
run — say it was blocked and why.

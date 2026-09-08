# `scripts/`

Every script here is either **running in production** or **maintained and runnable on demand**.
58 obsolete scripts were deleted on 2026-08-29 (dead credentials, superseded tools, finished
one-off migrations, throwaway debug files). They are in git history if one is ever needed:

```bash
git log --diff-filter=D --name-only -- scripts/     # what was removed
git show 60d4043:scripts/<name>                     # read one without restoring it
git checkout 60d4043 -- scripts/<name>              # restore one
```

---

## Where this system runs

**This laptop** runs the ingestion fleet — 11 crawlers, 2 dead-job pruners, the description
backfills — all started by `launch-local-crawlers.sh` at login via a LaunchAgent.

> **When the laptop sleeps, ingestion stops.** Measured overnight: job retirement drops from
> ~9,000/hour to ~200/hour. This is the single most surprising operational fact about the system.

**Render** runs the API (`src/web.js`, branch `render-web`) and a background worker
(`scripts/render-worker.js`, branch `render-deploy`). The worker is a 512MB starter instance
and restarts 13–18 times a day under memory pressure — long-standing, self-healing, not a
regression. Meilisearch is a private service there, which is why **Meili sync can only run from
Render** and not from this laptop.

**Postgres** is on Heroku (`fastapply-board`). The role is capped at 40 connections.

Credentials: `.env` in the repo root, plus `~/.fastapply-database-url` (cached DB URL that the
fleet and cron read, so they do not depend on the `heroku` CLI).

---

## Always running

Started automatically. You should not normally need to launch these by hand.

### `launch-local-crawlers.sh` — the entry point
Starts the entire local fleet. **Read this first**; it documents every instance and its tuning.
Sets `SYNC_ABSENCE_REMOVAL=1`, which arms automatic job retirement at sync time.

```bash
bash scripts/launch-local-crawlers.sh          # start everything
pgrep -fl crawl-companies-local.js             # what is running
```

To restart the fleet, **kill one process at a time and wait for each to come back**. Restarting
all 11 at once pins the 40-connection Postgres limit and takes the live API down.

### `crawl-companies-local.js` — the crawler
One process per ATS group (11 running). Claims companies due for sync, fetches each board, calls
`jobsRepo.syncForCompany`.

```bash
DATABASE_URL=$(cat ~/.fastapply-database-url) NODE_ENV=production \
  ATS=greenhouse CONCURRENCY=3 node scripts/crawl-companies-local.js
```
`ATS` (comma list) · `CONCURRENCY` (3) · `BATCH` (40) · `STALE_MIN` (60) · `PROXY_DISABLED=1`

### `prune-dead-jobs-local.js` — the dead-job pruner
Two instances split the corpus by id parity. HTTP-checks 5,000 jobs a cycle and retires the
confirmed-dead. Workday and Oracle are checked against their JSON APIs, because their pages
return HTTP 200 for dead postings.

```bash
DATABASE_URL=$(cat ~/.fastapply-database-url) NODE_ENV=production \
  LOOP=1 INTERVAL_S=300 LIMIT=5000 CONCURRENCY=8 PARTITION_REMAINDER=0 \
  node scripts/prune-dead-jobs-local.js
```
`PARTITION_REMAINDER` must be `0` on one instance and `1` on the other, or they duplicate work.

### `local-backfill-descriptions.js` — description backfill
Fills missing descriptions across every automatable platform.

```bash
DATABASE_URL=$(cat ~/.fastapply-database-url) node scripts/local-backfill-descriptions.js
```

### `backfill-desc-generic.js` — one platform to exhaustion
```bash
DATABASE_URL=$(cat ~/.fastapply-database-url) LOOP=1 \
  node scripts/backfill-desc-generic.js paylocity
```
Note: **workable has no working path** — it is IP-blocked and the proxy account is dead.

### `backfill-comeet-desc.js` — comeet descriptions
Comeet detail pages need special handling, hence its own script.
```bash
DATABASE_URL=$(cat ~/.fastapply-database-url) LOOP=1 node scripts/backfill-comeet-desc.js
```

### `render-worker.js` — the Render worker (not run locally)
Company syncs, classification backfill, stale cleanup, demand crawl, and **Meili sync**.
Deployed from branch `render-deploy`; it is the process entry point, not something you invoke.

### `log-health.sh` + `health-metrics.js` — hourly monitoring
Cron writes one line an hour to `~/job-board-health.log`.

```bash
tail ~/job-board-health.log
crontab -l                       # 0 * * * * .../log-health.sh
```

Two fields matter most:

| field | meaning |
|---|---|
| `fallbacks_1h` | searches that gave up on Meilisearch and hit Postgres. **This is the alarm.** It is the mechanism that took the board down on 2026-08-20. Sustained non-zero needs attention; latency alone does not reach users. |
| `absent3` | jobs about to be auto-retired. Should drift *down*. If it climbs steadily, the absence signal has drifted — switch `SYNC_ABSENCE_REMOVAL` off in the launcher. |

### `health-alert.js` — the part that actually tells you

`log-health.sh` has recorded the numbers above hourly for weeks and **nothing read them
back**. That is the gap this repo's handover opens with, and it has a cost: on 2026-09-05 a
paying user's Apply-for-Me automation had no jobs for their criteria, and the first anyone knew
was a support chat. `src/utils/notify.js` had a working `sendAlert()` the whole time with zero
callers.

```bash
DATABASE_URL=... DRY=1 node scripts/health-alert.js   # print what it would send
crontab -e
# 5 * * * * ... node scripts/health-alert.js          # just after log-health.sh at :00
```

Alerts on: ingestion stalled (<500 retired/hour against a healthy 3,000–12,000), the corpus
shrinking below 4M, the Meili outbox above 50k, and unmet searches going uncrawled for days.
Sends one alert per condition, then stays quiet for `ALERT_REPEAT_HOURS` (6) so a slow fix does
not train people to ignore the channel, and says so when a condition clears. Dedup state lives
in an `alert_state` table, **not** a file: the Render worker restarts 13–18 times a day, so
on-disk state there is empty on nearly every run and every restart would re-alert. Needs
`TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`; without them it logs and sends nothing. Always
exits 0.

It also runs hourly inside `render-worker.js`, so alerting does not depend on the laptop being
awake — which matters, because "the laptop slept" is the thing most worth alerting on.

### `demand-queue-preview.js` — what demand-crawl will pick next

Read-only. Prints the next batch under the current two-lane selection beside what the old
popularity-only ordering would have taken, and counts how many rows would otherwise never have
been reached.

```bash
DATABASE_URL=... node scripts/demand-queue-preview.js
```

`demand-crawl` used to select with one `ORDER BY search_count DESC LIMIT 25`, so a search
nobody else runs never reached the queue however long it had been unmet — the shape of a paying
user with narrow criteria. `DEMAND_STARVED_SHARE` (0.4) of each batch is now reserved for the
most starved demand regardless of popularity; set it to `0` to restore the old behaviour
without a deploy.

### `job-roles.js` — shared vocabulary (library, not a script)
1,683 job titles across 27 industries. Imported by the discovery tools. Do not run it.

---

## On demand

### Finding new companies

**`discover-jobvite.js`** — the template for cheap ATS discovery. Generates slug guesses from
companies we already track and probes them with `HEAD` + `redirect: manual`: ~300ms each, zero
bandwidth, no scraping account. A valid slug returns 200, an invalid one 302s away.
```bash
DATABASE_URL=$(cat ~/.fastapply-database-url) node scripts/discover-jobvite.js
```
`OUT` · `CHECKPOINT` (resumable) · `CONCURRENCY` (8) · `LIMIT`

**`import-jobvite-boards.js`** — import what discovery confirmed. Dry-run by default.
```bash
node scripts/import-jobvite-boards.js            # dry run
APPLY=1 node scripts/import-jobvite-boards.js    # write
```
Takes the company name from Jobvite's own posting data, never from the guess that found it —
11 of 40 boards had a different real owner than the slug suggested.

**`discover-workable-by-keyword.js`** — Workable slugs via marketplace keyword search.
```bash
DATABASE_URL=... node scripts/discover-workable-by-keyword.js "Purchasing Agent"
DATABASE_URL=... node scripts/discover-workable-by-keyword.js --file keywords.txt
```

**`discover-all-roles.js`** — drives the above across all 1,683 roles. Checkpointed to
`/tmp/discover-roles.checkpoint`; safe to interrupt and resume.

**`discover-comeet.js`** — Comeet discovery via SERP + page-embedded token extraction.

### Bulk import

| script | use |
|---|---|
| `fetch-jobloo.js` | jobloo.co public API. **Shard by category** — a plain offset walk degrades to 30+ hours. |
| `fetch-liftmycv.js` | LiftMyCV public API. Still works; no credential needed. |
| `import-ats-slugs.js` | Seed companies from an external slug dump. `SLUGS_FILE=... node scripts/import-ats-slugs.js` |
| `import-ats-companies-csv.js` | Seed from the `ats-scrapers` tenant lists. |
| `sync-jobs-to-postgres.js` | Push local SQLite rows into Postgres. |

### Cleanup and repair

**`prune-dead-jobs-render.js`** — Puppeteer pruner. Renders pages to catch boards that return
HTTP 200 while displaying "no longer accepting applications" — about 1% of jobs, invisible to any
status-code check.
```bash
node scripts/prune-dead-jobs-render.js                    # SHADOW, writes nothing
VERIFY=1 node scripts/prune-dead-jobs-render.js           # prove the detector first
APPLY=1 TABS=4 node scripts/prune-dead-jobs-render.js     # armed
```
**Use `TABS=4`, not the default 10, and not while the crawlers are busy.** At 10 tabs it spawned
32 Chrome processes, pushed this 8GB laptop to 7.0GB, and every tab began timing out.

**`prune-workday-dead.js`** — one-off Workday sweep, parked at a cursor. The rotating pruner
covers Workday now; only useful for a targeted catch-up.

**`check-dead-jobs.js`** — CLI for the dead-job checker. Useful for testing a single URL by hand.
```bash
node scripts/check-dead-jobs.js --ats=zoho --limit=50
```

**`dedup-ats-duplicates.js`** — deduplicate rows sharing `(ats, ats_slug)`.

### Search index — `meili-init.js`, `meili-backfill.js`

```bash
node scripts/meili-init.js --probe      # health + settings, writes nothing
node scripts/meili-init.js --seed       # mark all live jobs for reindexing
node scripts/meili-backfill.js          # copy jobs straight in; read-only on Postgres
```
`meili-backfill.js` checkpoints to `/tmp/meili-backfill.pos`, so it resumes after an interruption.

### Testing

**`test-sync-batch.js`** — verifies the batched `syncForCompany` upsert. Worth running after any
change to sync.

---

## `logo-review/`

A separate multi-step pipeline for sourcing and approving company logos
(harvest → export → eyeball → approve → save). Not part of job ingestion. Several `sprout-*.js`
files there are uncommitted work in progress and were left untouched.

---

## Two rules that were learned the hard way

**Anything that deletes rows runs in shadow mode first.** On 2026-08-25 a plausible rule —
"retire jobs whose company synced after the job was last seen" — looked like it would clear
~3,000,000 rows. HTTP-testing 60 of those candidates found **48 still alive**. Shipping it would
have deleted roughly 2.5 million live jobs. Removal is always soft (`removed_at`), never `DELETE`.

**Never mass-restart the database clients.** Restarting all 11 crawlers at once pins the
40-connection Postgres limit and takes the live API down. One at a time, waiting for each.

---

## Known-dead credentials

Worth knowing before debugging something that cannot work:

- **`BRIGHT_DATA_API_KEY` returns HTTP 407.** `BRIGHT_DATA_API_KEY_STANDBY` works. Anything routed
  through the BrightData Web Unlocker is failing silently until these are swapped.
- **IPRoyal proxy account died 2026-08-08.** Workable now blocks outright rather than
  rate-limiting per IP, so Workable descriptions have no working path.
- **ScrapingDog, Apify and SERP quotas are exhausted.** The scripts that used them were deleted;
  do not reintroduce that approach without checking the accounts first. Slug probing (see
  `discover-jobvite.js`) finds boards more accurately for free.

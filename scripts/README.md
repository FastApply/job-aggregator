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

**`fetch-xeruit.js`** — the Xeruit corpus (~24k jobs), into the **local SQLite DB**, not Postgres.
Worth running for the descriptions: they arrive complete on every row (median ~5,000 chars),
which is the field our own crawlers most often have to backfill afterwards.

```bash
XERUIT_TOKEN=<jwt> node scripts/fetch-xeruit.js              # fetch + load
node scripts/fetch-xeruit.js --from-file dump.jsonl          # load a saved dump
node scripts/fetch-xeruit.js --from-file dump.jsonl --report # map + diagnose, write nothing
XERUIT_TOKEN=<jwt> node scripts/fetch-xeruit.js --dump raw.jsonl --no-load
```

`XERUIT_TOKEN` is a user JWT from app.xeruit.com — the endpoint 401s without one and they last
24 hours. The API caps `limit` at 100, so the walk is 242 pages and takes ~20 minutes; `--dump`
saves the raw JSON so the mapping can be re-run without re-fetching.

**It refuses to start with `DATABASE_URL` set** (override: `ALLOW_POSTGRES=1`). Every importer
here shares one connection module, so an inherited `DATABASE_URL` would push 24k aggregated
rows straight into the live board. Load locally, look at it, then push deliberately.

Three source fields are deliberately *not* trusted into columns — `workType` is `remote` on all
24,124 external rows and is not even a filterable field on their API, and `level` /
`visaSponsorship` are their LLM's guesses. `classify.js` decides what lands in the columns so
this corpus stays comparable with every other row in the table; the source values are kept in
`raw_data`. Company identity comes from `externalJobLink`, never from `companyName` (free text,
and it collides) — see `xeruit-board.js`.

**`fetch-simplify.js`** + **`load-simplify.js`** + **`enrich-from-simplify.js`** — Simplify.jobs,
~1.72M rows, into the **local SQLite DB**.

```bash
SIMPLIFY_KEY=<x-typesense-api-key> node scripts/fetch-simplify.js raw.jsonl  # ~25 min, 6,903 reqs
node scripts/load-simplify.js raw.jsonl              # map + upsert (--report to dry-run)
node scripts/enrich-from-simplify.js                 # SHADOW; APPLY=1 to write
```

The key is the scoped search-only key Simplify ships to its own browser client (lift it from the
`x-typesense-api-key` header). It carries a server-side `exclude_fields` that **no query can
override** — verified: asking `include_fields=url,title,id` returns only `id` and `title`. So
there is no employer apply URL and no description, ever. Treat this as metadata, not postings.

Two hard API limits shape `fetch-simplify.js`, and the second is a trap:

| limit | value |
|---|---|
| `per_page` | 250 (251 is an error) |
| offset | **exactly 1,000,000 rows** |

Past page 4000 the API returns an **empty result set with no error**, so a plain offset walk
looks like it succeeded while silently capturing 58% of the corpus. The script instead cuts the
collection into disjoint half-open windows on `shuffle_key` (a stable random int, 0–999,999),
each ~86k docs and well inside the ceiling. Windows are *ranges* rather than a `>last` cursor
because `shuffle_key` is **not unique** — 250 consecutive rows spanned 122 distinct values, and a
cursor would skip every row sharing a boundary value.

`url` is synthesised as `https://simplify.jobs/p/{posting_id}`. That is a real, checkable URL: a
live posting returns 200 and a bogus UUID returns 404, so the dead-job pruner works against it
unmodified. `description` is left NULL.

These rows **cannot merge** with natively-crawled jobs — with no employer board URL there is no
`(ats, ats_slug)` to key on, so they live under `ats='simplify'` and a posting we also crawl from
Greenhouse exists twice. `enrich-from-simplify.js` is the payoff: it copies the facts we cannot
get elsewhere (employer-stated H1B, structured salary, stated seniority, logos) onto jobs we
already hold, matching on normalised `(company_name, title)`. It only ever fills a column that is
already empty, and only from an unambiguous match, so a bad match can add noise but never
destroy an employer-sourced fact.

**`xeruit-board.js`** — board-link resolver used by the above (library, not a script). Turns a
posting URL into `(ats, ats_slug, native job id)`. The native id is the part that matters: it is
what lets a Xeruit row and a natively-crawled row of the same posting collide on
`(external_id, company_id)` instead of duplicating, and it is only ever set where the URL id is
provably the id our adapter reads. ~62% of the corpus resolves that far.

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

**`test-classify-visa.js`** — `classifyVisa()`, written around a real miss. `VISA_NO_PATTERNS`
required `no` to sit adjacent to `sponsorship`, so "No **new** H1B sponsorship available" was not
read as a refusal; control fell through to `VISA_YES_PATTERNS`, which matched `/h1b\s*transfer/`
against the "H1B transfers welcomed" line that follows it in the wild. Postings opening with a
refusal classified as `yes` — 756 of 757 such rows, graded against employer-stated H1B data.
The false-positive cases in the file matter as much as the fix: the obvious repair is a generic
`(?:\w+\s+)*` gap, which would read "no reason to doubt our generous visa sponsorship" as a
refusal, so the qualifier list is enumerated and that stays tested.
```bash
node scripts/test-classify-visa.js
```

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

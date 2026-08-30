# job-aggregator

A job board backend: crawls applicant-tracking systems (ATS) directly, normalises what it finds
into one schema, and serves it through a search API. ~5.1M live jobs across ~88k companies as of
2026-08-29.

The corpus comes from **talking to ATS APIs directly** — Greenhouse, Workday, Lever, Ashby,
Jobvite and ~20 more — not from scraping search engines or paying a scraping service. That is why
it is large and costs nothing per job.

---

## Layout

```
src/
  adapters/       one module per ATS. Each exports fetchJobs(slug) -> { jobs, meta }
  api/            Express routes, auth middleware, the search endpoint
  db/             connection, schema/migrations, repositories
  tasks/          long-running work: description backfill, dead-job pruning, Meili sync
  utils/          shared helpers (location resolution, URL parsers, proxy, logging)
scripts/          operational tooling — see scripts/README.md
data/             seed company lists (input files, not runtime state)
docs/             design notes
```

**Taking this over?** Work through `HANDOVER.md` — a verification checklist with the expected
values, built around the fact that most failures here are silent.

**Start with `scripts/README.md`.** It documents what runs where, how to start it, and the
operational rules that are not obvious from the code.

---

## Where it runs

| piece | where | branch |
|---|---|---|
| API (`src/web.js`) | Render web service | `render-web` |
| Background worker (`scripts/render-worker.js`) | Render worker | `render-deploy` |
| Crawler fleet, dead-job pruners, backfills | **a laptop**, started by `scripts/launch-local-crawlers.sh` | `main` |
| Postgres | Heroku (`fastapply-board`), 40-connection cap | — |
| Meilisearch | Render private service | — |

### Branches — read this before deploying

| branch | role |
|---|---|
| `main` | **canonical.** Everything lives here. Clone this. |
| `render-web` | deploys the API. Autodeploy **off** — trigger manually. |
| `render-deploy` | deploys the worker. Autodeploy **on** — a push ships it. |

The deploy branches are **deliberately trimmed, service-specific trees**, not copies of `main`.
`render-web` carries the API and search code; `render-deploy` carries the worker and its tasks.
Neither carries the crawler-fleet tooling, and they have diverged from `main` by 100+ files.

> **Do not merge `main` into a deploy branch.** It would drag the whole local fleet, unrelated
> adapters and dev tooling into a 512MB service. The established pattern is to **port the
> individual hunk** into a worktree and commit it there:
>
> ```bash
> git worktree add /tmp/wt render-deploy
> git diff <sha>~1 <sha> -- src/tasks/thing.js > /tmp/wt/fix.patch
> git -C /tmp/wt apply --check fix.patch && git -C /tmp/wt apply fix.patch
> node --check /tmp/wt/src/tasks/thing.js      # verify before committing
> git -C /tmp/wt commit -am "..." && git -C /tmp/wt push origin render-deploy
> ```
>
> Always `--check` first, and re-verify syntax in the worktree — the deploy branch may not have
> the file's dependencies.

Deploys are triggered with `render deploys create <service-id>`. Service IDs are in
`scripts/README.md`.

Two consequences worth knowing before you touch anything:

- **Ingestion runs on a laptop.** When it sleeps, crawling and pruning stop — measured, job
  retirement drops from ~9,000/hour to ~200/hour.
- **Meilisearch is a private service**, reachable only from inside Render. Search index syncing
  cannot run locally.

---

## First run after cloning

The repo alone is not enough to operate this system — **credentials and two machine-local files
are not in git** and must be handed over separately.

### 1. What you need from the previous maintainer

| item | why |
|---|---|
| `.env` contents | Postgres URL, `API_SECRET`, Meili host/key, proxy keys. Nothing works without `DATABASE_URL`. |
| Heroku access to `fastapply-board` | the database |
| Render access | API, worker and Meilisearch services |
| GitHub push access | this repo |

### 2. Get the API running

```bash
npm install
cp .env.example .env          # fill in DATABASE_URL and NODE_ENV=production
npm run migrate               # safe: CREATE TABLE/INDEX IF NOT EXISTS only
npm run start:web             # API on $PORT (default 3000)
```

Verify it reads real data:

```bash
curl "http://localhost:3000/health"
```

`NODE_ENV=production` is required against hosted Postgres — it enables TLS, which Heroku demands.

### 3. Take over ingestion (the part that is easy to miss)

The crawler fleet does **not** run on a server. It runs on a laptop, and it stops when that
laptop sleeps. To move it to yours:

```bash
# The launcher reads the DB URL from this cache, so the fleet does not depend on the heroku CLI.
heroku config:get DATABASE_URL -a fastapply-board > ~/.fastapply-database-url
chmod 600 ~/.fastapply-database-url

bash scripts/launch-local-crawlers.sh     # starts 11 crawlers, 2 pruners, the backfills
pgrep -fl crawl-companies-local.js        # confirm
```

**Stop the old machine's fleet before starting yours**, or both will crawl the same companies and
compete for the 40 Postgres connections.

Hourly monitoring is a cron entry, also not in git:

```bash
crontab -e
# 0 * * * * /path/to/job-aggregator/scripts/log-health.sh >/dev/null 2>&1
tail ~/job-board-health.log
```

To survive reboots the previous setup used a macOS LaunchAgent calling
`scripts/launch-local-crawlers.sh` at login; recreate that or start it by hand.

### 4. Check it is actually working

After an hour, `retired_1h` in the health log should be in the thousands and `fallbacks_1h`
should be `0`. If `retired_1h` is in the low hundreds, the fleet is not really running — the most
common cause is the machine sleeping.

### Reading data without a full setup

Everything needs `DATABASE_URL`. Most operational scripts take it inline:

```bash
DATABASE_URL="postgres://..." NODE_ENV=production node scripts/<script>.js
```

`NODE_ENV=production` matters — it enables TLS on the Postgres connection, which Heroku requires.

### Running the board against the local SQLite DB

The API does not need Postgres, Redis or Meilisearch. With `DATABASE_URL` unset it opens
`data/jobs.db`; with `API_SECRET` unset it skips auth; with `REDIS_URL` unset it skips the
(retired) queue. Meilisearch is optional — `jobsSearch.search()` returns null when the index is
unset and the query falls back to SQL, so `servedBy` in the response reads `postgres` even here.
It means "answered from the database, not the search index".

```bash
# populate data/jobs.db first — e.g. scripts/fetch-xeruit.js
env -u DATABASE_URL -u API_SECRET -u REDIS_URL PORT=3100 node src/web.js
curl 'http://localhost:3100/api/jobs?q=engineer&posted=7d&limit=5'
```

Port 3100 rather than the 3000 default, because the frontend dev server takes 3000. CORS already
allows `http://localhost:3000`, so a local frontend can point straight at it.

**Use Node 22** (`/opt/homebrew/opt/node@22/bin/node`). `better-sqlite3` 12.6.2 does not compile
against Node 26 — `npm rebuild` fails in node-gyp — so the SQLite path only works on a Node the
prebuilt binding supports. Postgres is unaffected, which is why this went unnoticed.

`/api/jobs` takes `q`, `location`, `ats` (comma list), `employment_type`, `experience_level`,
`work_mode`, `remote`, `remote_worldwide`, `visa`, `company_id`, `posted` (`Nh`/`Nd`/`Nw`/`Nm`),
`include=description`, and `limit`/`page`/`offset`. Counts stop at `SEARCH_COUNT_CAP` (10,000)
and say so via `meta.totalIsCapped`.

---

## How the pieces fit

**Ingestion.** `scripts/crawl-companies-local.js` claims companies that are due, calls the right
adapter, and hands the results to `jobsRepo.syncForCompany`. Adding a new ATS means writing one
adapter and registering it in `src/adapters/index.js` and `src/utils/supported-ats.js`.

**Job removal** happens two ways:
1. *At sync time* — a job missing from **3 consecutive successful syncs** is retired
   (`absent_syncs` counter, armed by `SYNC_ABSENCE_REMOVAL=1`). No HTTP, no cost.
2. *By the pruner* — `scripts/prune-dead-jobs-local.js` HTTP-checks jobs and retires the
   confirmed-dead. Workday and Oracle are checked against their JSON APIs because their pages
   return HTTP 200 for dead postings.

Removal is always **soft** (`removed_at` timestamp), never `DELETE`. The board and the search
index both read `WHERE removed_at IS NULL`.

**Search.** `/api/jobs` queries Meilisearch and falls back to Postgres if the index is
unavailable. A Postgres fallback is much slower and is the failure mode that has taken the board
down before — watch `fallbacks_1h` in the health log.

**The search index** is kept current by a Postgres outbox: a trigger sets `index_dirty_at` on any
row whose indexed fields change, and `src/tasks/meili-sync.js` ships those rows every 60s.

---

## Monitoring

An hourly cron writes one line to `~/job-board-health.log` on the crawler machine:

```bash
tail ~/job-board-health.log
```

| field | what it means |
|---|---|
| `fallbacks_1h` | searches that gave up on Meilisearch and hit Postgres. **The alarm.** Sustained non-zero needs attention. |
| `absent3` | jobs about to be auto-retired. Should drift down; a steady climb means the absence signal has drifted. |
| `retired_1h` | jobs removed in the last hour. Healthy is thousands. |
| `meili[p50/p90]` | search latency. p90 in the tens of ms is normal. |

---

## Conventions worth following

**Anything that deletes rows runs in shadow mode first.** On 2026-08-25 a plausible retirement
rule looked like it would clear ~3,000,000 rows; HTTP-testing 60 of those candidates found **48
still alive**. Shipping it would have deleted ~2.5M live jobs.

**Never mass-restart the database clients.** Restarting all 11 crawlers at once pins the
40-connection Postgres limit and takes the live API down. One at a time.

**No `ORDER BY` on an unindexed column against `jobs`.** The table is ~28GB. That shape has blown
the statement timeout repeatedly — walk primary-key ranges instead.

**Comments explain *why*, especially where the obvious approach was tried and failed.** Much of
this codebase's value is in those notes; several of them exist because a plausible-looking change
caused an outage.

---

## Known issues

- The Render worker is a 512MB starter instance running six jobs; it OOMs and self-restarts
  13–18 times a day. Long-standing, not a regression.
- `BRIGHT_DATA_API_KEY` returns HTTP 407 — `BRIGHT_DATA_API_KEY_STANDBY` works. Anything routed
  through the BrightData Web Unlocker fails silently until they are swapped.
- Workable descriptions have no working path: it IP-blocks, and the IPRoyal proxy account died
  2026-08-08.
- `taleo`, `oracle`, `oraclecloud`, `icims` and `successfactors` account for ~94% of the missing
  descriptions. They have working fetchers but no apply automation, so they are deliberately
  excluded from the backfill (`BACKFILL_NO_AUTOMATION_ATS=1` enables them).

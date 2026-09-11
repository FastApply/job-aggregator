#!/usr/bin/env bash
# Clone crawler fleet, pointed at the LOCAL Postgres staging database.
#
# WHY THIS EXISTS
# Crawling straight into the live database is what put it IO-bound on 2026-08-11 (12 crawlers
# plus backfills: two autovacuum workers 25min into a 23GB TOAST, 8 of 9 active queries
# waiting, 76 platform cool-offs). This fleet writes to a local Postgres, so bulk discovery
# costs the live board nothing. Jobs are promoted later and deliberately, by
# scripts/sync-local-to-prod.js.
#
# WHY POSTGRES AND NOT THE OLD SQLITE FILE
# 1. SQLite takes a single write lock, so N crawlers queue instead of running in parallel.
# 2. jobs.js gates absence tracking on `isPostgres`, so on SQLite `absent_syncs` is never
#    written and NOTHING is ever retired. The old data/jobs.db held 1,746,973 jobs and exactly
#    0 removals: it could not tell a live posting from one closed months ago.
#
# WHY MULTIPLE WORKERS PER ATS IS SAFE
# claimBatch() in crawl-companies-local.js claims with `FOR UPDATE SKIP LOCKED` and bumps
# last_synced_at in the same statement, so two workers on one ATS never take the same company.
# The "keep partitions disjoint" rule in launch-local-crawlers.sh was about the local fleet and
# the Heroku worker sharing ONE database; with a separate local DB that no longer applies.
# Worker counts below are therefore allocated by company volume, not by platform identity.
#
# SIZING (measured on this machine, 12 cores / 48GB)
# 28 workers x CONCURRENCY=3 = ~84 concurrent sockets. The ephemeral range is 49152-65535
# (16,384 ports) and TIME_WAIT is 2*msl = 30s, giving roughly 546 new connections/sec before
# port exhaustion. At 11 workers the machine sat at 163 TIME_WAIT; 28 lands near 390, well
# clear. The 2026-08-13 EADDRNOTAVAIL incident was the PRUNER at CONCURRENCY=25 opening a
# short-lived HTTP request per candidate job — thousands of sockets — not crawler count.
# Postgres: 28 x PG_POOL_MAX=2 = 56 against max_connections=100.
# To scale past ~40 workers, raise max_connections (needs a Postgres restart).
set -u
cd "$(dirname "$0")/.."

DATABASE_URL="${DATABASE_URL:-postgres://codev@localhost:5432/jobs_local}"
LOG="${LOG:-/tmp/clone}"
CONC="${CONC:-3}"
mkdir -p "$LOG"

for d in /opt/homebrew/bin /usr/local/bin; do
  [ -d "$d" ] && case ":$PATH:" in *":$d:"*) ;; *) PATH="$d:$PATH" ;; esac
done
NVM_BIN="$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | sort -V | tail -1)"
[ -n "$NVM_BIN" ] && case ":$PATH:" in *":$NVM_BIN:"*) ;; *) PATH="$NVM_BIN:$PATH" ;; esac
export PATH

command -v node >/dev/null 2>&1 || { echo "[$(date)] FATAL: node not on PATH ($PATH)"; exit 1; }

# Fail loudly if the local database is not up. A fleet that starts against nothing and
# crash-loops for hours is the exact silent failure this whole exercise is about.
if ! psql "$DATABASE_URL" -X -A -t -c 'select 1' >/dev/null 2>&1; then
  echo "[$(date)] FATAL: cannot reach local database at $DATABASE_URL"
  echo "  start it with: brew services start postgresql@18"
  exit 1
fi

if [ "${FORCE:-0}" != "1" ] && pgrep -f "crawl-companies-local" >/dev/null 2>&1; then
  echo "[$(date)] crawlers already running — skipping launch (set FORCE=1 to override)"
  exit 0
fi

export DATABASE_URL
# NOT 'production': db/connection.js forces ssl when NODE_ENV=production and a local Postgres
# answers with "The server does not support SSL connections" — which surfaces only as a
# repeating `claim failed:` while the fleet stays up looking healthy. NODE_ENV only gates SSL,
# Redis TLS (retired) and pretty logging, so a third value disables SSL cleanly.
export NODE_ENV=local
echo "[$(date)] target: $DATABASE_URL  (concurrency $CONC)"

COMMON="CONCURRENCY=$CONC DELAY_MS=400 PG_POOL_MAX=2 SYNC_ABSENCE_REMOVAL=1 PROXY_DISABLED=1"

launch() { # name  ATS-list  [env-override]
  local name="$1" ats="$2" envs="${3:-$COMMON}"
  nohup bash -c "while true; do \
    env $envs ATS='$ats' node scripts/crawl-companies-local.js; \
    echo \"[\$(date)] $name exited rc=\$? — restarting in 5s\"; sleep 5; \
  done" >"$LOG/crawl-$name.log" 2>&1 &
  echo "  $name -> $ats"
}

# Workers per platform, allocated by active company count in the staging DB.
# NOT crawled, deliberately:
#   icims / oracle / taleo / adp / dayforce — excluded on request.
#   workable — IP-blocks outright and the IPRoyal proxy account died 2026-08-08; there is no
#              working path, so a worker here would burn sockets for nothing.
echo "launching 28 workers:"
launch bamboohr-1      "bamboohr"          # 16,160 companies -> 4 workers
launch bamboohr-2      "bamboohr"
launch bamboohr-3      "bamboohr"
launch bamboohr-4      "bamboohr"
launch paylocity-1     "paylocity"         # 10,392 -> 3
launch paylocity-2     "paylocity"
launch paylocity-3     "paylocity"
launch greenhouse-1    "greenhouse"        #  8,628 -> 3
launch greenhouse-2    "greenhouse"
launch greenhouse-3    "greenhouse"
launch jazzhr-1        "jazzhr"            #  5,055 -> 2
launch jazzhr-2        "jazzhr"
launch ashby-1         "ashby"             #  4,353 -> 2
launch ashby-2         "ashby"
# zoho is the slowest per company: the adapter fetches each job's detail page on top of the
# board page, and the tenant resolves across .com/.in/.com.au in turn.
launch zoho-1          "zoho"              #  4,042 -> 2
launch zoho-2          "zoho"
launch smartrecruiters-1 "smartrecruiters" #  3,997 -> 2
launch smartrecruiters-2 "smartrecruiters"
launch workday-1       "workday"           #  3,458 -> 2
launch workday-2       "workday"
launch rippling        "rippling"          #  3,073 -> 1
launch personio        "personio"          #  2,966 -> 1  (one XML request per company)
# breezy fetches a detail page PER JOB in batches of 5, so wall-clock scales with board size,
# and the default FETCH_TIMEOUT=60000 silently decapitates the biggest boards. Measured:
# HIKINEX (recruiting) 253 jobs = 54.7s -- right on the edge, so it flaps; sage-haus 537 jobs
# = 107.7s -- never once completed. The crawler treats the timeout as transient and re-dues the
# company, so it retries forever, fails identically forever, and reports status='active' with no
# error the whole time. Both boards showed 0 jobs while looking perfectly healthy.
# A sample of 40 zero-job breezy actives found 39 genuinely empty and 1 (sage-haus) a timeout
# victim -- rare, but it selects precisely for the largest, most valuable boards.
launch breezy          "breezy"            "$COMMON FETCH_TIMEOUT=300000"  #  2,637 -> 1
launch recruitee       "recruitee"         #  2,596 -> 1
launch lever           "lever"             #  2,588 -> 1
launch teamtailor      "teamtailor"        #  1,815 -> 1
launch pinpoint        "pinpoint"          #  1,181 -> 1
launch small           "comeet,jobvite"    #    456 -> 1 (combined)

####################################################################################################
# DESCRIPTION BACKFILLS
#
# The crawlers above are not enough on their own. Several ATS carry NO description in the list
# crawl — the body lives on each job's own detail page — so without these the staging DB fills
# with title-and-URL rows that are useless to promote. Measured on this database before the
# backfills were added:
#
#   paylocity  118,311 of 118,524 missing (99.8%)   <- list crawl carries no body at all
#   comeet       8,037 of   8,037 missing (100%)    <- description lives in the SEO page
#   jazzhr      15,068                     (23.9%)
#   personio 3,420 · breezy 2,062 · workday 780 · zoho 529 · lever 281 · smartrecruiters 231
#
# ~149,000 rows. Split by platform rather than one process for everything, so paylocity's very
# large backlog cannot starve the smaller ones behind it in the same queue.
####################################################################################################

# paylocity: biggest backlog by an order of magnitude (118k of 118k rows empty), so it is split
# four ways. The body is a JSON-LD JobPosting on each Jobs/Details/{id} page; direct fetch, no
# proxy, self-throttling.
#
# DESC_PARTITION_MOD/REMAINDER is required here, not optional. scanCandidates keeps its keyset
# cursor in PROCESS memory, so four unpartitioned runners on one platform all start at id 0 and
# re-fetch the same rows — four times the requests for one runner's progress. The partition
# splits the id space so each walks a disjoint quarter. Single-runner measured ~60 rows/round,
# roughly 16 hours for the backlog.
for rem in 0 1 2 3; do
  nohup bash -c "while true; do \
    env LOOP=1 RECHECK_S=900 PG_POOL_MAX=1 DESC_PARTITION_MOD=4 DESC_PARTITION_REMAINDER=$rem \
      node scripts/backfill-desc-generic.js paylocity; \
    echo \"[\$(date)] paylocity-$rem exited rc=\$? — restarting in 30s\"; sleep 30; \
  done" >"$LOG/backfill-paylocity-$rem.log" 2>&1 &
  echo "  backfill: paylocity partition $rem/4"
done

# comeet: the API has no descriptions; they are on each job's SEO page, fetched through Bright
# Data. BRIGHT_DATA_API_KEY in .env is the SUSPENDED account (returns 407 client_10020 —
# verified 2026-08-30), so the STANDBY key is passed in under the name the script reads. Without
# this substitution every comeet fetch fails silently and the 8,037 rows stay empty.
BD_STANDBY="$(grep -E '^BRIGHT_DATA_API_KEY_STANDBY=' .env 2>/dev/null | cut -d= -f2- | tr -d ' \r')"
if [ -n "$BD_STANDBY" ]; then
  nohup bash -c "while true; do \
    env LOOP=1 CONCURRENCY=6 BATCH=200 RECHECK_S=900 PG_POOL_MAX=1 BRIGHT_DATA_API_KEY='$BD_STANDBY' \
      node scripts/backfill-comeet-desc.js; \
    echo \"[\$(date)] comeet-desc exited rc=\$? — restarting in 30s\"; sleep 30; \
  done" >"$LOG/backfill-comeet.log" 2>&1 &
  echo "  backfill: comeet (using STANDBY BrightData key)"
else
  echo "  backfill: comeet SKIPPED — no BRIGHT_DATA_API_KEY_STANDBY in .env"
fi

# jazzhr on its own runner (15k backlog), then everything else in one.
nohup bash -c "while true; do \
  env LOOP=1 RECHECK_S=900 PG_POOL_MAX=1 node scripts/backfill-desc-generic.js jazzhr; \
  echo \"[\$(date)] jazzhr-desc exited rc=\$? — restarting in 30s\"; sleep 30; \
done" >"$LOG/backfill-jazzhr.log" 2>&1 &
echo "  backfill: jazzhr"

nohup bash -c "while true; do \
  env LOOP=1 RECHECK_S=900 PG_POOL_MAX=1 node scripts/backfill-desc-generic.js \
    personio breezy zoho lever smartrecruiters ashby greenhouse rippling bamboohr recruitee pinpoint workday; \
  echo \"[\$(date)] general-desc exited rc=\$? — restarting in 30s\"; sleep 30; \
done" >"$LOG/backfill-general.log" 2>&1 &
echo "  backfill: general (12 platforms)"

####################################################################################################
# DEAD-JOB PRUNING
#
# Removal here is by HTTP-confirmed 404/410 or an explicit dead-page phrase — never a diff
# heuristic. Two runners split the population by id (PARTITION_MOD=2, remainders 0 and 1).
# The prod launcher runs only remainder=1 because Render owns the even ids; this database has no
# Render worker, so both halves are ours or nothing checks them.
#
# CONCURRENCY=8, not higher: the pruner opens an HTTP request per candidate job, and at 25 it
# held 129 sockets with 351 in TIME_WAIT on 2026-08-13, which made macOS refuse new outbound
# connections and killed three crawlers with EADDRNOTAVAIL. Crawling is the higher-value work.
####################################################################################################
for rem in 0 1; do
  nohup bash -c "while true; do \
    env LOOP=1 INTERVAL_S=300 LIMIT=5000 CONCURRENCY=8 PARTITION_MOD=2 PARTITION_REMAINDER=$rem \
        PG_STATEMENT_TIMEOUT=120000 PG_POOL_MAX=2 node scripts/prune-dead-jobs-local.js; \
    echo \"[\$(date)] prune-$rem exited rc=\$? — restarting in 30s\"; sleep 30; \
  done" >"$LOG/prune-$rem.log" 2>&1 &
  echo "  pruner: partition $rem of 2"
done

echo "clone fleet launched against local Postgres."
echo "keep scripts/sync-local-to-prod.js SYNC_ATS in step with the platforms above."

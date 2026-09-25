#!/usr/bin/env bash
# Relaunch the local companion crawlers that support the Heroku board.
# Survives this shell (nohup + detached). Each company crawler auto-restarts on
# crash via a `while true` wrapper; a full machine reboot needs this script re-run.
#
# Partitioning is DISJOINT by ATS so no two instances hammer the same ATS
# (double-hitting triggers rate limits). Throttled: CONCURRENCY=3, DELAY_MS=400.
set -u
cd "$(dirname "$0")/.."

# Don't double-launch: if crawlers are already running (e.g. this fires at login
# but they're still up from before), bail out. FORCE=1 overrides.
if [ "${FORCE:-0}" != "1" ] && pgrep -f "crawl-companies-local|crawl-workable-marketplace" >/dev/null 2>&1; then
  echo "[$(date)] crawlers already running — skipping launch (set FORCE=1 to override)"
  exit 0
fi

# A LaunchAgent at login inherits a minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin) which holds
# neither `heroku` (/opt/homebrew/bin) nor `node` (nvm). On 2026-08-08 the Mac rebooted at 17:18,
# this fired at 17:20, `heroku` was not found, the old `2>/dev/null` swallowed "command not
# found", DATABASE_URL came back empty and line 20 exited 1. The entire fleet stayed down for
# 17 hours and the only trace was "FATAL: no DATABASE_URL", which named the symptom, not the
# cause. Put the interactive shell's directories back before anything needs them.
for d in /opt/homebrew/bin /usr/local/bin; do
  [ -d "$d" ] && case ":$PATH:" in *":$d:"*) ;; *) PATH="$d:$PATH" ;; esac
done
# nvm installs node outside any standard prefix and the version changes; take the newest present
# rather than pinning one that a future `nvm install` silently retires.
NVM_BIN="$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | sort -V | tail -1)"
[ -n "$NVM_BIN" ] && case ":$PATH:" in *":$NVM_BIN:"*) ;; *) PATH="$NVM_BIN:$PATH" ;; esac
export PATH

command -v node >/dev/null 2>&1 || { echo "[$(date)] FATAL: node not on PATH ($PATH)"; exit 1; }

# Fetching the URL needs the network, and at login Wi-Fi may not be associated yet — a single
# attempt ~2 minutes after boot is a coin flip. Retry, and print what actually failed.
# stdout and stderr are captured SEPARATELY on purpose. The heroku CLI writes an update-available
# warning to stderr on every invocation, so folding stderr into the value (2>&1) prepends that
# banner to the URL and the postgres* test fails while the correct URL sits in the string.
#
# Retrying cannot fix an EXPIRED LOGIN, which is the other way this has failed: on 2026-08-10 the
# reboot hit `HTTP Error 401` and the CLI sat there offering to open a browser, so all six
# attempts burned on a problem no amount of waiting resolves and the whole fleet stayed down.
# So the CLI is no longer the only source: the last known-good URL is cached to disk on every
# success and used when the CLI cannot answer. A rotated password makes the cached URL stale,
# which the crawlers report as an auth error — a loud, specific failure, unlike a silent no-start.
#
# 2026-09-25: production moved off Heroku to the VPS Postgres (deploy/coolify/README.md). The cache
# file is now the ONLY source: it holds the VPS URL via the co.fastapply.db-tunnel LaunchAgent
# (127.0.0.1:15432). Asking `heroku config:get` here would overwrite it with the retired Heroku
# database and silently send every script that reads this file back to it.
CACHE="$HOME/.fastapply-database-url"
DATABASE_URL=""
if [ -r "$CACHE" ]; then
  DATABASE_URL="$(cat "$CACHE")"
  case "$DATABASE_URL" in
    postgres*) echo "[$(date)] using DATABASE_URL from $CACHE" ;;
    *) DATABASE_URL="" ;;
  esac
fi

export DATABASE_URL
export NODE_ENV=production
[ -z "$DATABASE_URL" ] && { echo "[$(date)] FATAL: no usable DATABASE_URL in $CACHE"; exit 1; }
echo "[$(date)] DATABASE_URL resolved; launching fleet"

LOG=/tmp
# Postgres is standard-0 since 2026-08-05: 200 connections, not the 40 of essential-2.
# Pools are still kept small — the web dyno must always be able to open one (it was starved
# at 40/40 once, see feedback in git log) — but the fleet is no longer the binding constraint.
# SYNC_ABSENCE_REMOVAL=1 arms the absence counter: a job missing from 3 CONSECUTIVE successful
# syncs is retired at sync time, with no HTTP call and no browser. Armed 2026-08-26 after a day
# of observation showed the distribution was safe — 44,446 jobs at absent=1 but only 326 at
# absent=3, i.e. 99.3% of one-off absences self-corrected on the next sync. A noisy signal would
# have piled up at 2 and 3 instead.
COMMON="CONCURRENCY=3 DELAY_MS=400 PG_POOL_MAX=2 SYNC_ABSENCE_REMOVAL=1"

launch() { # name  ATS-list  logfile  [env-override]
  local name="$1" ats="$2" log="$3" envs="${4:-$COMMON}"
  nohup bash -c "while true; do \
    env $envs ATS='$ats' node scripts/crawl-companies-local.js; \
    echo \"[$(date)] $name exited rc=\$? — restarting in 5s\"; sleep 5; \
  done" >"$log" 2>&1 &
  echo "launched $name (ATS: $ats) -> $log  wrapper pid $!"
}

# SPLIT WITH THE RENDER WORKER, 2026-08-06. The Render worker (job-aggregator-va, CRAWL_ATS)
# owns workday, greenhouse, bamboohr, smartrecruiters and rippling — the platforms with working
# apply automation. They belong on always-on infrastructure: this Mac can be asleep and the home
# connection can drop, and those are the jobs users actually apply to.
#
# This fleet therefore keeps the rest, and picks up the large platforms whose apply automation
# is not built yet (icims/oracle/successfactors). Prospective inventory is the right thing to
# run on the machine that might go offline.
#
# The partition below must stay DISJOINT FROM CRAWL_ATS as well as within itself — two crawlers
# on one ATS means duplicate writes and both racing the same last_synced_at claims.

# Instance A (lever): works fine crawled DIRECT, so force PROXY_DISABLED=1 — the IPRoyal
# residential proxy is metered/often-down, and routing lever through it just fails (100% errors
# when the proxy lapses). bamboohr moved to the Render worker.
launch A "lever"                                   "$LOG/crawl-A.log" "$COMMON PROXY_DISABLED=1"
# B/C/F crawl DIRECT (PROXY_DISABLED=1). These ATS all expose public JSON APIs that
# don't IP-block, so the laptop's own residential IP is enough — the proxy added nothing
# but a socket leak. On the metered IPRoyal proxy they ran 100% errors (EADDRNOTAVAIL,
# ephemeral-port exhaustion) for ~71h and stored 0 jobs; direct they flow at hundreds/min.
launch B "recruitee,breezy"                        "$LOG/crawl-B.log" "$COMMON PROXY_DISABLED=1"
launch C "ashby"                                   "$LOG/crawl-C.log" "$COMMON PROXY_DISABLED=1"
# Instance F (icims) — RETIRED 2026-08-11. The premise above was that building prospective
# inventory "costs a local instance and nothing else". It stopped being free: with 12 crawlers
# plus the backfills running, the database went IO-bound (2 autovacuum workers 25min into a 23GB
# TOAST, a base backup mid-checkpoint, 8 of 9 active queries waiting), and the description
# backfill's candidate scan — the most timeout-sensitive query we run — started failing and
# cooling off platforms for an hour at a time. 76 cool-offs in one stretch.
#
# icims and taleo are the two worst offenders and the two with the least value: no apply
# automation, so users cannot act on the jobs, and both ran badly anyway — icims 285 errors over
# 1,000 companies, taleo 131 errors at 1 company/min. Dropping them buys back write capacity for
# the platforms users actually apply to. Re-enable when the apply automation lands.
# launch F "icims"                                 "$LOG/crawl-F.log" "$COMMON PROXY_DISABLED=1"
# Instance J (jazzhr): applytojob.com JSON API, works DIRECT. Added when the ats-slugs
# seed brought in ~2.5k jazzhr companies that nothing was crawling.
launch J "jazzhr"                                  "$LOG/crawl-J.log" "$COMMON PROXY_DISABLED=1"
# Instance TT (teamtailor): public {slug}.teamtailor.com/jobs.json feed, direct. Feed carries full
# descriptions (no backfill needed). Seeded ~1.5k companies from the ats-slugs dump. Caps 100/company.
launch TT "teamtailor"                             "$LOG/crawl-TT.log" "$COMMON PROXY_DISABLED=1"
# Instance JV (jobvite): jobs.jobvite.com/{slug}, server-rendered HTML — the listing carries every
# posting with no pagination and each detail page usually carries schema.org JobPosting ld+json
# (with an HTML fallback for the tenants that omit it). 40 boards seeded 2026-08-19 from
# scripts/discover-jobvite.js; more land as the re-probe finishes. Cloudflare fronts these sites
# and challenges bare scripted requests, but the adapter sends a browser UA and that is enough —
# the residential proxy is not needed and PROXY_DISABLED=1 keeps it off the shared IPRoyal budget.
launch JV "jobvite"                                "$LOG/crawl-JV.log" "$COMMON PROXY_DISABLED=1"
# Instance P (pinpoint): distinct host (pinpointhq.com), plain JSON API — but it
# FAILS through the residential proxy, so force PROXY_DISABLED=1 (crawls direct).
launch P "pinpoint"                                "$LOG/crawl-P.log" "$COMMON PROXY_DISABLED=1"
# Instance Cm (comeet): comeet.co careers-api, slug = "{UID}:{TOKEN}" (discovered
# via scripts/discover-comeet.js). Also crawls direct — PROXY_DISABLED=1.
launch Cm "comeet"                                 "$LOG/crawl-Cm.log" "$COMMON PROXY_DISABLED=1"
# Instance Pay (paylocity): recruiting.paylocity.com careers pages, slug = tenant GUID.
# Jobs live in a `window.pageData` blob (feed API is dead) — see src/adapters/paylocity.js.
# Works direct (no proxy); the adapter self-throttles with jitter+backoff.
launch Pay "paylocity"                              "$LOG/crawl-Pay.log" "$COMMON PROXY_DISABLED=1"
# Instance Z (zoho): split out of instance B, which was sharing one worker across four
# ATS. Zoho is now the largest local partition — 1,497 active boards after importing 506
# verified tenants from the role-keyword discovery — and it is the slowest per company,
# because the adapter fetches each job's detail page (DETAIL_BATCH_SIZE=3) on top of the
# board page. Sharing a quarter of one instance meant the new boards would take days to
# reach their first sync. Crawls direct; the tenant resolves on .com/.in/.com.au and the
# adapter probes those in turn. Keep zoho OUT of B — the partitions must stay disjoint or
# both instances hammer the same ATS.
launch Z "zoho"                                    "$LOG/crawl-Z.log" "$COMMON PROXY_DISABLED=1"
# Instance Pe (personio): added 2026-08-20. 3,325 boards arrived with the Sprout import and
# nothing was crawling them - personio was absent from this file AND from the Render worker's
# CRAWL_ATS, so half the import sat idle while every other imported ATS started producing.
# Disjoint from both, per the rule above.
#
# Cheapest partition in the fleet per job stored: one request per company to
# {slug}.jobs.personio.de/xml returns EVERY posting with full descriptions inline, so there is
# no per-job detail fetch and no description backfill - the opposite of taleo/icims, which were
# retired for costing a detail request per job.
#
# The adapter hardcodes .personio.de, which looks wrong for the ~37% of boards recorded on
# .personio.com. It is not: the TLDs are interchangeable on the XML feed, verified on both
# .com- and .de-registered tenants (identical position counts). Do not "fix" it per-tenant.
#
# Probe of 120 boards before launching: 73% serve jobs (12.9 avg), 27% 404 on a stale slug,
# 0 errors and 0 timeouts. Expect roughly 31k postings and ~900 boards to fail out as dead.
launch Pe "personio"                               "$LOG/crawl-Pe.log" "$COMMON PROXY_DISABLED=1"
# Instance T (taleo): 109 boards relabelled off the adapter-less taleo_* alias labels, each
# slug verified live via careersection/sitemap.jss. NOTE: adding 'taleo' to findDueForSync
# does NOT make it crawl — BullMQ/Redis is retired, so nothing calls that query; the ATS env
# list on these instances is the real allowlist. Concurrency 2 and a longer per-company
# timeout because taleo has no bulk listing endpoint: every job needs its own detail page
# (see src/adapters/taleo.js), so a board is slow even after the adapter was parallelised.
# RETIRED 2026-08-11 alongside instance F — see the note there. taleo is the worst value per unit
# of database load in the fleet: no apply automation, and because it has no bulk listing endpoint
# every job costs its own detail request, so it managed ~1 company/min with 131 errors over 280.
# launch T "taleo"                                 "$LOG/crawl-T.log" "CONCURRENCY=2 DELAY_MS=400 PG_POOL_MAX=2 FETCH_TIMEOUT=240000 PROXY_DISABLED=1"
# Instance E (workable direct via IPRoyal proxy) is gone. It ran a controlled one-time
# drain through a METERED residential proxy; the IPRoyal account died on 2026-08-08 and
# Workable now blocks outright rather than rate-limiting per IP, so the script was
# removed. Workable descriptions have no working path until a new proxy is provisioned.

# Marketplace deep crawl: one-shot walk of the full ~170k; auto-restart resumes
# from the top if it dies (upserts dedupe, so re-walking is harmless).
nohup bash -c "while true; do \
  env MARKETPLACE_MAX_PAGES=8500 PG_POOL_MAX=2 node src/tasks/crawl-workable-marketplace.js; \
  echo \"[\$(date)] MKT exited rc=\$? — restarting in 30s\"; sleep 30; \
done" >"$LOG/crawl-MKT.log" 2>&1 &
echo "launched MKT (workable marketplace deep) -> $LOG/crawl-MKT.log  wrapper pid $!"

# Comeet description backfill: comeet's API has no descriptions — they live in each
# job's SEO page (og:description), fetched via Bright Data. LOOP re-checks for newly
# crawled jobs; auto-restart wrapper survives OS reaping of the idle sleep.
nohup bash -c "while true; do \
  env LOOP=1 CONCURRENCY=6 BATCH=200 RECHECK_S=900 PG_POOL_MAX=1 node scripts/backfill-comeet-desc.js; \
  echo \"[\$(date)] comeet-desc exited rc=\$? — restarting in 30s\"; sleep 30; \
done" >"$LOG/backfill-comeet.log" 2>&1 &
echo "launched comeet description backfill -> $LOG/backfill-comeet.log  wrapper pid $!"

# Paylocity description backfill: paylocity's list crawl carries no description; the full
# text is on each Jobs/Details/{id} page as a JSON-LD JobPosting (backfill-descriptions.js
# fetchPaylocityDescription). Direct fetch, no proxy; self-throttles (UA-rotation + jitter).
# LOOP re-checks for newly crawled jobs; batch/concurrency come from ATS_CONFIG (60/3).
nohup bash -c "while true; do \
  env LOOP=1 RECHECK_S=900 PG_POOL_MAX=1 node scripts/backfill-desc-generic.js paylocity; \
  echo \"[\$(date)] paylocity-desc exited rc=\$? — restarting in 30s\"; sleep 30; \
done" >"$LOG/backfill-paylocity.log" 2>&1 &
echo "launched paylocity description backfill -> $LOG/backfill-paylocity.log  wrapper pid $!"


# Local half of the dead-job-pruning split. Render's worker owns the EVEN ids; this owns the
# ODD ones. Verified by real HTTP checks against each job's own career-page URL — only a
# confirmed 404/410 or an explicit dead-page phrase removes anything, never a guess.
#
# LIMIT 500 -> 5000 and CONCURRENCY 10 -> 25 on 2026-08-06, after removing the ORDER BY that
# made the candidate query scan and sort the entire backlog per batch (see dead-job-check.js).
# Unordered it is 3.4s for 500 rows and 33s for 20,000, so a big batch is now affordable where
# 1,000 previously could not finish at all. Measured backlog was ~2.7M eligible jobs against
# 400/hr — a full pass every 281 days. This side does ~25,000/hr.
#
# PG_STATEMENT_TIMEOUT is raised because the pool default (15s) is tuned for the API, and the
# scan legitimately runs longer than that here. PG_POOL_MAX stays small — the 40-connection
# ceiling in this comment's original form is long gone (standard-0 allows 200, ~25 in use), but
# there is no reason for a background loop to hold more than it needs.
#
# CONCURRENCY was 25 and that number is about DATABASE cost, which is no longer the binding
# constraint — the binding constraint is SOCKETS. The pruner makes an HTTP liveness request per
# candidate job, so 25-way concurrency held 129 open sockets on 2026-08-13, roughly 5x more than
# any crawler, with 351 connections sitting in TIME_WAIT. macOS then refused new outbound
# connections and three crawlers failed on `read EADDRNOTAVAIL`: zoho 966 errors at 2/min, jazzhr
# 140, pinpoint down to 66 jobs across 1,857 companies.
#
# 8 keeps this useful (it still clears thousands of rows an hour) while leaving ports for the
# crawlers, which are the higher-value work — a dead job that lingers an extra day costs far less
# than a live job never fetched.
nohup bash -c "while true; do \
  env LOOP=1 INTERVAL_S=300 LIMIT=5000 CONCURRENCY=8 PARTITION_REMAINDER=1 \
      PG_STATEMENT_TIMEOUT=120000 PG_POOL_MAX=2 node scripts/prune-dead-jobs-local.js; \
  echo \"[\$(date)] prune-dead-local exited rc=\$? — restarting in 30s\"; sleep 30; \
done" >"$LOG/prune-dead-local.log" 2>&1 &
echo "launched prune-dead-jobs-local (odd-id partition) -> $LOG/prune-dead-local.log  wrapper pid $!"

# General description backfill: fills descriptions for the id-based ATS (greenhouse, lever, ashby,
# workday, icims, bamboohr, rippling, smartrecruiters, pinpoint, personio, taleo, ...) — the ones
# whose list crawl carries no body. Loops backfillDescriptions() every 2 min. migrate() is OFF
# (it crash-looped on boot under crawl load); IPROYAL_* passed for oracle's proxy-render path.
IPROYAL_ENVS="$(grep -E "^IPROYAL_PROXY_(HOST|PORT|USER|PASS|LIFETIME)=" .env 2>/dev/null | sed -E "s/^([A-Z_]+)=(.*)$/\1='\2'/" | tr "\n" " ")"
# PG_POOL_MAX=2: it runs all ATS in parallel so it bursts connections; keep it small to stay under
# the essential-2 40-conn cap alongside the ~9 crawlers + other backfills + Render + web dynos.
nohup bash -c "while true; do \
  env PG_POOL_MAX=1 $IPROYAL_ENVS node scripts/local-backfill-descriptions.js; \
  echo \"[\$(date)] desc-backfill exited rc=\$? — restarting in 30s\"; sleep 30; \
done" >"$LOG/backfill-desc.log" 2>&1 &
echo "launched general description backfill -> $LOG/backfill-desc.log  wrapper pid $!"

echo "all crawlers launched."

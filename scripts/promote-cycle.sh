#!/usr/bin/env bash
# One full promotion cycle: local staging -> production.
#
# Designed for cron. The crawl side of this system is supervised and continuous; promotion was
# not, so ~1,100-2,100 jobs an hour accumulated in jobs_local with nothing moving them. This
# closes that loop.
#
#   0 */6 * * * /Users/codev/job-aggregator/scripts/promote-cycle.sh >/dev/null 2>&1
#
# Safe to run at any time and safe to overlap-guard: every step is idempotent, both promoter
# modes checkpoint per employer, and the URL dedup means re-running only ever adds what is
# genuinely new.
set -uo pipefail

# EVERY binary absolute or PATH-repaired: cron runs with /usr/bin:/bin:/usr/sbin:/sbin, which has
# neither homebrew's node nor psql. log-health.sh learned this the hard way.
for d in /opt/homebrew/bin /usr/local/bin; do
  [ -d "$d" ] && case ":$PATH:" in *":$d:"*) ;; *) PATH="$d:$PATH" ;; esac
done
export PATH

REPO="${REPO:-$(cd "$(dirname "$0")/.." && pwd)}"
LOCAL_URL="${LOCAL_URL:-postgres://codev@localhost:5432/jobs_local}"
LOG="${PROMOTE_LOG:-$HOME/promote-cycle.log}"
cd "$REPO" || exit 1

command -v node >/dev/null 2>&1 || { echo "$(date -u '+%F %T')  FATAL node not on PATH" >>"$LOG"; exit 1; }
command -v psql >/dev/null 2>&1 || { echo "$(date -u '+%F %T')  FATAL psql not on PATH" >>"$LOG"; exit 1; }

# Don't stack cycles. A run can take hours; a second one on top would double the load on prod
# and fight over the same checkpoints.
if pgrep -f "promote-missing-to-prod" >/dev/null 2>&1; then
  echo "$(date -u '+%F %T')  skipped — a promoter is already running" >>"$LOG"
  exit 0
fi

say() { echo "$(date -u '+%F %T')  $*" >>"$LOG"; }
say "=== cycle start ==="

# The blanket last_seen_at re-stamp that used to live here is GONE, deliberately.
#
# It set last_seen_at=NOW() on every enriched simplify row older than 24h — 1,076,651 of them on
# its one and only run. That is not a safety net, it is faking freshness: the simplify corpus was
# liveness-checked ONCE during enrichment, nothing re-checks it (those jobs hang off placeholder
# companies no crawler covers), so its rows legitimately age out. Re-stamping tells the promoter's
# MAX_AGE_H guard they were just seen when they were not — the same mistake that put 7,600
# nine-day-old svetness jobs into production, except on a six-hour timer.
#
# The corpus is a completed one-time import, already promoted. What belongs in a RECURRING cycle
# is the crawled corpus, whose freshness is real because 28 local crawlers re-verify it constantly.

# The employer map is only needed by SOURCE=simplify, which is not in the default set, so it is
# rebuilt only when that mode is actually requested. Unconditionally it cost 2+ minutes a cycle
# casting (raw_data::jsonb)->>'source' across 3.1M unindexed rows for nothing.
case " ${PROMOTE_SOURCES:-crawled} " in
  *" simplify "*)
    MAPPED=$(psql "$LOCAL_URL" -X -A -t -c "
      INSERT INTO simplify_employer_map (job_id, ats, slug)
      SELECT id, ats, slug FROM (
        SELECT j.id, j.ats,
          CASE
            WHEN b.bare ~ '\.myworkdayjobs\.com'   THEN split_part(b.bare,'.',1)
            WHEN b.bare ~ 'greenhouse\.io/'        THEN split_part(b.bare,'/',2)
            WHEN b.bare ~ '^jobs\.lever\.co/'      THEN split_part(b.bare,'/',2)
            WHEN b.bare ~ '^jobs\.ashbyhq\.com/'   THEN split_part(b.bare,'/',2)
            WHEN b.bare ~ '^apply\.workable\.com/' THEN split_part(b.bare,'/',2)
            WHEN b.bare ~ '^jobs\.smartrecruiters\.com/' THEN split_part(b.bare,'/',2)
            WHEN b.bare ~ '\.applytojob\.com'      THEN split_part(b.bare,'.',1)
            WHEN b.bare ~ '\.bamboohr\.com'        THEN split_part(b.bare,'.',1)
            WHEN b.bare ~ '\.breezy\.hr'           THEN split_part(b.bare,'.',1)
            WHEN b.bare ~ '^ats\.rippling\.com/'   THEN split_part(b.bare,'/',2)
            WHEN b.bare ~ '\.teamtailor\.com'      THEN split_part(b.bare,'.',1)
            WHEN b.bare ~ '\.recruitee\.com'       THEN split_part(b.bare,'.',1)
            WHEN b.bare ~ '\.pinpointhq\.com'      THEN split_part(b.bare,'.',1)
            ELSE NULL END AS slug
        FROM jobs j
        CROSS JOIN LATERAL (SELECT regexp_replace(split_part(split_part(j.url,'?',1),'#',1),'^https?://','') AS bare) b
        WHERE (j.raw_data::jsonb)->>'source'='simplify'
          AND j.url NOT LIKE 'https://simplify.jobs/%'
          AND j.removed_at IS NULL
      ) t WHERE slug IS NOT NULL AND slug <> ''
      ON CONFLICT (job_id) DO NOTHING;" 2>&1 | tail -1)
    say "employer map: $MAPPED"
    ;;
esac

# Fresh checkpoints each cycle so churn at already-promoted employers is picked up — that churn is
# the entire point of running this repeatedly. OUTBOX_MAX paces against the Meili sync: an unpaced
# run drove the index 244,562 rows behind and fired a user-facing alert.
for SRC in ${PROMOTE_SOURCES:-crawled}; do
  CP="/tmp/promote-cycle-$SRC.checkpoint"
  rm -f "$CP"
  say "--- $SRC ---"
  # FULL output to its own file. The first cycle piped this through grep, so when the simplify
  # pass died after 26 minutes there was no error text left to explain why.
  RUNLOG="/tmp/promote-cycle-$SRC-$(date -u '+%Y%m%d-%H%M').log"
  # INSERT_BATCH is 100, NOT 1000. Each row carries a full job description -- measured at 7.3 KB
  # average -- so a 1000-row statement ships ~7.1 MB of bind parameters from this laptop to Heroku
  # over a home uplink shared with 78 crawlers. Postgres showed those INSERTs sitting in
  # wait_event_type='Client': the server was idle, waiting on US to finish sending. They ran past
  # the 180s statement_timeout and were cancelled, so every large employer failed permanently.
  # That is what made the 2026-09-11 17:00 cycle stop inserting at employer 5,020 of 55,609 and
  # then fail the remaining 50,589 -- while still exiting rc=0. 100 rows is ~710 KB, which clears
  # the timeout with room to spare.
  SOURCE=$SRC APPLY=1 CONCURRENCY=5 INSERT_BATCH=100 OUTBOX_MAX=40000 \
    CHECKPOINT="$CP" node scripts/promote-missing-to-prod.js >"$RUNLOG" 2>&1
  rc=$?
  say "  rc=$rc  full log: $RUNLOG"
  # rc=2 is the promoter's error circuit breaker. Make it impossible to miss in the summary log:
  # the whole point of the breaker is that a broken cycle stops looking like a successful one.
  [ "$rc" = "2" ] && say "  !! ABORTED by circuit breaker — promotion did NOT complete, see $RUNLOG"
  tr '\r' '\n' <"$RUNLOG" | grep -E "companies (examined|CREATED)|jobs (examined|already|INSERTED)|errors " \
    | tr -s ' ' | while IFS= read -r line; do [ -n "$line" ] && say "  $line"; done
  tr '\r' '\n' <"$RUNLOG" | grep -iE "^FATAL|error on" | head -3 \
    | while IFS= read -r line; do [ -n "$line" ] && say "  ! $line"; done
done

say "=== cycle end ==="

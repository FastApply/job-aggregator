#!/bin/bash
# Map newly pulled aggregator rows (agg_raw: sprout, aiapply and the other pull-aggregators-local.js
# sources) into staging companies/jobs, so the next promote-cycle.sh run ships them to prod. Cron
# runs it 30 minutes before each promote run. SOURCES overrides the list (simplify is left out: it
# has its own pipeline). One lock for all of them, because map-aggregators-local.js rebuilds the
# same agg_mapped/agg_todo tables on every run.
#
# The pull itself (pull-aggregators-local.js SOURCES=sprout) runs for days on its own; this only
# maps what has arrived since the previous run, using SINCE, so each pass stays proportional to the
# new rows rather than re-reading the whole pull.
set -u
cd "$(dirname "$0")/.." || exit 1
LOG="$HOME/agg-logs/sprout-cycle.log"
STATE="$HOME/agg-logs/sprout-cycle.since"
NODE="${NODE:-/opt/homebrew/bin/node}"
mkdir -p "$HOME/agg-logs"

# Skip if a previous pass is still mapping.
LOCK="$HOME/agg-logs/sprout-cycle.lock"
if ! mkdir "$LOCK" 2>/dev/null; then echo "$(date -u +%FT%TZ) previous pass still running, skipped" >>"$LOG"; exit 0; fi
trap 'rmdir "$LOCK"' EXIT

START=$(date -u +%Y-%m-%dT%H:%M:%SZ)
SINCE=$(cat "$STATE" 2>/dev/null || echo "1970-01-01T00:00:00Z")
echo "$START mapping sprout rows pulled since $SINCE" >>"$LOG"
if SOURCES="${SOURCES:-sprout,aiapply,liftmycv,wonsulting,jobhose,jobloo,resumly,trueup,trulyremotework,thehub,allscm}" SINCE="$SINCE" APPLY=1 "$NODE" scripts/map-aggregators-local.js >>"$LOG" 2>&1; then
  echo "$START" >"$STATE"
  echo "$(date -u +%FT%TZ) done" >>"$LOG"
else
  echo "$(date -u +%FT%TZ) FAILED, will retry the same window next run" >>"$LOG"
fi

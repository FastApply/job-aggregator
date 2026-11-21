#!/usr/bin/env bash
# Keep staging level with the aggregator pulls.
#
# The pulls (scripts/pull-aggregators-local.js) run for days and keep appending to agg_raw, so a
# single mapping pass is always behind by whatever arrived after it started. This sweeps every
# SWEEP_MINUTES, mapping only the records pulled since the last sweep — proportional to new arrivals
# rather than to the 4.7M rows already mapped.
#
#   nohup scripts/map-aggregators-sweep.sh > ~/map-sweep.log 2>&1 &
#
# Env: SWEEP_MINUTES (default 60), SWEEP_LOG (default ~/map-sweep.log).
set -uo pipefail
for d in /opt/homebrew/bin /usr/local/bin; do
  [ -d "$d" ] && case ":$PATH:" in *":$d:"*) ;; *) PATH="$d:$PATH" ;; esac
done
export PATH
REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" || exit 1
MINUTES="${SWEEP_MINUTES:-60}"
LOG="${SWEEP_LOG:-$HOME/map-sweep.log}"
say() { echo "$(date '+%F %T')  $*" >>"$LOG"; }

while true; do
  # A sweep overlapping the previous one would fight over agg_mapped/agg_todo, so skip instead.
  if pgrep -f "map-aggregators-local.js" >/dev/null 2>&1; then
    say "skipped — a mapping pass is already running"
  else
    # Overlap the window by 10 minutes: a record fetched while the last sweep was reading is
    # otherwise missed by both, and re-mapping a few thousand rows costs nothing (URL dedup drops
    # what is already there).
    SINCE="$(date -u -v-$((MINUTES + 10))M '+%Y-%m-%d %H:%M:%S+00')"
    say "sweep start (records pulled since $SINCE UTC)"
    APPLY=1 SINCE="$SINCE" node scripts/map-aggregators-local.js >>"$LOG" 2>&1
    say "sweep end rc=$?"
  fi
  # Stop once every pull has exited — nothing new can arrive after that.
  if ! pgrep -f "pull-aggregators-local.js" >/dev/null 2>&1; then
    say "no pulls left running — final sweep done, exiting"
    exit 0
  fi
  sleep $((MINUTES * 60))
done

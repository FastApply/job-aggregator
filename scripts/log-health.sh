#!/bin/bash
#
# Append one line of board-health metrics to a log. Designed to run hourly from cron.
#
# EVERY BINARY IS AN ABSOLUTE PATH. cron runs with a near-empty environment — no nvm shims, no
# /opt/homebrew on PATH — so `node` and `render` are simply not found the way they are in an
# interactive shell. A cron job that silently logs nothing is worse than no cron job, which is
# why this also writes a line on failure rather than exiting quietly.
#
# The database URL comes from ~/.fastapply-database-url, the same cached credential the crawler
# fleet reads. Calling `heroku config:get` here would work interactively and then fail under cron,
# where the netrc lookup has no HOME set the way it expects.
#
# Metrics and why each one is here:
#   absent=1/2/3   the absence counter's shape. absent=3 is the bucket that gets retired, so if it
#                  CLIMBS steadily the signal has drifted and SYNC_ABSENCE_REMOVAL should come off.
#                  Flat or falling means jobs reach the threshold and clear.
#   retired_1h     how much the pruners are actually removing.
#   outbox         rows waiting to reach the search index. Swings 0-3k between drains; a number
#                  that only grows means removals are not reaching users.
#   meili p50/p90  search latency.
#   fallbacks      searches that gave up on Meili and hit Postgres. THIS IS THE ONE THAT MATTERS —
#                  it is the mechanism that took the board down on 2026-08-20. Latency alone is
#                  invisible to users; fallbacks are not.
#   conns          Postgres connections against the 40 the role is allowed.
#   rss            this machine's total memory, since the whole fleet runs here.

set -uo pipefail

# Absolute paths, because cron runs with a near-empty PATH — no nvm shim, no /opt/homebrew.
# Resolved at RUN TIME rather than hardcoded, so this works on any machine: `command -v` is
# evaluated by the interactive-ish shell running this script, not by cron's stripped one.
# Override any of them from the environment if the layout differs.
NODE="${NODE:-$(command -v node || echo /usr/local/bin/node)}"
REPO="${REPO:-$(cd "$(dirname "$0")/.." && pwd)}"
LOG="${HEALTH_LOG:-$HOME/job-board-health.log}"

TS=$(/bin/date -u '+%Y-%m-%d %H:%M')

DB=$(/bin/cat "$HOME/.fastapply-database-url" 2>/dev/null)
if [ -z "$DB" ]; then
  echo "$TS  ERROR no database url" >> "$LOG"
  exit 1
fi

# The db module's pino logger writes its JSON to STDOUT and without a trailing newline, so the
# metrics come back glued to a log blob: `conns=17{"level":30,...}`. Filtering with `grep -v msg`
# therefore dropped the entire line, metrics included — the numbers vanished while the surrounding
# log line still looked fine. Strip the JSON objects out instead of discarding the line.
DBLINE=$(cd "$REPO" && NODE_ENV=production DATABASE_URL="$DB" PG_STATEMENT_TIMEOUT=120000 \
  "$NODE" scripts/health-metrics.js 2>/dev/null | /usr/bin/sed 's/{[^{}]*}//g' | /usr/bin/tr -d '\n')
[ -z "$DBLINE" ] && DBLINE="db_unreachable"

# Meili latency and fallbacks used to come from `render logs` on the services that held the API
# and the index. Those were suspended when the board moved to the Coolify VPS on 2026-09-25, so
# for five weeks this logged an empty latency and fallbacks_1h=0 whatever the board was doing,
# and 0 is what the alarm looks like when all is well. The logs are in Coolify now, which this
# machine cannot read, so these say they are unknown rather than pass for a measurement.
MEILI="p50=? p90=? max=?"
FB="unknown"

CRAWLERS=$(/bin/ps -Ao pid=,ppid=,command= | /usr/bin/grep 'crawl-companies-local.js' | /usr/bin/grep -v grep | /usr/bin/awk '$2!=1' | /usr/bin/wc -l | /usr/bin/tr -d ' ')
PRUNERS=$(/bin/ps -Ao pid=,ppid=,command= | /usr/bin/grep 'prune-dead-jobs-local' | /usr/bin/grep -v grep | /usr/bin/awk '$2!=1' | /usr/bin/wc -l | /usr/bin/tr -d ' ')
RSS=$(/bin/ps -Ao rss= | /usr/bin/awk '{s+=$1} END{printf "%.1fGB", s/1048576}')

echo "$TS  $DBLINE  meili[$MEILI] fallbacks_1h=$FB  crawlers=$CRAWLERS pruners=$PRUNERS rss=$RSS" >> "$LOG"

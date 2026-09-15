#!/usr/bin/env bash
# Boot-time entry point for the local crawl fleet, invoked by launchd.
#
# The fleet is ~80 nohup'd node processes started by launch-clone-localdb.sh. Nothing brought them
# back after a restart: on 2026-09-15 the laptop rebooted at ~06:50 and every crawler, backfiller
# and the in-flight promotion cycle died silently. Nobody noticed for three hours, and /tmp went
# with them so there was not even a log to notice from. This is the one thing the whole fleet
# was missing to survive a reboot.
#
# launchd runs this with a minimal environment: no homebrew on PATH, no HOME-derived config, and
# possibly BEFORE postgresql@18 (also a launchd job) has finished coming up. So: fix PATH, then
# wait for the database rather than fail on it, then hand off to the normal launcher, which is
# idempotent (it exits 0 if crawlers are already running, so a second invocation is harmless).
export PATH="/opt/homebrew/bin:/opt/homebrew/opt/postgresql@18/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export HOME="${HOME:-/Users/codev}"
REPO="/Users/codev/job-aggregator"
DB="postgres://codev@localhost:5432/jobs_local"
LOG="/Users/codev/fleet-boot.log"   # NOT /tmp: that is what the reboot erased.

log() { echo "$(date '+%F %T')  $*" >>"$LOG"; }
log "=== boot launcher invoked ==="

for i in $(seq 1 60); do
  if psql "$DB" -X -A -t -c 'select 1' >/dev/null 2>&1; then log "postgres ready after ${i}0s"; break; fi
  [ "$i" = 60 ] && { log "FATAL: postgres not reachable after 10 minutes — fleet NOT started"; exit 1; }
  sleep 10
done

# /tmp/clone is where the launcher writes per-crawler logs; a reboot removes it.
mkdir -p /tmp/clone
cd "$REPO" || { log "FATAL: repo missing at $REPO"; exit 1; }
./scripts/launch-clone-localdb.sh >>"$LOG" 2>&1
rc=$?
log "launcher exited rc=$rc; crawlers now running: $(ps -eo args | grep -c '[c]rawl-companies-local')"
exit $rc

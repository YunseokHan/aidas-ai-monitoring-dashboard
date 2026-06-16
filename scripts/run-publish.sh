#!/usr/bin/env bash
# Publish one dashboard snapshot without overlapping cron invocations and keep
# the append-only operational log bounded.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG="$ROOT/data/publish.log"
LOCK="$ROOT/data/publish.lock"
PY="${PYTHON:-/mnt/data/miniconda3/bin/python3}"
MAX_LOG_BYTES=$((5 * 1024 * 1024))
KEEP_LOGS=3

rotate_log() {
  [ -f "$LOG" ] || return 0
  local size
  size="$(stat -c %s "$LOG" 2>/dev/null || echo 0)"
  [ "$size" -lt "$MAX_LOG_BYTES" ] || {
    local i
    for ((i=KEEP_LOGS; i>=1; i--)); do
      [ -f "$LOG.$i" ] && mv -f "$LOG.$i" "$LOG.$((i + 1))"
    done
    mv -f "$LOG" "$LOG.1"
  }
}

mkdir -p "$ROOT/data"
exec 9>"$LOCK"
flock -n 9 || exit 0
rotate_log
exec >>"$LOG" 2>&1
cd "$ROOT"
exec "$PY" publish.py --push

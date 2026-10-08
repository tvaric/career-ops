#!/bin/bash
# daily-run.sh — fork-local. Scan → local triage → Telegram. Scheduled by: node schedule.mjs install
# Manual run: bash ~/career-ops/daily-run.sh
cd "$(dirname "$0")" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
LOG="data/daily-run.log"
LOCK="data/.daily-run.lock"

fail() { echo "$(date '+%F %T') FAIL: $1" >> "$LOG"; node notify-telegram.mjs --error "$1" >> "$LOG" 2>&1; rmdir "$LOCK" 2>/dev/null; exit 1; }

mkdir "$LOCK" 2>/dev/null || { echo "$(date '+%F %T') skip: previous run still going" >> "$LOG"; exit 0; }
echo "$(date '+%F %T') start" >> "$LOG"

# Ollama must be up for the local model
if ! curl -s -m 3 http://localhost:11434/api/tags >/dev/null; then
  open -a Ollama 2>/dev/null || (ollama serve >/dev/null 2>&1 &)
  for i in $(seq 1 30); do curl -s -m 2 http://localhost:11434/api/tags >/dev/null && break; sleep 2; done
  curl -s -m 3 http://localhost:11434/api/tags >/dev/null || fail "Ollama не запустилась"
fi

node scan.mjs >> "$LOG" 2>&1 || fail "scan.mjs завершився з помилкою (див. data/daily-run.log)"
node local-triage.mjs >> "$LOG" 2>&1 || fail "local-triage.mjs завершився з помилкою (див. data/daily-run.log)"
node notify-telegram.mjs >> "$LOG" 2>&1 || fail "notify-telegram.mjs не надіслав (див. data/daily-run.log)"

echo "$(date '+%F %T') done" >> "$LOG"
rmdir "$LOCK" 2>/dev/null

#!/usr/bin/env bash
cd C:/schoolPersonalProjects/CycloneIVSimulations || exit 1
SUMMARY=docs/evidence/FINAL_GATE_SUMMARY.txt
: > "$SUMMARY"
run() {
  local name="$1" url="$2"
  printf 'START %s %s\n' "$name" "$(date +%T)" >> "$SUMMARY"
  node "frontend/scripts/$name" "$url" > "docs/evidence/final-e2e-${name%.mjs}.log" 2>&1
  printf 'DONE  %s exit=%s %s\n' "$name" "$?" "$(date +%T)" >> "$SUMMARY"
}
run transport-controls-e2e.mjs http://127.0.0.1:8765/
run partcd-e2e.mjs http://127.0.0.1:8765/
run buzz1-e2e.mjs http://127.0.0.1:8765/
run realtime-interaction-e2e.mjs http://127.0.0.1:8000/
run terminal-e2e.mjs http://127.0.0.1:8000/
run dynamic-board-e2e.mjs http://127.0.0.1:8000/
run studio-screenshots.mjs http://127.0.0.1:8000/
printf 'ALL_DONE %s\n' "$(date +%T)" >> "$SUMMARY"

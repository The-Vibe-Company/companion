#!/usr/bin/env bash
set -euo pipefail

recordings_dir="${COMPANION_RECORDINGS_DIR:-$HOME/.companion/recordings}"
session_id="${1:-}"

if [[ ! -d "$recordings_dir" ]]; then
  echo "Recordings directory not found: $recordings_dir"
  exit 1
fi

latest_file=""
if [[ -n "$session_id" ]]; then
  latest_file="$(ls -1t "$recordings_dir"/"${session_id}"*_claude_*.jsonl 2>/dev/null | head -n 1 || true)"
else
  latest_file="$(ls -1t "$recordings_dir"/*_claude_*.jsonl 2>/dev/null | head -n 1 || true)"
fi

if [[ -z "$latest_file" ]]; then
  echo "No Claude recording files found in: $recordings_dir"
  exit 1
fi

stream_events="$(rg -c -F '"raw":"{\"type\":\"stream_event\"' "$latest_file" || true)"
assistant_events="$(rg -c -F '"raw":"{\"type\":\"assistant\"' "$latest_file" || true)"
result_events="$(rg -c -F '"raw":"{\"type\":\"result\"' "$latest_file" || true)"

echo "Recording: $latest_file"
echo "stream_event count: ${stream_events:-0}"
echo "assistant count:    ${assistant_events:-0}"
echo "result count:       ${result_events:-0}"

if [[ "${stream_events:-0}" == "0" ]]; then
  echo "No stream_event chunks detected in this recording."
  exit 2
fi

echo "Streaming chunks detected."

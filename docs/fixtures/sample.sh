#!/usr/bin/env bash
# sample.sh — Bash highlighting fixture
set -euo pipefail

ROOT="${1:-$PWD}"
count=0

for f in "$ROOT"/*.md; do
  [ -e "$f" ] || continue
  lines=$(wc -l < "$f")
  echo "$f: $lines lines"
  count=$((count + 1))
done

if [[ $count -eq 0 ]]; then
  echo "no markdown files in $ROOT" >&2
  exit 1
fi

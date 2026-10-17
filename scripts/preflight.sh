#!/usr/bin/env bash
# Fast preflight while editing: every closure validator in gate 2 of scripts/verify.sh (the same
# list, read from that file so the two never drift), plus generated-contract freshness. It needs no
# database, build, or browser and is not an acceptance result; CI runs the full gates.
set -euo pipefail
cd "$(dirname "$0")/.."
status=0
while IFS= read -r cmd; do
  if ! out=$($cmd 2>&1); then
    printf '%s\n' "$out" | grep -E 'FAIL|ERROR' | head -20
    printf 'PREFLIGHT: %s failed\n' "$cmd"
    status=1
  fi
done < <(grep -E '^[[:space:]]+python3 docs/(architecture|engineering)/tools/phase[0-9a-z]+\.py$' scripts/verify.sh | sed 's/^[[:space:]]*//')
node packages/contracts/scripts/generate.mjs --check || status=1
node packages/work/scripts/generate-mcp-registry.mjs --check || status=1
[ "$status" -eq 0 ] && printf 'PREFLIGHT: all validators and generated contracts pass\n'
exit "$status"

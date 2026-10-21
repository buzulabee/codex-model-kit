#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
NODE=""
for candidate in "${CODEX_MCP_NODE_PATH:-}" "${CODEX_ELECTRON_RESOURCES_PATH:+$CODEX_ELECTRON_RESOURCES_PATH/cua_node/bin/node}" "$(command -v node || true)"; do
  [ -n "$candidate" ] || continue
  if "$candidate" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' 2>/dev/null; then
    NODE=$candidate
    break
  fi
done
if [ -z "$NODE" ]; then
  printf '%s\n' 'No Node >=24 found. Use the Codex desktop Node via CODEX_MCP_NODE_PATH or install Node >=24. Nothing was installed.' >&2
  exit 1
fi
exec "$NODE" "$ROOT/install.mjs" "$@"

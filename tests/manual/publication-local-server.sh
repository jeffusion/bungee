#!/usr/bin/env bash
set -euo pipefail

# Disposable real management service only. No production files or credentials.
repo="$(cd "$(dirname "$0")/../.." && pwd)"
ui_port="$(bun -e 'const u=new URL(process.env.PUBLICATION_UI_URL??"http://127.0.0.1:28287");if(!["127.0.0.1","localhost"].includes(u.hostname))throw new Error("Only disposable local UI services are permitted");console.log(Number(u.port||80));')"
state="${1:-${PUBLICATION_EVIDENCE_ROOT:-/tmp/bungee-publication}/ui-local-state}"
state="$(realpath -m "$state")"
case "$state" in "${PUBLICATION_EVIDENCE_ROOT:-/tmp/bungee-publication}/"*) ;; *) echo 'State must be under PUBLICATION_EVIDENCE_ROOT (default /tmp/bungee-publication/)' >&2; exit 1 ;; esac
mkdir -p "$state"
chmod 700 "$state"
entry="$repo/packages/core/dist/main.js"
if [ ! -f "$entry" ] || [ ! -d "$repo/packages/core/dist/plugins" ]; then
  echo 'Run bun run build before starting the disposable service.' >&2
  exit 1
fi
cd "$state"
if [ ! -e "$state/bungee.db" ]; then
  BUNGEE_PLUGIN_SECRETS_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= bun "$entry" --initialize-config "$state/bungee.db"
fi
exec env \
  BUNGEE_PLUGIN_SECRETS_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= \
  BUNGEE_CONFIG_DB_PATH="$state/bungee.db" \
  BUNGEE_ACCESS_DB_PATH="$state/access.db" \
  BUNGEE_BODY_LOG_DIR="$state/bodies" \
  BUNGEE_HEADER_LOG_DIR="$state/headers" \
  BUNGEE_FILE_LOG_DIR="$state/filelogs" \
  DATA_DIR="$state" PLUGINS_DIR="$repo/packages/core/dist/plugins" BUNGEE_INCLUDE_SYSTEM_PLUGINS=false \
  BUNGEE_INGRESS_INSTANCE_LOCK_PATH="$state/ingress.lock" \
  BUNGEE_ROLE=master HOST=127.0.0.1 PORT="${PORT:-$((ui_port + 1))}" WORKER_COUNT=2 \
  BUNGEE_MANAGEMENT_HOST=127.0.0.1 BUNGEE_MANAGEMENT_PORT="${BUNGEE_MANAGEMENT_PORT:-$((ui_port + 2))}" \
  BUNGEE_MASTER_CONTROL_PORT="${BUNGEE_MASTER_CONTROL_PORT:-$((ui_port + 4))}" BUNGEE_INGRESS_SUPERVISION_PORT="${BUNGEE_INGRESS_SUPERVISION_PORT:-$((ui_port + 3))}" \
  bun "$entry"

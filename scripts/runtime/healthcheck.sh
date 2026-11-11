#!/bin/sh
# Bungee Health Check Script
# Used by Docker HEALTHCHECK to verify the service is running properly

set -e

# Configuration
BUNGEE_MANAGEMENT_HOST="${BUNGEE_MANAGEMENT_HOST:-127.0.0.1}"
BUNGEE_MANAGEMENT_PORT="${BUNGEE_MANAGEMENT_PORT:-8089}"
case "$BUNGEE_MANAGEMENT_HOST" in
    0.0.0.0) HEALTH_HOST="127.0.0.1" ;;
    ::) HEALTH_HOST="[::1]" ;;
    *:*) HEALTH_HOST="[$BUNGEE_MANAGEMENT_HOST]" ;;
    *) HEALTH_HOST="$BUNGEE_MANAGEMENT_HOST" ;;
esac
HEALTH_BASE="http://${HEALTH_HOST}:${BUNGEE_MANAGEMENT_PORT}/health"
TIMEOUT=5

for capability in management data; do
    endpoint="$HEALTH_BASE/$capability"
    if command -v wget >/dev/null 2>&1; then
        wget --spider --timeout="$TIMEOUT" --tries=1 "$endpoint" >/dev/null 2>&1
    elif command -v curl >/dev/null 2>&1; then
        curl -fs --max-time "$TIMEOUT" "$endpoint" >/dev/null 2>&1
    else
        exit 1
    fi
done

#!/bin/sh
# Bungee Health Check Script
# Used by Docker HEALTHCHECK to verify the service is running properly

set -e

# Configuration
BUNGEE_MANAGEMENT_HOST="${BUNGEE_MANAGEMENT_HOST:-127.0.0.1}"
BUNGEE_MANAGEMENT_PORT="${BUNGEE_MANAGEMENT_PORT:-8089}"
case "$BUNGEE_MANAGEMENT_HOST" in
    0.0.0.0) HEALTH_HOST="127.0.0.1"; CONNECT_HOST="127.0.0.1" ;;
    ::) HEALTH_HOST="[::1]"; CONNECT_HOST="::1" ;;
    *:*) HEALTH_HOST="[$BUNGEE_MANAGEMENT_HOST]"; CONNECT_HOST="$BUNGEE_MANAGEMENT_HOST" ;;
    *) HEALTH_HOST="$BUNGEE_MANAGEMENT_HOST"; CONNECT_HOST="$BUNGEE_MANAGEMENT_HOST" ;;
esac
HEALTH_ENDPOINT="http://${HEALTH_HOST}:${BUNGEE_MANAGEMENT_PORT}/health"
TIMEOUT=5

# Perform health check using wget (installed in Dockerfile)
if command -v wget >/dev/null 2>&1; then
    # Use wget (preferred, lighter than curl)
    wget --spider --timeout=$TIMEOUT --tries=1 "$HEALTH_ENDPOINT" >/dev/null 2>&1
    exit $?
elif command -v curl >/dev/null 2>&1; then
    # Fallback to curl if available
    curl -f -s --max-time $TIMEOUT "$HEALTH_ENDPOINT" >/dev/null
    exit $?
else
    # Last resort: use nc (netcat) to check if port is open
    nc -z "$CONNECT_HOST" "$BUNGEE_MANAGEMENT_PORT"
    exit $?
fi

#!/bin/sh
# Bungee Health Check Script
# Used by Docker HEALTHCHECK to verify the service is running properly

set -e

# Configuration
PORT="${PORT:-8088}"
HEALTH_ENDPOINT="http://localhost:${PORT}/health"
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
    nc -z localhost "$PORT"
    exit $?
fi

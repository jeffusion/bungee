#!/bin/sh
export BUNGEE_INSTANCE_SUPERVISOR=tini
set -eu

identity="$(bun -e 'process.stdout.write(crypto.randomUUID())')"
exec bun run packages/core/dist/main.js "--bungee-process-identity=$identity"

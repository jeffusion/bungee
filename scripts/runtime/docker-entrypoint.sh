#!/bin/sh
set -eu

identity="$(bun -e 'process.stdout.write(crypto.randomUUID())')"
exec bun run packages/core/dist/main.js "--bungee-process-identity=$identity"

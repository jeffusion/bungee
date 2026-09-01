#!/bin/sh
set -eu

exec bun run packages/core/dist/main.js

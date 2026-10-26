#!/bin/sh
set -eu

export BUNGEE_INSTANCE_SUPERVISOR=tini
export BUNGEE_INSTALL_ROOT="${BUNGEE_INSTALL_ROOT:-/usr/app/runtime}"

fail() { echo "Bungee startup failed: $*" >&2; exit 1; }

version_file="$BUNGEE_INSTALL_ROOT/version.txt"
[ -f "$version_file" ] || fail "missing $version_file"
version="$(cat "$version_file")"
case "$version" in ''|*[!0-9.]*) fail "invalid selected release version" ;; esac
printf '%s\n' "$version" | grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' || fail "invalid selected release version"

case "$(uname -m)" in
  x86_64) binary_name=bungee-linux ;;
  aarch64|arm64) binary_name=bungee-linux-arm64 ;;
  *) fail "unsupported container architecture" ;;
esac
directory="$BUNGEE_INSTALL_ROOT/bin/$version"
binary="$directory/$binary_name"
[ -f "$binary" ] && [ -x "$binary" ] || fail "selected executable is missing or not executable: $binary"
[ -d "$directory/plugins" ] || fail "selected plugin directory is missing: $directory/plugins"
exec "$binary" "$@"

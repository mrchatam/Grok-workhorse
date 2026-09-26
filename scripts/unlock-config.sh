#!/usr/bin/env bash
# Let the service user edit <prefix>/config (daemon.json, profiles.json, repos.json) again. Run
# scripts/lock-config.sh afterwards: while unlocked, anything running as that user (including a
# compromised worker process that escaped its sandbox) could change the allowlists.
set -euo pipefail
PREFIX="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
INFO="$PREFIX/.install-info"
[ "$(id -u)" -eq 0 ] || { echo "run with sudo" >&2; exit 1; }
[ -f "$INFO" ] || { echo "$INFO not found: unlock-config.sh works on an installed copy" >&2; exit 1; }
WH_USER="$(sed -n 's/^WH_USER=//p' "$INFO")"
chown "$WH_USER" "$PREFIX/config"
find "$PREFIX/config" -maxdepth 1 -type f -name '*.json' -exec chown "$WH_USER" {} +
echo "unlocked $PREFIX/config for $WH_USER; edit, run '$(sed -n 's/^WH_CLI=//p' "$INFO" || echo workhorse) validate', then: sudo bash $PREFIX/scripts/lock-config.sh"

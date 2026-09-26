#!/usr/bin/env bash
# Make the daemon config, the backend config dirs (adapters/) and the code-bearing dirs of each backend
# HOME root-owned and read-only for the service user, so a worker (or anything running as that user)
# cannot change its own permissions, plugins, skills, agent definitions or the repo allowlist.
# Run with sudo after editing config (scripts/unlock-config.sh reverses the config part). The installer
# runs it automatically.
set -euo pipefail
PREFIX="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
INFO="$PREFIX/.install-info"
[ "$(id -u)" -eq 0 ] || { echo "run with sudo" >&2; exit 1; }
[ -f "$INFO" ] || { echo "$INFO not found: lock-config.sh works on an installed copy (scripts/install.sh)" >&2; exit 1; }
WH_USER="$(sed -n 's/^WH_USER=//p' "$INFO")"; WH_DATA_DIR="$(sed -n 's/^WH_DATA_DIR=//p' "$INFO")"; WH_NODE="$(sed -n 's/^WH_NODE=//p' "$INFO")"
[ -n "$WH_USER" ] && [ -n "$WH_DATA_DIR" ] || { echo "incomplete $INFO" >&2; exit 1; }
GROUP="$(id -gn "$WH_USER")"
home_of() { # configured backends.<name>.home, else <data_dir>/<name>-home
  local h=""
  [ -x "$WH_NODE" ] && h="$("$WH_NODE" "$PREFIX/scripts/render-config.mjs" get "$PREFIX/config/daemon.json" "backends.$1.home" 2>/dev/null || true)"
  echo "${h:-$WH_DATA_DIR/$1-home}"
}
lock_home() { # $1 backend name, $2.. code-bearing subdirs
  local name="$1"; shift
  local H; H="$(home_of "$name")"
  install -d -o "$WH_USER" -g "$GROUP" -m 755 "$H/.cache" "$H/.local" "$H/.local/share" "$H/.local/state"
  for d in "$@"; do mkdir -p "$H/$d"; chown -R root:root "$H/$d"; chmod -R go-w,u+rwX "$H/$d"; done
  chown root:root "$H"; chmod 755 "$H"
  echo "locked $name HOME $H ($*)"
}
chown root:root "$PREFIX/config"; chmod 755 "$PREFIX/config"
find "$PREFIX/config" -maxdepth 1 -type f -exec chown root:root {} + -exec chmod 644 {} +
chown -R root:root "$PREFIX/adapters"; chmod -R go-w "$PREFIX/adapters"
echo "locked $PREFIX/config and $PREFIX/adapters"
lock_home kilo .config/kilo .kilo .kilocode .cache/kilo/bin
KH="$(home_of kilo)"
touch "$KH/.config/kilo/.bash-permission-migrated"
[ -f "$KH/.config/kilo/.gitignore" ] || printf 'node_modules\npackage.json\npackage-lock.json\n' > "$KH/.config/kilo/.gitignore"
if grep -q '^WH_OPENCODE_BIN=.' "$INFO"; then lock_home opencode .config/opencode .opencode; fi

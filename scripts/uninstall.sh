#!/usr/bin/env bash
# Remove an installation made by scripts/install.sh:
#   sudo bash <prefix>/scripts/uninstall.sh [--purge-data] [--yes]
# Stops the daemon, removes the systemd unit (if installed), the CLI wrappers and the prefix. The data
# dir (clones, worktrees, task history, audit log) is kept unless --purge-data is given.
set -euo pipefail
PURGE=0; YES=0
for a in "$@"; do
  case "$a" in
    --purge-data) PURGE=1 ;;
    --yes|-y) YES=1 ;;
    -h|--help) sed -n '2,6p' "$0"; exit 0 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done
PREFIX="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
INFO="$PREFIX/.install-info"
[ "$(id -u)" -eq 0 ] || { echo "run with sudo" >&2; exit 1; }
[ -f "$INFO" ] || { echo "$INFO not found: not an installed copy (refusing to delete $PREFIX)" >&2; exit 1; }
get() { sed -n "s/^$1=//p" "$INFO"; }
WH_USER="$(get WH_USER)"; WH_DATA_DIR="$(get WH_DATA_DIR)"; WH_BIN_DIR="$(get WH_BIN_DIR)"; WH_SYSTEMD="$(get WH_SYSTEMD)"
APP_NAME="$(get WH_APP_NAME)"; APP_NAME="${APP_NAME:-grok-workhorse}"; CLI="$(get WH_CLI)"; CLI="${CLI:-workhorse}"
case "$PREFIX" in /|/usr|/usr/*|/bin|/etc|/home|/root) echo "refusing to remove $PREFIX" >&2; exit 1 ;; esac
echo "This removes: $PREFIX, $WH_BIN_DIR/$CLI, $WH_BIN_DIR/$CLI-mcp$([ "$WH_SYSTEMD" = 1 ] && echo ", $APP_NAME.service")"
[ "$PURGE" = 1 ] && echo "and DELETES the data dir $WH_DATA_DIR (clones, worktrees, task history, audit log)"
if [ "$YES" != 1 ]; then read -r -p "Continue? [y/N] " r; [ "$r" = y ] || [ "$r" = Y ] || { echo aborted; exit 1; }; fi
sudo -u "$WH_USER" -H "$(get WH_NODE)" "$PREFIX/bin/$CLI" stop >/dev/null 2>&1 && echo "stopped the daemon" || true
if [ "$WH_SYSTEMD" = 1 ] && [ -f "/etc/systemd/system/$APP_NAME.service" ]; then
  systemctl disable --now "$APP_NAME.service" >/dev/null 2>&1 || true
  rm -f "/etc/systemd/system/$APP_NAME.service"; systemctl daemon-reload || true
  echo "removed $APP_NAME.service"
fi
for c in "$CLI" "$CLI-mcp"; do
  f="$WH_BIN_DIR/$c"
  if [ -f "$f" ] && grep -q "$APP_NAME wrapper (prefix $PREFIX)" "$f"; then rm -f "$f"; echo "removed $f"; fi
done
rm -rf "$PREFIX"; echo "removed $PREFIX"
if [ "$PURGE" = 1 ]; then
  if [ -n "$WH_DATA_DIR" ] && [ "$WH_DATA_DIR" != "/" ] && [ -d "$WH_DATA_DIR" ] && { [ -d "$WH_DATA_DIR/tasks" ] || [ -d "$WH_DATA_DIR/repos" ]; }; then
    rm -rf "$WH_DATA_DIR"; echo "removed data dir $WH_DATA_DIR"
  else
    echo "data dir $WH_DATA_DIR does not look like a workhorse data dir; left in place"
  fi
else
  echo "kept data dir $WH_DATA_DIR (use --purge-data to delete it)"
fi

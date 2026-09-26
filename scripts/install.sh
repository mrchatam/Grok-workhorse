#!/usr/bin/env bash
# Grok Workhorse installer (idempotent). Run from a checkout of this repo:
#   sudo bash scripts/install.sh [options]
# What it does (each step prints what it changed):
#   1. preflight: root, Linux, service user, Node >= 22, npm, git, flock
#   2. copies the app to --prefix (root-owned) and installs pinned Node deps
#   3. installs the pinned Kilo CLI into <prefix>/kilo-cli (or uses --kilo-bin); optionally OpenCode
#      (--with-opencode) into <prefix>/opencode-cli
#   4. checks that bubblewrap can create (nested) user namespaces as the service user
#   5. writes config (only missing files; existing ones keep the owner's edits) and locks it root-owned
#   6. creates the data dir, the Kilo HOME and a tiny hello-world example repo
#   7. installs the workhorse / workhorse-mcp wrappers into --bin-dir (and optionally a systemd unit)
#   8. self-test: config validation, unit tests (or --full-tests), daemon start, `workhorse health`,
#      and a live `workhorse hello` task when the provider key is available
# Nothing is pushed or published anywhere; the only network access is npm (deps + backend CLIs).
set -euo pipefail

# Names in one place (rename here if you fork).
APP_NAME="grok-workhorse"      # package / service / default dirs
DISPLAY_NAME="Grok Workhorse"
CLI="workhorse"                # CLI wrapper; the MCP shim is "$CLI-mcp"
KILO_VERSION_DEFAULT="7.8.1"
OPENCODE_VERSION_DEFAULT="1.18.32"
SRC="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"

usage() {
  cat <<USAGE
Usage: sudo bash scripts/install.sh [options]
  --user NAME           service user that runs the daemon (default: \$SUDO_USER)
  --prefix DIR          install dir, root-owned (default: /opt/$APP_NAME)
  --data-dir DIR        data dir, owned by the service user (default: ~USER/.local/share/$APP_NAME)
  --bin-dir DIR         where the $CLI / $CLI-mcp wrappers go (default: /usr/local/bin)
  --provider NAME       nvidia | openrouter | custom: example profiles.json to start from (default: nvidia;
                        only used when <prefix>/config/profiles.json does not exist yet)
  --secret-store PATH   optional JSON secret-store fallback for API keys (platform-dependent, e.g. an agent
                        platform's secrets file). The env / MCP connector env is always tried first.
  --node PATH           Node.js >= 22 binary (default: the service user's \`node\`)
  --kilo-version VER    Kilo CLI version to pin (default: $KILO_VERSION_DEFAULT)
  --kilo-bin PATH       use an existing Kilo CLI binary of that version instead of installing one
  --with-opencode       also install the pinned OpenCode CLI (backend "opencode", ~350 MB) into <prefix>/opencode-cli
  --opencode-version V  OpenCode version to pin (default: $OPENCODE_VERSION_DEFAULT; implies --with-opencode)
  --opencode-bin PATH   use an existing OpenCode binary instead of installing one
  --token-savers LIST   opt-in worker token savers, e.g. terse=lite,minimal_code=lite (docs/token-savings.md)
  --rtk-bin PATH        enable the RTK shell-output saver with this existing rtk binary (not downloaded here)
  --systemd             also install and start a systemd service (only if systemd is running)
  --full-tests          run the whole test suite (a few minutes) instead of the unit tests
  --skip-tests          skip the test suite (health check and hello task still run)
  --no-live-test        skip the live hello task even if a provider key is available
  --reconfigure         replace existing config files with fresh examples (old files kept as *.bak.<time>)
  -h, --help
USAGE
}

C_OK=$'\e[32m'; C_WARN=$'\e[33m'; C_ERR=$'\e[31m'; C_B=$'\e[1m'; C_0=$'\e[0m'
[ -t 1 ] || { C_OK=; C_WARN=; C_ERR=; C_B=; C_0=; }
step() { echo; echo "${C_B}==> $*${C_0}"; }
ok()   { echo "  ${C_OK}ok${C_0}   $*"; }
warn() { echo "  ${C_WARN}warn${C_0} $*"; WARNINGS=$((WARNINGS + 1)); }
die()  { echo "  ${C_ERR}FAIL${C_0} $*" >&2; exit 1; }
WARNINGS=0

SVC_USER="${SUDO_USER:-}"; PREFIX="/opt/$APP_NAME"; DATA_DIR=""; DATA_DIR_EXPLICIT=0; BIN_DIR=/usr/local/bin
PROVIDER=nvidia; SECRET_STORE=""; NODE=""; KILO_VERSION="$KILO_VERSION_DEFAULT"; KILO_BIN_ARG=""
SYSTEMD=0; FULL_TESTS=0; SKIP_TESTS=0; LIVE=1; RECONFIGURE=0
WITH_OPENCODE=0; OPENCODE_VERSION="$OPENCODE_VERSION_DEFAULT"; OPENCODE_BIN_ARG=""
TOKEN_SAVERS=""; RTK_BIN_ARG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --user) SVC_USER="$2"; shift 2 ;;
    --prefix) PREFIX="$2"; shift 2 ;;
    --data-dir) DATA_DIR="$2"; DATA_DIR_EXPLICIT=1; shift 2 ;;
    --bin-dir) BIN_DIR="$2"; shift 2 ;;
    --provider) PROVIDER="$2"; shift 2 ;;
    --secret-store) SECRET_STORE="$2"; shift 2 ;;
    --node) NODE="$2"; shift 2 ;;
    --kilo-version) KILO_VERSION="$2"; shift 2 ;;
    --kilo-bin) KILO_BIN_ARG="$2"; shift 2 ;;
    --with-opencode) WITH_OPENCODE=1; shift ;;
    --opencode-version) OPENCODE_VERSION="$2"; WITH_OPENCODE=1; shift 2 ;;
    --opencode-bin) OPENCODE_BIN_ARG="$2"; WITH_OPENCODE=1; shift 2 ;;
    --token-savers) TOKEN_SAVERS="$2"; shift 2 ;;
    --rtk-bin) RTK_BIN_ARG="$2"; shift 2 ;;
    --systemd) SYSTEMD=1; shift ;;
    --full-tests) FULL_TESTS=1; shift ;;
    --skip-tests) SKIP_TESTS=1; shift ;;
    --no-live-test) LIVE=0; shift ;;
    --reconfigure) RECONFIGURE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage; die "unknown option: $1" ;;
  esac
done

# ---------------------------------------------------------------------------------------------
step "1/8 Preflight"
[ "$(id -u)" -eq 0 ] || die "run with sudo (the config and app dir are made root-owned so workers cannot change them)"
[ "$(uname -s)" = "Linux" ] || die "Linux only (bubblewrap sandboxing)"
[ -n "$SVC_USER" ] || die "cannot tell which user should run the daemon; pass --user NAME"
[ "$SVC_USER" != "root" ] || die "the daemon must not run as root; pass --user <unprivileged user>"
id "$SVC_USER" >/dev/null 2>&1 || die "user '$SVC_USER' does not exist"
SVC_HOME="$(getent passwd "$SVC_USER" | cut -d: -f6)"
SVC_GROUP="$(id -gn "$SVC_USER")"
[ -f "$SRC/package.json" ] && grep -q "\"name\": \"$APP_NAME\"" "$SRC/package.json" || die "run this script from a $APP_NAME checkout ($SRC)"
PREFIX="$(realpath -m "$PREFIX")"; BIN_DIR="$(realpath -m "$BIN_DIR")"
case "$PREFIX" in /|/usr|/usr/*|/bin|/etc|/home|"$SVC_HOME") die "refusing prefix $PREFIX" ;; esac
as_user() { sudo -u "$SVC_USER" -H "$@"; }
if [ -z "$NODE" ]; then NODE="$(as_user bash -lc 'command -v node' 2>/dev/null || true)"; fi
[ -z "$NODE" ] && NODE="$(command -v node || true)"
[ -n "$NODE" ] && [ -x "$NODE" ] || die "Node.js not found for $SVC_USER; install Node >= 22 or pass --node PATH"
NODE="$(readlink -f "$NODE")"; NODE_DIR="$(dirname "$NODE")"
NODE_MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || die "Node $("$NODE" -v) at $NODE is too old; need >= 22"
NPM="$NODE_DIR/npm"; [ -x "$NPM" ] || NPM="$(command -v npm || true)"; [ -n "$NPM" ] || die "npm not found next to $NODE"
for b in git flock tar getent; do command -v "$b" >/dev/null || die "$b is required"; done
command -v python3 >/dev/null || warn "python3 not found: needed only for --full-tests (mock LLM) and Python repos"
if [ -n "$SECRET_STORE" ]; then
  SECRET_STORE="$(realpath -m "$SECRET_STORE")"
  [ -f "$SECRET_STORE" ] || warn "secret store $SECRET_STORE does not exist yet (the daemon re-checks it before each task)"
fi
EXISTING_DATA=""
[ -f "$PREFIX/config/daemon.json" ] && EXISTING_DATA="$("$NODE" "$SRC/scripts/render-config.mjs" get "$PREFIX/config/daemon.json" data_dir || true)"
if [ -z "$DATA_DIR" ]; then DATA_DIR="${EXISTING_DATA:-$SVC_HOME/.local/share/$APP_NAME}"; fi
DATA_DIR="$(realpath -m "$DATA_DIR")"
case "$DATA_DIR" in *[\"\\\ ]*) die "data dir must not contain spaces, quotes or backslashes" ;; /|/home|/tmp|"$SVC_HOME") die "refusing data dir $DATA_DIR" ;; esac
case "$DATA_DIR" in "$PREFIX"|"$PREFIX"/*) die "data dir must be outside the prefix" ;; esac
ok "user=$SVC_USER node=$NODE ($("$NODE" -v)) prefix=$PREFIX data=$DATA_DIR bin=$BIN_DIR"

# ---------------------------------------------------------------------------------------------
step "2/8 App files and Node dependencies -> $PREFIX"
mkdir -p "$PREFIX"
if [ "$SRC" != "$PREFIX" ]; then
  rm -rf "$PREFIX"/bin "$PREFIX"/lib "$PREFIX"/scripts "$PREFIX"/test "$PREFIX"/config/examples "$PREFIX"/docs
  # adapters/: replace everything except the installed node_modules of the backend config dirs
  if [ -d "$PREFIX/adapters" ]; then find "$PREFIX/adapters" -depth -mindepth 1 -not -path '*/node_modules*' \( -type f -o -type l \) -delete; fi
  tar -C "$SRC" --exclude=node_modules --exclude=.git -cf - bin lib adapters scripts test docs config/examples package.json package-lock.json README.md LICENSE NOTICE \
    | tar -C "$PREFIX" -xf -
  ok "copied app files"
else
  ok "installing in place ($SRC)"
fi
export PATH="$NODE_DIR:$PATH"
(cd "$PREFIX" && "$NPM" ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error >/dev/null) || die "npm ci failed in $PREFIX"
for d in adapters/kilo/config adapters/opencode/config; do
  (cd "$PREFIX/$d" && "$NPM" ci --ignore-scripts --no-audit --no-fund --loglevel=error >/dev/null) || die "npm ci failed in $PREFIX/$d"
done
ok "node deps installed (MCP SDK, zod; Kilo/OpenCode plugin SDKs for the guard plugin)"

# ---------------------------------------------------------------------------------------------
# Backend CLIs: when the requested version is the one pinned in scripts/pins/<name> (exact versions and
# sha512 integrity of every package, verified by `npm ci`), install from that lockfile; otherwise fall
# back to `npm install -g` of the exact top-level version (transitive packages then not integrity-pinned).
pinned_install() { # <pin name> <npm package> <version> <target dir> <exe>
  local pin="$SRC/scripts/pins/$1" pkg="$2" ver="$3" dir="$4" exe="$5"
  if [ -f "$pin/package-lock.json" ] && [ "$("$NODE" -p "require('$pin/package.json').dependencies['$pkg']")" = "$ver" ]; then
    rm -rf "$dir"; mkdir -p "$dir/bin"
    cp "$pin/package.json" "$pin/package-lock.json" "$dir/"
    (cd "$dir" && "$NPM" ci --no-audit --no-fund --loglevel=error >/dev/null) || return 1
    # The link target comes from the package's own package.json "bin" field (not bin/<exe>).
    local rel; rel="$("$NODE" "$SRC/scripts/pin-bin.mjs" "$dir" "$pkg" "$exe")" || return 1
    ln -sfn "../node_modules/$pkg/$rel" "$dir/bin/$exe"
    [ -e "$dir/bin/$exe" ] || { warn "$dir/bin/$exe -> ../node_modules/$pkg/$rel is a dangling link"; return 1; }
    ok "installed $pkg@$ver into $dir from the committed lockfile (integrity-checked)"
  else
    "$NPM" install -g --prefix "$dir" "$pkg@$ver" --no-audit --no-fund --loglevel=error >/dev/null || return 1
    warn "installed $pkg@$ver into $dir (no committed lockfile for this version: only the top-level version is pinned)"
  fi
}

step "3/8 Kilo CLI $KILO_VERSION"
kilo_version() { HOME="$(mktemp -d)" PATH="$NODE_DIR:/usr/bin:/bin" "$1" --version 2>/dev/null | tail -n1 | awk '{print $NF}'; }
if [ -n "$KILO_BIN_ARG" ]; then
  KILO_BIN="$(readlink -f "$KILO_BIN_ARG")"
  [ -x "$KILO_BIN" ] || die "--kilo-bin $KILO_BIN_ARG is not executable"
  ok "using existing Kilo CLI at $KILO_BIN"
else
  KILO_BIN="$PREFIX/kilo-cli/bin/kilo"
  if [ -x "$KILO_BIN" ] && [ "$(kilo_version "$KILO_BIN")" = "$KILO_VERSION" ]; then
    ok "already installed at $KILO_BIN"
  else
    pinned_install kilo-cli @kilocode/cli "$KILO_VERSION" "$PREFIX/kilo-cli" kilo || die "installing @kilocode/cli@$KILO_VERSION failed"
  fi
fi
GOT="$(kilo_version "$KILO_BIN")"
[ "$GOT" = "$KILO_VERSION" ] || die "Kilo CLI at $KILO_BIN reports version '$GOT', expected $KILO_VERSION"
ok "Kilo CLI $GOT"
OPENCODE_BIN=""
if [ "$WITH_OPENCODE" = 1 ]; then
  if [ -n "$OPENCODE_BIN_ARG" ]; then
    OPENCODE_BIN="$(readlink -f "$OPENCODE_BIN_ARG")"; [ -x "$OPENCODE_BIN" ] || die "--opencode-bin $OPENCODE_BIN_ARG is not executable"
  else
    OPENCODE_BIN="$PREFIX/opencode-cli/bin/opencode"
    if ! { [ -x "$OPENCODE_BIN" ] && [ "$(kilo_version "$OPENCODE_BIN")" = "$OPENCODE_VERSION" ]; }; then
      pinned_install opencode-cli opencode-ai "$OPENCODE_VERSION" "$PREFIX/opencode-cli" opencode || die "installing opencode-ai@$OPENCODE_VERSION failed"
    fi
  fi
  OGOT="$(kilo_version "$OPENCODE_BIN")"
  [ -n "$OPENCODE_BIN_ARG" ] && OPENCODE_VERSION="$OGOT"
  [ "$OGOT" = "$OPENCODE_VERSION" ] || die "OpenCode at $OPENCODE_BIN reports version '$OGOT', expected $OPENCODE_VERSION"
  ok "OpenCode CLI $OGOT at $OPENCODE_BIN (use it with \"backend\": \"opencode\" in a profile)"
fi
chown -R root:root "$PREFIX"; chmod -R go-w "$PREFIX"
ok "$PREFIX is root-owned"

# ---------------------------------------------------------------------------------------------
step "4/8 Sandbox (bubblewrap)"
KILO_ROOT="$(dirname "$(dirname "$(readlink -f "$KILO_BIN")")")"
BWRAP=""
for c in "$KILO_ROOT/bin/bwrap" "$(command -v bwrap || true)"; do [ -n "$c" ] && [ -x "$c" ] && { BWRAP="$c"; break; }; done
[ -n "$BWRAP" ] || die "bubblewrap not found (neither bundled with Kilo nor on PATH); install the 'bubblewrap' package"
BW="--unshare-user --unshare-pid --ro-bind / / --dev /dev --proc /proc"
BW_ERR="$(mktemp)"; chmod 666 "$BW_ERR"
# shellcheck disable=SC2086
as_user "$BWRAP" $BW true 2>"$BW_ERR" || die "bwrap cannot create user namespaces as $SVC_USER: $(head -c 300 "$BW_ERR"). On Ubuntu 24.04+ see README 'Troubleshooting' (AppArmor userns restriction)."
# shellcheck disable=SC2086
as_user "$BWRAP" $BW "$BWRAP" $BW true 2>"$BW_ERR" || die "nested bwrap failed (Kilo's own sandbox runs inside the outer one): $(head -c 300 "$BW_ERR")"
rm -f "$BW_ERR"
ok "user namespaces and nesting work ($BWRAP)"

# ---------------------------------------------------------------------------------------------
step "5/8 Config -> $PREFIX/config (root-owned)"
CFG="$PREFIX/config"; mkdir -p "$CFG"
STAMP="$(date +%Y%m%d-%H%M%S)"
if [ "$RECONFIGURE" = 1 ]; then
  for f in daemon.json profiles.json repos.json; do [ -f "$CFG/$f" ] && mv "$CFG/$f" "$CFG/$f.bak.$STAMP" && ok "backed up $f -> $f.bak.$STAMP"; done
fi
ENV_PATH="$NODE_DIR:$(dirname "$KILO_BIN")${OPENCODE_BIN:+:$(dirname "$OPENCODE_BIN")}:/usr/local/bin:/usr/bin:/bin"
R_DATA_DIR="$DATA_DIR" R_DATA_DIR_EXPLICIT="$DATA_DIR_EXPLICIT" R_KILO_BIN="$KILO_BIN" R_KILO_VERSION="$KILO_VERSION" R_BWRAP="$BWRAP" \
  R_ENV_PATH="$ENV_PATH" R_SECRET_STORE="$SECRET_STORE" R_OPENCODE_BIN="$OPENCODE_BIN" R_OPENCODE_VERSION="${OPENCODE_BIN:+$OPENCODE_VERSION}" "$NODE" "$PREFIX/scripts/render-config.mjs" daemon "$CFG/examples/daemon.json" "$CFG/daemon.json" | sed 's/^/  daemon.json: /'
if [ ! -f "$CFG/profiles.json" ]; then
  [ -f "$CFG/examples/profiles.$PROVIDER.json" ] || die "unknown --provider '$PROVIDER' (have: $(ls "$CFG/examples" | sed -n 's/^profiles\.\(.*\)\.json$/\1/p' | tr '\n' ' '))"
  cp "$CFG/examples/profiles.$PROVIDER.json" "$CFG/profiles.json"
  ok "profiles.json created from the '$PROVIDER' example"
  [ "$PROVIDER" = custom ] && warn "profiles.json is the 'custom' template: fill in the <...> placeholders, then run: workhorse validate"
else
  ok "profiles.json kept (existing)"
fi
if [ ! -f "$CFG/repos.json" ]; then
  R_DATA_DIR="$DATA_DIR" "$NODE" "$PREFIX/scripts/render-config.mjs" repos "$CFG/examples/repos.json" "$CFG/repos.json" >/dev/null
  ok "repos.json created (allowlist: hello-world example)"
else
  ok "repos.json kept (existing)"
fi
if [ -n "$TOKEN_SAVERS$RTK_BIN_ARG" ]; then
  TS_ARGS=()
  IFS=',' read -r -a TS_PAIRS <<< "$TOKEN_SAVERS"
  for kv in "${TS_PAIRS[@]}"; do
    [ -n "$kv" ] || continue
    case "$kv" in
      terse=*) TS_ARGS+=(--terse "${kv#terse=}") ;;
      minimal_code=*|minimal-code=*) TS_ARGS+=(--minimal-code "${kv#*=}") ;;
      rtk=*) TS_ARGS+=(--rtk "${kv#rtk=}") ;;
      *) die "--token-savers: unknown entry '$kv' (use terse=, minimal_code=, rtk=)" ;;
    esac
  done
  if [ -n "$RTK_BIN_ARG" ]; then
    RTK_BIN_ARG="$(readlink -f "$RTK_BIN_ARG")"; [ -x "$RTK_BIN_ARG" ] || die "--rtk-bin $RTK_BIN_ARG is not executable"
    TS_ARGS+=(--rtk on --rtk-bin "$RTK_BIN_ARG")
  fi
  WH_CONFIG_DIR="$CFG" "$NODE" "$PREFIX/bin/workhorse" token-savers "${TS_ARGS[@]}" >/dev/null || die "setting token savers failed"
  ok "token savers: ${TOKEN_SAVERS:-} ${RTK_BIN_ARG:+rtk=$RTK_BIN_ARG}"
fi
DATA_DIR="$("$NODE" "$PREFIX/scripts/render-config.mjs" get "$CFG/daemon.json" data_dir)"
cat > "$PREFIX/.install-info" <<INFO
# written by scripts/install.sh; read by uninstall.sh and lock-config.sh
WH_USER=$SVC_USER
WH_DATA_DIR=$DATA_DIR
WH_BIN_DIR=$BIN_DIR
WH_NODE=$NODE
WH_SYSTEMD=$SYSTEMD
WH_KILO_VERSION=$KILO_VERSION
WH_OPENCODE_BIN=$OPENCODE_BIN
WH_APP_NAME=$APP_NAME
WH_CLI=$CLI
INFO

# ---------------------------------------------------------------------------------------------
step "6/8 Data dir, example repo -> $DATA_DIR"
install -d -o "$SVC_USER" -g "$SVC_GROUP" -m 700 "$DATA_DIR"
as_user mkdir -p "$DATA_DIR/repos"
if [ ! -d "$DATA_DIR/repos/hello-world/.git" ]; then
  as_user env WH_CONFIG_DIR="$CFG" "$NODE" --input-type=module -e 'const a = await import(process.argv[1]); a.createHelloRepo(process.argv[2])' "$PREFIX/lib/admin.mjs" "$DATA_DIR/repos/hello-world"
  ok "created example repo $DATA_DIR/repos/hello-world"
else
  ok "example repo exists"
fi
bash "$PREFIX/scripts/lock-config.sh" | sed 's/^/  /'

# ---------------------------------------------------------------------------------------------
step "7/8 Commands and service"
mkdir -p "$BIN_DIR"
for cmd in "$CLI" "$CLI-mcp"; do
  printf '#!/bin/sh\n# %s wrapper (prefix %s)\nexec "%s" "%s/bin/%s" "$@"\n' "$APP_NAME" "$PREFIX" "$NODE" "$PREFIX" "$cmd" > "$BIN_DIR/$cmd"
  chmod 755 "$BIN_DIR/$cmd"
done
ok "$BIN_DIR/$CLI, $BIN_DIR/$CLI-mcp"
CLI_BIN="$BIN_DIR/$CLI"
if [ -S "$DATA_DIR/run/daemon.sock" ]; then as_user "$CLI_BIN" stop >/dev/null 2>&1 || true; ok "stopped the running daemon (it restarts with the new code)"; fi
if [ "$SYSTEMD" = 1 ]; then
  if [ -d /run/systemd/system ]; then
    cat > "/etc/systemd/system/$APP_NAME.service" <<UNIT
[Unit]
Description=$DISPLAY_NAME daemon (sandboxed coding-agent workers)
After=network-online.target

[Service]
User=$SVC_USER
Environment=PATH=$ENV_PATH
Environment=WH_CONFIG_DIR=$CFG
Environment=WH_DATA_DIR=$DATA_DIR
ExecStart=$PREFIX/bin/workhorse-supervisor
Restart=on-failure

[Install]
WantedBy=multi-user.target
UNIT
    systemctl daemon-reload && systemctl enable --now "$APP_NAME.service" >/dev/null
    ok "systemd unit $APP_NAME.service enabled"
  else
    warn "--systemd given but systemd is not running; the MCP shim / $CLI start the supervisor on demand"
  fi
else
  ok "no service unit: the supervisor starts on the first MCP tool call or '$CLI start' (works without systemd)"
fi

# ---------------------------------------------------------------------------------------------
step "8/8 Self-test"
as_user "$CLI_BIN" validate >/dev/null || { as_user "$CLI_BIN" validate; die "config validation failed"; }
ok "config valid"
if [ "$SKIP_TESTS" = 1 ]; then
  warn "tests skipped (--skip-tests)"
else
  TESTS="$PREFIX/test/unit.test.mjs $PREFIX/test/config.test.mjs $PREFIX/test/adapters.test.mjs"
  [ "$FULL_TESTS" = 1 ] && TESTS="$PREFIX/test/*.test.mjs"
  # shellcheck disable=SC2086
  if as_user env PATH="$ENV_PATH" WH_KILO_BIN="$KILO_BIN" "$NODE" --test --test-timeout=600000 --test-reporter=tap $TESTS > "$DATA_DIR/install-tests.log" 2>&1; then
    NPASS=$(grep -Eo '^# pass [0-9]+' "$DATA_DIR/install-tests.log" | awk '{print $3}')
    ok "tests passed (${NPASS:-?} passed - log: $DATA_DIR/install-tests.log)"
  else
    as_user env PATH="$ENV_PATH" WH_KILO_BIN="$KILO_BIN" "$NODE" --test --test-timeout=600000 $TESTS > "$DATA_DIR/install-tests.log" 2>&1 || true
    tail -n 30 "$DATA_DIR/install-tests.log"
    die "tests failed (full log: $DATA_DIR/install-tests.log)"
  fi
fi
# Pass the provider key (if the installer's environment has it, e.g. sudo --preserve-env=NAME) to the
# daemon through the environment only, never argv. Without it the daemon uses the secret store / connector env.
KEY_NAME="$(WH_CONFIG_DIR="$CFG" "$NODE" --input-type=module -e 'const c = await import(process.argv[1]); const pc = c.profilesConfig(); const p = pc.profiles[pc.default_profile]; console.log(pc.providers[p?.provider]?.api_key_env || "")' "$PREFIX/lib/config.mjs")"
PRESERVE=()
if [ -n "$KEY_NAME" ] && [ -n "${!KEY_NAME:-}" ]; then export "${KEY_NAME?}"; PRESERVE=(--preserve-env="$KEY_NAME"); fi
sudo -u "$SVC_USER" -H "${PRESERVE[@]}" "$CLI_BIN" start >/dev/null || die "daemon did not start; see $DATA_DIR/logs/daemon.log"
ok "daemon running"
if as_user "$CLI_BIN" health > "$DATA_DIR/install-health.log" 2>&1; then
  sed 's/^/  /' "$DATA_DIR/install-health.log"
  HEALTHY=1
else
  sed 's/^/  /' "$DATA_DIR/install-health.log"
  HEALTHY=0
  warn "$CLI health reports problems (see above)"
fi
LIVE_RESULT="skipped"
if [ "$LIVE" = 1 ] && [ "$HEALTHY" = 1 ]; then
  echo "  running a live hello task on the default profile (usually 1-5 min)..."
  if as_user "$CLI_BIN" hello > "$DATA_DIR/install-hello.log" 2>&1; then
    LIVE_RESULT="passed"; ok "live hello task succeeded"
  else
    LIVE_RESULT="FAILED"; sed 's/^/  /' "$DATA_DIR/install-hello.log" | tail -n 25
    warn "live hello task failed (log: $DATA_DIR/install-hello.log); check the key/model with: $CLI check-provider"
  fi
elif [ "$LIVE" = 1 ]; then
  warn "live hello task skipped: provider key not available yet (${KEY_NAME:-none}). Add it, then run: $CLI hello"
fi

# ---------------------------------------------------------------------------------------------
step "Done"
cat <<DONE
  Installed $DISPLAY_NAME $("$NODE" -p "require('$PREFIX/package.json').version") (Kilo CLI $KILO_VERSION${OPENCODE_BIN:+, OpenCode $OPENCODE_VERSION}) for user $SVC_USER.
  Live hello task: $LIVE_RESULT. Warnings: $WARNINGS.

  Connect it as an MCP server (stdio), e.g. a Grok Bot custom connector:
    command: $BIN_DIR/$CLI-mcp
    args:    []
    env:     { "${KEY_NAME:-<API_KEY_ENV>}": <reference to your stored secret> }   (omit if the daemon gets the key elsewhere)

  Next steps:
    sudo $CLI add-repo https://github.com/<owner>/<repo>.git --test "npm test"   # allow a repo
    $CLI health                                                                   # daily check
    Edit models: sudo bash $PREFIX/scripts/unlock-config.sh; edit $CFG/profiles.json; sudo bash $PREFIX/scripts/lock-config.sh
DONE

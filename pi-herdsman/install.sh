#!/bin/sh
set -eu

PACKAGE=pi-herdsman
PI_PACKAGE=@earendil-works/pi-coding-agent

log() { printf '  > %s\n' "$1"; }
err() { printf '  x %s\n' "$1" >&2; exit 1; }

need() {
  command -v "$1" >/dev/null 2>&1 || err "requires '$1'"
}

package_field() {
  node -e '
const fs = require("node:fs");
const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
let value = data;
for (const key of process.argv[2].split(".")) value = value?.[key];
if (typeof value !== "string" || value.length === 0) process.exit(1);
process.stdout.write(value);
' "$manifest" "$1"
}

current_version() {
  "$1" --version 2>/dev/null | awk '{ print $NF }'
}

main() {
  need curl
  need node
  need npm
  need awk
  need grep

  node -e '
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 19)) process.exit(1);
' || err "requires Node >=22.19.0"

  case "$(uname -s)" in
    Linux|Darwin) ;;
    *) err "unsupported OS: $(uname -s)" ;;
  esac

  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  manifest="$tmp/package.json"

  log "resolving released Pi Herdsman stack"
  npm view "$PACKAGE@latest" --json > "$manifest" ||
    err "could not resolve $PACKAGE@latest from npm"

  herdsman_version="$(package_field version)" ||
    err "released package is missing its version"
  pi_version="$(package_field piHerdsman.runtime.pi)" ||
    err "$PACKAGE@$herdsman_version does not publish bootstrap runtime metadata"
  radar_commit="$(package_field piHerdsman.runtime.radar.commit)" ||
    err "$PACKAGE@$herdsman_version does not publish a Radar runtime commit"

  case "$pi_version" in
    *[!0-9A-Za-z.+-]*) err "released runtime metadata contains an invalid Pi version" ;;
  esac

  # Radar and tmux are host prerequisites: the daemon is built and run by Radar's
  # own packaging, so this installer checks for it rather than installing it.
  # Radar has no version flag, so only its presence can be checked here.
  missing=""
  command -v tmux >/dev/null 2>&1 || missing="$missing tmux"
  command -v radar >/dev/null 2>&1 || missing="$missing radar"
  if [ -n "$missing" ]; then
    err "missing prerequisite(s):$missing. Build agent-radar at commit $radar_commit (cargo build --release --locked --bin radar), put radar and tmux on PATH, then start the daemon on a named tmux server: RADAR_CONTROL_BACKEND=tmux RADAR_TMUX_SERVER=<server> radar daemon"
  fi

  if command -v pi >/dev/null 2>&1 && [ "$(current_version pi)" = "$pi_version" ]; then
    log "Pi $pi_version already installed"
  else
    log "installing Pi $pi_version"
    npm install -g --ignore-scripts "$PI_PACKAGE@$pi_version"
    [ "$(current_version pi)" = "$pi_version" ] ||
      err "Pi $pi_version was installed but is not the Pi resolved on PATH"
  fi

  if pi list --no-approve 2>/dev/null |
    awk '{ print $1 }' |
    grep -Fx "npm:$PACKAGE" >/dev/null 2>&1; then
    log "Pi Herdsman $herdsman_version already installed"
  else
    log "installing Pi Herdsman $herdsman_version"
    pi install "npm:$PACKAGE" --no-approve
  fi

  printf '\nPi Herdsman %s ready with Pi %s. Requires radar at commit %s and a tmux pane of its daemon'"'"'s server.\n' \
    "$herdsman_version" "$pi_version" "$radar_commit"
}

main "$@"

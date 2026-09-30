#!/usr/bin/env bash
#
# Upstream status and mirrors for the two packages that are forks of somebody
# else's active work.
#
#   scripts/upstream.sh                # refresh every fork, then report
#   scripts/upstream.sh pi-subagents   # one
#
# A fork needs two repositories, and neither belongs inside this working tree: a
# pristine mirror of upstream, and that mirror with every path rewritten to
# <package>/ so its commits line up with this repo and can be diffed or
# cherry-picked directly (git filter-repo --to-subdirectory-filter). The
# rewritten mirror is regenerated rather than updated in place, because
# filter-repo rewrites whole histories: the rewrite is deterministic, so commits
# this repo already fetched keep their ids and only new ones appear.
#
# Mirrors live in ~/Projects/dev/custom/.pi-ext-mirrors (PI_EXT_MIRRORS
# overrides it) and reach this repo through the upstream-<package> remotes:
#
#   git diff upstream-pi-subagents/main -- pi-subagents   # what upstream has
#   git cherry-pick -n <sha>                              # take one fix
#
# BASE is the last upstream commit vendored into this repo, in the rewritten ids
# this repo knows. Moving it is what taking an upstream update means.
#
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

MIRRORS="${PI_EXT_MIRRORS:-$HOME/Projects/dev/custom/.pi-ext-mirrors}"
declare -A FORK=(
  [pi-subagents]="https://github.com/nicobailon/pi-subagents.git"
  [pi-otel]="https://github.com/stnly/pi-otel.git"
)
declare -A BASE=(
  # fix: keep delegation and supervisor tools out of codemode scripts (#2586)
  [pi-subagents]="27c2bf6d1a6499c30bc38e452e68c6fd9a0ca7b6"
  # chore: release 0.3.1
  [pi-otel]="0e3a1f102e13fd67e308562ee82a565703c78529"
)

refresh() {
  local pkg=$1 url=${FORK[$1]}
  local pristine="$MIRRORS/upstream/$pkg.git" rewritten="$MIRRORS/ns/$pkg.git"

  if [ -d "$pristine" ]; then
    git -C "$pristine" fetch --quiet --prune origin '+refs/heads/*:refs/heads/*'
  else
    mkdir -p "$MIRRORS/upstream"
    git clone --quiet --mirror "$url" "$pristine"
  fi

  rm -rf "$rewritten"
  mkdir -p "$MIRRORS/ns"
  git clone --quiet --mirror "$pristine" "$rewritten"
  git -C "$rewritten" filter-repo --force --to-subdirectory-filter "$pkg" >/dev/null
  git fetch --quiet "$rewritten" "+refs/heads/*:refs/remotes/upstream-$pkg/*"

  local tip behind touching
  tip=$(git rev-parse --short "upstream-$pkg/main")
  behind=$(git rev-list --count "${BASE[$pkg]}..upstream-$pkg/main")
  touching=$(git rev-list --count "${BASE[$pkg]}..upstream-$pkg/main" -- "$pkg")
  printf '%s: upstream at %s — %s commits since our base, %s of them touch %s/\n' \
    "$pkg" "$tip" "$behind" "$touching" "$pkg"
}

if [ $# -gt 0 ]; then
  for pkg in "$@"; do refresh "$pkg"; done
else
  for pkg in pi-subagents pi-otel; do refresh "$pkg"; done
fi

#!/usr/bin/env bash
#
# Upstream status and mirrors for the two packages that fork somebody else's
# active work.
#
#   scripts/upstream.sh                # refresh every fork, then report
#   scripts/upstream.sh pi-subagents   # one
#
# A fork needs two repositories, and neither belongs inside this working tree: a
# pristine mirror of upstream, and that mirror with every path rewritten to
# <package>/ so its commits line up with this repo and can be diffed or
# cherry-picked directly. Mirrors live in ~/Projects/dev/custom/.pi-ext-mirrors
# (PI_EXT_MIRRORS overrides it) and reach this repo through the
# upstream-<package> remotes:
#
#   git diff upstream-pi-subagents/main HEAD -- pi-subagents   # our delta
#   git cherry-pick -n <sha>                                   # take one commit
#
# TAKEN below is what this repo has already adopted from upstream, by SUBJECT:
# the mirrors are regenerated, and filter-repo rewrites whole histories, so ids
# from a mirror are not a thing to record — a subject is. The report counts what
# upstream has after the newest take; that is the honest "how far behind".
#
# Rebasing a fork's own delta onto upstream is a scratch-clone job, and the
# pivot has to come from the branch being rebased: the two rewrites give the
# same upstream commit different ids (import-pi-subagents and
# upstream-pi-subagents do not share an id space), which is also why the report
# names the last upstream commit the import branch holds instead of assuming it
# is current.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

MIRRORS="${PI_EXT_MIRRORS:-$HOME/Projects/dev/custom/.pi-ext-mirrors}"
declare -A FORK=(
  [pi-subagents]="https://github.com/nicobailon/pi-subagents.git"
  [pi-otel]="https://github.com/stnly/pi-otel.git"
)
declare -A TAKEN=(
  [pi-subagents]="show a revived workflow child as its key's latest run (#2585)|keep delegation and supervisor tools out of codemode scripts (#2586)"
  [pi-otel]="chore: release 0.3.1"
)

resolve() { # resolve <ref> <subject> -> commit id, or empty
  git log --format=%H -1 "$1" --fixed-strings --grep="$2" 2>/dev/null || true
}

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

  # The newest recorded take that is still reachable from upstream main.
  local newest="" newest_subject="" newest_behind="" subject hit behind
  local IFS='|'
  for subject in ${TAKEN[$pkg]}; do
    hit=$(resolve "upstream-$pkg/main" "$subject")
    if [ -z "$hit" ]; then
      printf '%s: recorded take not in upstream main: %s\n' "$pkg" "$subject" >&2
      continue
    fi
    behind=$(git rev-list --count "$hit..upstream-$pkg/main")
    if [ -z "$newest_behind" ] || [ "$behind" -lt "$newest_behind" ]; then
      newest=$hit newest_subject=$subject newest_behind=$behind
    fi
  done
  unset IFS

  local tip after touching delta
  tip=$(git log -1 --format='%h (%ad)' --date=short "upstream-$pkg/main")
  delta=$(git diff --numstat "upstream-$pkg/main" HEAD -- "$pkg" | wc -l)
  if [ -n "$newest" ]; then
    after=$(git rev-list --count "$newest..upstream-$pkg/main")
    touching=$(git rev-list --count "$newest..upstream-$pkg/main" -- "$pkg")
    printf '%s: upstream %s — %s commits after our newest take, %s of them touching %s/; our delta %s files\n' \
      "$pkg" "$tip" "$after" "$touching" "$pkg" "$delta"
    if [ "$after" != "0" ]; then
      printf '%s: not taken yet:\n' "$pkg"
      git log --oneline --no-decorate "$newest..upstream-$pkg/main" -- "$pkg" | sed 's/^/    /'
    fi
  else
    printf '%s: upstream %s — no recorded take found; our delta %s files\n' "$pkg" "$tip" "$delta"
  fi

  # What the in-repo import branch holds, and the rebase its pivot implies.
  local branch="import-$pkg" pivot pivot_subject
  if git rev-parse --verify --quiet "$branch" >/dev/null; then
    pivot=$(git log --format='%H %h %s' -1 "$branch" --fixed-strings --grep="${newest_subject}" 2>/dev/null | cut -d' ' -f2 || true)
    pivot_subject=$(git log -1 --format='%h %s (%ad)' --date=short "$branch")
    if [ -n "$pivot" ]; then
      printf '%s: %s holds through %s — rebase the delta it carries with:\n    git rebase --onto upstream-%s/main %s %s\n' \
        "$pkg" "$branch" "$pivot_subject" "$pkg" "$pivot" "$branch"
    else
      printf '%s: %s stops before the newest take (%s) — a rebase there replays the older delta only\n' \
        "$pkg" "$branch" "$pivot_subject"
    fi
  fi
}

if [ $# -gt 0 ]; then
  for pkg in "$@"; do refresh "$pkg"; done
else
  for pkg in pi-subagents pi-otel; do refresh "$pkg"; done
fi

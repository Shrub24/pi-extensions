#!/usr/bin/env bash
#
# Upstream status and mirrors for the packages that fork somebody else's work.
#
#   scripts/upstream.sh                # refresh every fork, then report
#   scripts/upstream.sh pi-subagents   # one (or several)
#
# A fork needs two repositories, and neither belongs inside this working tree: a
# pristine mirror of upstream, and that mirror with every path rewritten to
# <package>/ so its commits line up with this repo and can be diffed or
# cherry-picked directly. Both live in ~/Projects/dev/custom/.pi-ext-mirrors
# (PI_EXT_MIRRORS overrides it) and reach this repo through the
# upstream-<package> remotes:
#
#   git diff upstream-pi-subagents/main HEAD -- pi-subagents   # files differing
#   git cherry-pick -n <sha>                                   # take one commit
#
# FORKS below is the table. "path" is where the package sits in upstream — "."
# for a repository that is the package (nicobailon, stnly), pi-extensions/<name>
# for kendex, whose rewrite therefore also filters: only commits touching that
# path survive, and that prefix is stripped so the result lands at
# <package>/<file>, the layout this repo uses. Without the strip a kendex take
# arrives as <package>/pi-extensions/<name>/<file> and no cherry-pick applies.
# "takes" are the upstream commits this repo has adopted, in upstream's own id
# space; a take does not have to touch the path, since for kendex it is the repo
# state we extracted from, and the rewrite's pivot is that path's last commit at
# or before it.
#
# Ids are not portable between the mirrors: the same upstream commit is a
# different object in each rewrite (different graph roots), so #2350 is
# 868e45be2 in import-pi-subagents and 528029351 in the mirror. Pivots are
# therefore resolved per space here — never copied between them.
#
# Rebasing a fork's delta onto upstream is a scratch-clone job:
#
#   git clone --shared . /tmp/rebase && cd /tmp/rebase
#   git checkout import-pi-subagents
#   git rebase --onto upstream-pi-subagents/main <pivot>   # pivot = that branch's last upstream commit
#
# That replays only what the import branch carries. Whether that is also what
# this tree differs by is a separate question, and usually not: a take that came
# in as a whole tree leaves the branch behind, so the report prints how far the
# tree has moved past each branch before anyone rebases it.
#
# jj names the same commits its own way — a remote branch is <branch>@<remote>,
# a local one is its bookmark — so the delta reads
#
#   jj diff --from 'main@upstream-pi-subagents' --to @ -- pi-subagents
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

MIRRORS="${PI_EXT_MIRRORS:-$HOME/Projects/dev/custom/.pi-ext-mirrors}"
FORKS=(
  "pi-subagents|pi-subagents|https://github.com/nicobailon/pi-subagents.git|.|964481f4ea5fac2cb8dceaa7ce60547d6c6ffd60 0958598823920997f9a9241c4b2ac367297c95e3 b6bda32f03b7f549623bc404c9be14dca298ddc4"
  "pi-herdsman|pi-herdsman|https://github.com/boadij/pi-herdsman.git|.|156b1c661a2e147d6bb2ef415abe44dd6b11af2f"
  "pi-otel|pi-otel|https://github.com/stnly/pi-otel.git|.|398d40a72a1ba3a599e8596f26c3f148df1e7296"
  "pi-bash-processes|kendex|https://github.com/vanillagreencom/kendex.git|pi-extensions/pi-background-tasks|8d17265bff800665d97dd41ee6146bcfa5865a5a"
  "pi-tool-renderer|kendex|https://github.com/vanillagreencom/kendex.git|pi-extensions/pi-tool-renderer|781eb4cfed71b1900de359476045953f51ccd545"
  "pi-output-policy|kendex|https://github.com/vanillagreencom/kendex.git|pi-extensions/pi-output-policy|781eb4cfed71b1900de359476045953f51ccd545"
)
UNTAKEN_SHOWN=8

refresh_pristine() {
  local mirror=$1 url=$2
  local dir="$MIRRORS/upstream/$mirror.git"
  if [ -d "$dir" ]; then
    git -C "$dir" fetch --quiet --prune origin '+refs/heads/*:refs/heads/*'
  else
    mkdir -p "$MIRRORS/upstream"
    git clone --quiet --mirror "$url" "$dir"
  fi
}

rewrite() {
  local pkg=$1 mirror=$2 path=$3
  local out="$MIRRORS/ns/$pkg.git"
  rm -rf "$out"
  mkdir -p "$MIRRORS/ns"
  git clone --quiet --mirror "$MIRRORS/upstream/$mirror.git" "$out"
  if [ "$path" = "." ]; then
    git -C "$out" filter-repo --force --to-subdirectory-filter "$pkg" >/dev/null
  else
    git -C "$out" filter-repo --force --path "$path" \
      --path-rename "$path/:" --to-subdirectory-filter "$pkg" >/dev/null
  fi
  git fetch --quiet "$out" "+refs/heads/*:refs/remotes/upstream-$pkg/*"
}

report() {
  local pkg=$1 mirror=$2 path=$3
  shift 3
  local pristine="$MIRRORS/upstream/$mirror.git"
  local ref="upstream-$pkg/main"
  local tip delta take last subject pivot="" behind newest_behind=""

  for take in "$@"; do
    last=$(git -C "$pristine" rev-list -1 "$take" -- "$path")
    subject=$(git -C "$pristine" log -1 --format=%s "$last")
    pivot=$(git log --format=%h -1 "$ref" --fixed-strings --grep="$subject")
    if [ -z "$pivot" ]; then
      printf '%s: recorded take %s (%s) is not in the rewrite — dropped by the path filter?\n' \
        "$pkg" "${take:0:7}" "$subject" >&2
      continue
    fi
    behind=$(git rev-list --count "$pivot..$ref")
    if [ -z "$newest_behind" ] || [ "$behind" -lt "$newest_behind" ]; then
      newest_behind=$behind newest_pivot=$pivot newest_subject=$subject newest_take=$take
    fi
  done

  tip=$(git log -1 --format='%h (%ad)' --date=short "$ref")
  delta=$(git diff --numstat "$ref" HEAD -- "$pkg" | wc -l)
  if [ -z "$newest_behind" ]; then
    printf '%-18s upstream %s — no recorded take resolved; %s files differ\n' "$pkg" "$tip" "$delta"
  else
    printf '%-18s upstream %s · last take %s %s · %s to take · %s files differ\n' \
      "$pkg" "$tip" "${newest_take:0:7}" "$newest_subject" "$newest_behind" "$delta"
    if [ "$newest_behind" != "0" ]; then
      git log --oneline --no-decorate -n "$UNTAKEN_SHOWN" "$newest_pivot..$ref" -- "$pkg" | sed 's/^/    /'
      [ "$newest_behind" -le "$UNTAKEN_SHOWN" ] || printf '    … %s more\n' "$((newest_behind - UNTAKEN_SHOWN))"
    fi
  fi

  local branch="import-$pkg" import_pivot branch_head drift
  if git rev-parse --verify --quiet "$branch" >/dev/null; then
    branch_head=$(git log -1 --format='%h %s (%ad)' --date=short "$branch")
    import_pivot=$(git log --format='%h' -1 "$branch" --fixed-strings --grep="${newest_subject:-}" 2>/dev/null || true)
    drift=$(git diff --numstat "$branch" HEAD -- "$pkg" | wc -l)
    if [ "$drift" -ne 0 ]; then
      local unit="files"
      if [ "$drift" -eq 1 ]; then unit="file"; fi
      printf '    %s holds through %s — this tree is %s %s past it, so a rebase there\n' \
        "$branch" "$branch_head" "$drift" "$unit"
      printf '      replays only what that branch carries. The delta is: git diff %s HEAD -- %s\n' \
        "$ref" "$pkg"
    elif [ -n "$import_pivot" ]; then
      printf '    %s holds through %s and matches the tree — rebase its delta with: git rebase --onto %s %s %s\n' \
        "$branch" "$branch_head" "$ref" "$import_pivot" "$branch"
    else
      printf '    %s holds through %s — predates the newest take, so a rebase there replays the older delta\n' \
        "$branch" "$branch_head"
    fi
  fi
}

wanted=("$@")
[ ${#wanted[@]} -gt 0 ] || wanted=(pi-subagents pi-herdsman pi-otel pi-bash-processes pi-tool-renderer pi-output-policy)

for entry in "${FORKS[@]}"; do
  IFS='|' read -r pkg mirror url path takes <<<"$entry"
  for want in "${wanted[@]}"; do
    [ "$want" = "$pkg" ] || continue
    refresh_pristine "$mirror" "$url"
    rewrite "$pkg" "$mirror" "$path"
    # shellcheck disable=SC2086
    report "$pkg" "$mirror" "$path" $takes
  done
done

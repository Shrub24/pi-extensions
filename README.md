# pi-extensions

Pi extension monorepo. Bun workspaces; every package is a plain directory in this
repo's history.

| Package | npm name | Provenance |
|---|---|---|
| `pi-bash-processes` | `@vanillagreen/pi-background-tasks` | fork of [vanillagreencom/kendex](https://github.com/vanillagreencom/kendex) `pi-extensions/pi-background-tasks`, extracted at `c9ee5844`; fork reason: a bounded foreground wait, configurable task policy, and log reads that consume the exit wake |
| `pi-tool-renderer` | `@vanillagreen/pi-tool-renderer` | fork of kendex `pi-extensions/pi-tool-renderer`, extracted after upstream `#2467` and kept current through `#3255` (`f5a2cd0a`); fork reason: the intent argument on the read/edit/write/search tools, the managed-bash row, panel chrome, and the bash registration deferred to `session_start` |
| `pi-subagents` | `pi-subagents` | fork of [nicobailon/pi-subagents](https://github.com/nicobailon/pi-subagents), vendored at upstream `#2586`; fork reason: an advisory per-run soft deadline and a mid-run child context budget; upstream is active |
| `pi-otel` | `pi-otel` | fork of [stnly/pi-otel](https://github.com/stnly/pi-otel) at `398d40a`; fork reason: trace-per-session became trace-per-run with Pi attempt and compaction semantics (`pi-otel/docs/plan.md`) |
| `pi-output-policy` | `@vanillagreen/pi-output-policy` | fork of `kendex` `pi-extensions/pi-output-policy` at `522c52c`, kept current through `#3213` (`6948c0f3`); fork reason: thinking deltas counted toward the 96K visible-output cap |
| `pi-jev` | `@vanillagreen/pi-jev` | new; semantic decisions from Jev, as a link in `@gotgenes/pi-permission-system`'s authorizer chain |
| `pi-cbmem` | `@vanillagreen/pi-cbmem` | new; codebase-memory MCP tools behind a short tool list, with a self-healing server |

## Layout

The files are the repository. No package is a gitlink or a nested `.git`, so a
change is a commit here and nothing has to be pinned or pushed twice.

What each package was before it moved in is kept as a rewritten branch:
`refs/heads/import-<package>` carries that package's whole history with every path
prefixed by its directory, so `git log import-pi-subagents -- pi-subagents` walks
the fork's history in this repo's own layout. `pi-jev` and `pi-cbmem` have no such
branch; they were born here.

## Upstreams

A fork of somebody else's live work needs two things this tree must not contain: a
pristine copy of upstream, and that copy path-rewritten so its commits line up
with this repo. Both live in `~/Projects/dev/custom/.pi-ext-mirrors`
(`PI_EXT_MIRRORS` overrides it) and reach this repo through `upstream-<package>`
remotes, which makes the two operations one command each:

```bash
git diff upstream-pi-subagents/main HEAD -- pi-subagents   # our delta against the current upstream tip
jj  diff --from main@upstream-pi-subagents --to @ -- pi-subagents   # the same, in jj's naming
./scripts/upstream.sh                                      # refresh mirrors; print what upstream has after our last take
git cherry-pick -n <sha>                                   # take one commit; it lands here as an ordinary commit
```

`scripts/upstream.sh` refreshes the mirrors and the rewrites, and reports per
package what upstream has after our last take and how many files differ. Five
upstreams are tracked: `nicobailon/pi-subagents` and `stnly/pi-otel` whole-repo,
and `vanillagreencom/kendex` for three packages, where the rewrite also filters —
kendex keeps its extensions under `pi-extensions/<name>`, so a take is the repo
state we extracted from and the pivot is that path's last commit at or before it,
which is content we actually have.

Right now `pi-subagents` and `pi-otel` are level with their upstreams (92 and 11
files differ — the 92 is our own delta, not lag). Two of the three kendex
packages were taken on 2026-10-01: `pi-tool-renderer` at `f5a2cd0a` (#3255) and
`pi-output-policy` at `6948c0f3` (#3213), both merging cleanly with this fork's
own work. `pi-bash-processes` is the last one — it needs a real merge rather than
a take, because the fork carries four commits upstream never adopted (a bounded
foreground wait, configurable task policy, soft timeouts, and the read shims
that stop a log read from consuming the exit wake) while upstream refactored
several of its concerns out into new modules. `pi-jev` and `pi-cbmem` were never
forks of anything.

The branch that carries a fork's lineage is `refs/heads/import-<package>`, not the
current tree: the `pi-subagents` directory arrived here as one commit even though
the import branch holds 1759. Rebasing that branch onto the mirror replays the
fork's own delta and nothing else:

```bash
git clone --shared . /tmp/rebase && cd /tmp/rebase
git checkout import-pi-subagents
git rebase --onto upstream-pi-subagents/main <pivot>       # pivot = that branch's last upstream commit
```

The pivot has to come from the branch being rebased. The two rewrites give the
same upstream commit different ids — `#2350` is `868e45be2` in the import branch
and `528029351` in the mirror — so an id from one is meaningless in the other;
`scripts/upstream.sh` resolves each in its own id space by subject.

A rebase replays only what the branch carries, and for `pi-subagents` that is no
longer what this tree differs by: the branch stops at `#2350`, one soft-deadline
commit past it, while the tree has since taken upstream twice and grown the
context-budget feature — 305 files apart. `pi-otel` is one file apart. The script
prints that gap for each fork, because the tree, not the branch, is where a
fork's work now lives: hence the 2026-09-30 syncs took upstream's tree whole and
re-applied the delta, which cost a hand resolution in the files both sides
changed and left the import branch behind.

## Develop

```bash
bun install
bun test          # every package's suite, one process each
```

`bun test` runs six suites: `pi-bash-processes`, `pi-tool-renderer`, `pi-otel`,
`pi-jev`, `pi-cbmem`, `pi-output-policy`. `pi-subagents` is left out deliberately —
it ships a large suite of its own that is red on its own terms, and a root `bun
test` without package paths would drag it in — so run it from its directory when
that is what you want to see.

Packages install into Pi by npm name (`pi install npm:<name>`), not from this repo.

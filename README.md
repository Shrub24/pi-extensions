# pi-extensions

Pi extension monorepo. Bun workspaces; every package is a plain directory in this
repo's history.

| Package | npm name | Provenance |
|---|---|---|
| `pi-bash-processes` | `@vanillagreen/pi-background-tasks` | fork of [vanillagreencom/kendex](https://github.com/vanillagreencom/kendex) `pi-extensions/pi-background-tasks`, extracted at `c9ee5844`, kept current through `#3289` (`8d17265b`); fork reason: see [its README](pi-bash-processes/README.md#fork-delta) |
| `pi-tool-renderer` | `@vanillagreen/pi-tool-renderer` | fork of kendex `pi-extensions/pi-tool-renderer`, extracted after upstream `#2467`, kept current through `#3312` (`781eb4cf`); fork reason: see [its README](pi-tool-renderer/README.md#fork-delta) |
| `pi-subagents` | `pi-subagents` | fork of [nicobailon/pi-subagents](https://github.com/nicobailon/pi-subagents), kept current through v0.74.0 (`f68f9edd`); fork reason: see [its README](pi-subagents/README.md) |
| `pi-herdsman` | `pi-herdsman` | fork of [boadij/pi-herdsman](https://github.com/boadij/pi-herdsman), imported at `156b1c66` (v0.18.0); no fork delta yet — it replaces `pi-subagents` as the delegation layer |
| `pi-otel` | `pi-otel` | fork of [stnly/pi-otel](https://github.com/stnly/pi-otel) at `398d40a`; fork reason: trace-per-session became trace-per-run with Pi attempt and compaction semantics (`pi-otel/docs/plan.md`) |
| `pi-output-policy` | `@vanillagreen/pi-output-policy` | fork of `kendex` `pi-extensions/pi-output-policy` at `522c52c`, kept current through `#3312` (`781eb4cf`); fork reason: see [its README](pi-output-policy/README.md#fork-delta) |
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
package what upstream has after our last take and how many files differ. Six
upstreams are tracked: `nicobailon/pi-subagents`, `boadij/pi-herdsman`, and `stnly/pi-otel` whole-repo,
and `vanillagreencom/kendex` for three packages, where the rewrite also filters —
kendex keeps its extensions under `pi-extensions/<name>`, so a take is the repo
state we extracted from and the pivot is that path's last commit at or before it,
which is content we actually have.

Right now every fork is level with its upstream — `pi-subagents` through v0.74.0 (`f68f9edd`, 2026-09-30), `pi-otel` at `398d40a` (0.3.1), and the three kendex packages through `#3289`/`#3312` (2026-09-30). What remains different from upstream is the forks' own delta, documented per package under "Fork delta" headings: `pi-bash-processes` (49 files — the bounded foreground wait, task policy, soft deadlines, read shims), `pi-tool-renderer` (62 files — the intent argument, managed-bash row, panel chrome, structured-content forwarding), `pi-subagents` (43 files — the child context budget with its vendored pi-vcc pipeline, the advisory soft deadline, the `read_` resource naming pi-mcp-adapter 3.2.0 expects), `pi-output-policy` (3 files — thinking deltas counted toward the 96K visible-output cap, plus structured-content forwarding), and `pi-otel` (11 files — the run-trace model). `pi-jev` and `pi-cbmem` were never forks of anything.

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

A rebase replays only what the branch carries, and for most forks that is no
longer what this tree differs by: the import branches stop at the extraction
point, while the trees have since taken upstream and grown features of their
own. The script prints that gap for each fork, because the tree, not the
branch, is where a fork's work now lives. Taking upstream is therefore a
tree-level operation — checkout upstream's tree, restore the files only the
fork changed, hand-merge the files both sides touched — and the import branches
are lineage reference, not a rebase base. (`pi-tool-renderer`'s import branch
matches its tree, so the rebase recipe genuinely works there.)

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

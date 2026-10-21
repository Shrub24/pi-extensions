# pi-extensions

Pi extension monorepo. Bun workspaces; every package is a plain directory in this
repo's history.

| Package | npm name | Provenance |
|---|---|---|
| `pi-bash-processes` | `pi-bash-processes` | fork of [vanillagreencom/kendex](https://github.com/vanillagreencom/kendex) `pi-extensions/pi-background-tasks`, extracted at `c9ee5844`, kept current through `#3289` (`8d17265b`); fork reason: see [its README](pi-bash-processes/README.md#fork-delta) |
| `pi-tool-renderer` | `pi-tool-renderer` | fork of kendex `pi-extensions/pi-tool-renderer`, extracted after upstream `#2467`, kept current through `#3312` (`781eb4cf`); fork reason: see [its README](pi-tool-renderer/README.md#fork-delta) |
| `pi-herdsman` | `pi-herdsman` | fork of [boadij/pi-herdsman](https://github.com/boadij/pi-herdsman), imported at `156b1c66` (v0.18.0); now carries the managed-agent lifecycle and Radar integration that replaced the retired `pi-subagents` package |
| `pi-otel` | `pi-otel` | fork of [stnly/pi-otel](https://github.com/stnly/pi-otel) at `398d40a`; fork reason: trace-per-session became trace-per-run with Pi attempt and compaction semantics (`pi-otel/docs/plan.md`) |
| `pi-output-policy` | `@vanillagreen/pi-output-policy` | fork of `kendex` `pi-extensions/pi-output-policy` at `522c52c`, kept current through `#3312` (`781eb4cf`); fork reason: see [its README](pi-output-policy/README.md#fork-delta) |
| `pi-jev` | `@vanillagreen/pi-jev` | new; semantic decisions from Jev, as a link in `@gotgenes/pi-permission-system`'s authorizer chain |
| `pi-cbmem` | `@vanillagreen/pi-cbmem` | new; codebase-memory MCP tools behind a short tool list, with a self-healing server |

## Layout

The files are the repository. No package is a gitlink or a nested `.git`, so a
change is a commit here and nothing has to be pinned or pushed twice.

Where available, `refs/heads/import-<package>` preserves a package's original
history with paths prefixed by its directory. `import-pi-subagents` remains only
as historical lineage after that package's retirement. `pi-jev` and `pi-cbmem`
were born here and have no import branch.

## Upstreams

A fork of somebody else's live work needs two things this tree must not contain: a
pristine copy of upstream, and that copy path-rewritten so its commits line up
with this repo. Both live in `~/Projects/dev/custom/.pi-ext-mirrors`
(`PI_EXT_MIRRORS` overrides it) and reach this repo through `upstream-<package>`
remotes, which makes the two operations one command each:

```bash
git diff upstream-pi-herdsman/main HEAD -- pi-herdsman   # our delta against the current upstream tip
jj  diff --from main@upstream-pi-herdsman --to @ -- pi-herdsman   # the same, in jj's naming
./scripts/upstream.sh                                      # refresh mirrors; print what upstream has after our last take
git cherry-pick -n <sha>                                   # take one commit; it lands here as an ordinary commit
```

`scripts/upstream.sh` refreshes the mirrors and rewrites, then reports upstream
lag and local file differences for five active fork packages: `pi-herdsman` and
`pi-otel` track whole repositories; `pi-bash-processes`, `pi-tool-renderer`, and
`pi-output-policy` track their respective paths in `vanillagreencom/kendex`.

Run `scripts/upstream.sh` for current upstream lag. The active fork deltas are documented in the package READMEs; `pi-herdsman` now owns managed-agent lifecycle and Radar integration. `pi-subagents` was retired and removed from the workspace; its import branch remains historical only. `pi-jev` and `pi-cbmem` were never forks of anything.

Import branches preserve lineage, but may not contain the current package
delta. The upstream script reports that gap; use the package tree—not an old
import branch—as the source of truth when taking upstream changes.

## Develop

```bash
bun install
bun run test     # every package's suite, one process each
```

The root `bun run test` script runs seven package suites: `pi-bash-processes`,
`pi-tool-renderer`, `pi-otel`, `pi-jev`, `pi-cbmem`, `pi-output-policy`, and
`pi-reqcap`.

Packages install into Pi by npm name (`pi install npm:<name>`), not from this repo.

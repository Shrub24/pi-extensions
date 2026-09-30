# pi-extensions

Pi extension monorepo. Bun workspaces; every package is a plain directory in this
repo's history.

| Package | npm name | Provenance |
|---|---|---|
| `pi-bash-processes` | `@vanillagreen/pi-background-tasks` | extracted from [vanillagreencom/kendex](https://github.com/vanillagreencom/kendex) at `b146363` (`pi-extensions/pi-background-tasks`); independent since |
| `pi-tool-renderer` | `@vanillagreen/pi-tool-renderer` | extracted from [vanillagreencom/kendex](https://github.com/vanillagreencom/kendex) (`pi-extensions/pi-tool-renderer`), last upstream commit `#2467`; independent since |
| `pi-subagents` | `pi-subagents` | fork of [nicobailon/pi-subagents](https://github.com/nicobailon/pi-subagents), vendored at upstream `#2586`; fork reason: an advisory per-run soft deadline and a mid-run child context budget; upstream is active |
| `pi-otel` | `pi-otel` | fork of [stnly/pi-otel](https://github.com/stnly/pi-otel) at `398d40a`; fork reason: trace-per-session became trace-per-run with Pi attempt and compaction semantics (`pi-otel/docs/plan.md`) |
| `pi-output-policy` | `@vanillagreen/pi-output-policy` | fork of `kendex` `pi-extensions/pi-output-policy` at `522c52c`; fork reason: thinking deltas counted toward the 96K visible-output cap |
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
git diff upstream-pi-subagents/main HEAD -- pi-subagents   # what upstream has that we do not
git cherry-pick -n <sha>                                   # take one fix; the commit lands here
```

`scripts/upstream.sh` refreshes the mirrors and the rewrite and prints how far
behind each fork is. Both forks sit on upstream heads and carry a local delta on
top. The other four are independent: kendex's copies of
`pi-bash-processes`, `pi-tool-renderer` and `pi-output-policy` are frozen (a single
version-bump commit since the extraction), and `pi-jev` and `pi-cbmem` were never
forks of anything.

Our commits are not linear descendants of upstream's, so an update is a
cherry-pick of the commits worth having rather than a rebase — the mirrors exist
to make that a one-liner, not to keep a lineage that would be rewritten anyway.

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

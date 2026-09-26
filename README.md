# pi-extensions

Pi extension monorepo. Bun workspaces, each package a standalone Pi extension with its own git history.

| Package | npm name | Provenance |
|---|---|---|
| `pi-bash-processes` | `@vanillagreen/pi-background-tasks` | extracted from [vanillagreencom/kendex](https://github.com/vanillagreencom/kendex) (import at `b146363`); independent since |
| `pi-tool-renderer` | `@vanillagreen/pi-tool-renderer` | extracted from [vanillagreencom/kendex](https://github.com/vanillagreencom/kendex); reference remotes only |
| `pi-subagents` | `pi-subagents` | fork of [nicobailon/pi-subagents](https://github.com/nicobailon/pi-subagents) (`upstream` remote); publish from [Shrub24/pi-subagents](https://github.com/Shrub24/pi-subagents) (`origin`) |
| `pi-jev` | `@vanillagreen/pi-jev` | new; semantic permission decisions from Jev, as a link in `@gotgenes/pi-permission-system`'s authorizer chain |
| `pi-output-policy` | `@vanillagreen/pi-output-policy` | fork of [vanillagreencom/kendex](https://github.com/vanillagreencom/kendex) `pi-extensions/pi-output-policy` @ `522c52c` (`upstream` remote); fork reason: `modelOutputGuard` counted thinking deltas toward the 96K visible-output cap and aborted reasoning-model streams mid-think |
| `pi-otel` | `pi-otel` | fork of [stnly/pi-otel](https://github.com/stnly/pi-otel) (`upstream` remote) @ `398d40a`; fork reason: trace-per-session topology → trace-per-run + Pi attempt/compaction semantics (see `pi-otel/docs/plan.md`) |

## Layout

Each subrepo keeps its own `.git`, so upstream diffing stays per-package:

```bash
git -C pi-subagents fetch upstream && git -C pi-subagents log --oneline upstream/main
git -C pi-subagents diff main...upstream/main   # what upstream has that we don't
```

The root repo tracks the subrepos as gitlinks and owns workspace-level files (lockfile, this README, `.gitignore`).

## Develop

```bash
bun install
bun test          # pi-bash-processes + pi-tool-renderer + pi-jev suites
```

Packages install into Pi by npm name (`pi install npm:<name>`), not from this repo.

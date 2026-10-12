# Radar container packaging — build and smoke acceptance

Date: 2026-10-13 (local system clock). Scope: the pi-herdsman container image,
its entrypoint, and `scripts/container-smoke.sh` after the Herdr removal.
Written by the packaging worker; every command below was run in this session.

## Where this stopped

Complete. The corrected `scripts/container-smoke.sh` passes end to end, exit 0,
against local image ID
`16ef0ab74d750e38a6da892aef64470c4ed69fddc5fa89a71905fd042bbc4417` (see
Validation). Two pre-existing defects in the packaged path blocked Pi bootstrap,
a third defect in the smoke's own persisted-state fixture caused the previous
open failure, and a fourth defect made remote runtime assertions non-binding:

- **B1**: the base image's tmux (Debian trixie `3.5a`) cannot serve the pinned
  Radar daemon — `mux.observe` refuses, and the container's Pi never reaches the
  daemon registry.
- **B2**: the packaged extension statically imports the sibling workspace package
  `pi-bash-processes`, which a pi-herdsman-only image build context cannot ship —
  Pi exits at startup with `Failed to load extension`.
- **B3**: the smoke installed a persistence fixture (`~/persist-package`) that
  contains no loadable resource, so every Pi start after that install exited with
  `Failed to load extension "…/persist-package"` and took its pane, session and
  tmux server with it.
- **B4**: `verify_runtime` sent its checks to the container as one semicolon list,
  and the remote shell has no errexit, so the remote status was the last check's
  alone. A wrong expected Pi version, a wrong expected Radar commit and a present
  forbidden `herdr` binary each returned success. Fixed with an `&&` chain.
- **B5**: the same masking hid a claim that had never held. `npm config get
  update-notifier` is not `false` in an SSH session, because sshd builds the
  session environment and drops the image's `NPM_CONFIG_UPDATE_NOTIFIER` (see
  B5 below).

Each was probed to a working state inside a disposable container, so the fix
route for each is measured rather than assumed (see the sections below).

## Pin and image identity

- `pi-herdsman/package.json` `piHerdsman.runtime`: `pi` = `1.1.0`,
  `radar.commit` = `f87348032a808967c50a4e84b7e1c766a64ebfe3`, `radar.protocol` = 2.
- Pin facts read from the commit object in `/home/saurabhj/Projects/dev/agent-radar`
  (`git show <pin>:…`, not the working tree): `origin` =
  `https://github.com/Shrub24/agent-radar.git`; `Cargo.toml` = `name =
  "agent-radar"`, `edition = "2024"`, `rust-version = "1.88"`, `[[bin]] name =
  "radar"`; `src/main.rs` serves the `daemon` subcommand and requires
  `RADAR_CONTROL_BACKEND=tmux` with `RADAR_TMUX_SERVER` for the tmux backend.
- The Dockerfile already matched the pin: `rust:1.88-bookworm`, fetch of that
  exact commit, `test "$(git rev-parse HEAD)" = "$commit"`, then
  `cargo build --release --locked --bin radar`. The build ran to
  `Finished \`release\` profile [optimized] target(s) in 22.82s`.
- Earlier image IDs recorded in the preceding pass:
  `0ec424502b8c1a3592aa71a91711150f6910ac3804af740f3ce34ff0359fe74a` (tag
  `pi-herdsman:smoke`) and pre-change image
  `13d395384ad93cd0cfe67b98542953d457b53a0b6615f993dcb7e5bb88442f73` (1 m 19 s).
- Tested artifact: local image ID
  `16ef0ab74d750e38a6da892aef64470c4ed69fddc5fa89a71905fd042bbc4417`, tagged
  `pi-herdsman:smoke` at test time. This is a local image ID, not a registry
  RepoDigest. The recorded base commit is
  `b73c7ecb23335e87230cfade05ea5d61237fdfdc`, plus modified working-tree build
  inputs; no immutable full source snapshot was captured. The recorded build-input
  file digests were Dockerfile
  `dfa7b77983056f2d3f33ec9262d10953845795edfd018b8703bff395d8b9217f`, entrypoint
  `f87f7bee0d1ccbabd009bc72b0922045d1236f3ef14bf9943dfedb8a427580f5`, smoke
  `db84f35c98fc821d99cfcdf24334f036c7583b6405ce447b03b7678ab8ef06e1` and
  `Dockerfile.dockerignore`
  `2dd10e2c2799724272d08788ea9158e8ec681ef6c29e51cbeabccc92654dbfe1`. These four
  digests do not identify all runtime or sibling sources included in the image.
  The base commit's Dockerfile digest is
  `bf8bbd038e9fbf4934abd2be77c91b8b38bd89740800de480d0a52dc922737ab`, not the
  recorded tested-input digest.
- The exact tested image is identifiable by its local image ID. Earlier image IDs
  included `72c003d13c0b…`, `465062589e39…` and `4028f2643fee…`; their difference
  does not establish a cause. Layers or all inputs were not compared, so
  bit-identical rebuild reproducibility is not established.
- Packaged-content fingerprint from the exact tested image is recorded below. It
  fingerprints image contents, not a reconstructed source snapshot.
- Contents verified: `/usr/local/bin/radar` (5 329 624 bytes),
  `/usr/local/bin/pi -> /opt/pi/pi` reporting `1.1.0`, `/usr/bin/tmux`
  (pre-change image; `/usr/local/bin/tmux` `3.7c` afterwards),
  `/opt/pi-herdsman`, and `command -v herdr` absent.
- Added in this slice: the radar stage records the commit it built from, and the
  final image carries it at `/usr/share/doc/pi-herdsman/radar-commit`, so the
  smoke can compare the image against the manifest instead of trusting it.

## D1 — the image build ran a host-only package audit (fixed)

`npm run package:audit` rejects a duplicate of `/tmp/root.jsonl` — the literal at
`extension/support.ts:977` and `extension/agent-runtime.test.ts:3195` — because
its `home path` rule is `homedir()` and the builder's `homedir()` is `/root`
inside `node:26.10.0-trixie-slim`, while the fixture literal already contains
`/tmp/root.json`. The audit passes on the host and is the authoritative gate in
`validate.yml` (`package` job) ahead of the container job, so the image build no
longer repeats it. This was the only reason the first image build failed.

## B1 — tmux 3.5a cannot serve the pinned Radar daemon

Measured in the container with the same binary as client and server
(`/usr/bin/tmux`, `/usr/local/bin/tmux` after the source build below):

```
tmux 3.5a  list-sessions -F "$(printf 'A\037B')"  ->  A \ 0 3 7 B        (4 characters)
tmux 3.7c  list-sessions -F "$(printf 'A\037B')"  ->  A 037 B            (the raw 0x1F byte)
tmux 3.5a  list-sessions -F 'A\B'                 ->  A \ B              (literal backslash untouched)
```

tmux 3.5a escapes non-printable characters in `-F` output as `\ooo`; 3.7c passes
them through. The pinned daemon splits its tmux records on that raw byte
(`src/tmux.rs`: `FIELD = '\u{1f}'`, `SESSION_FORMAT`, `decode_sessions` ->
`split_record::<2>`), so on 3.5a every record arrives as one field and the read
fails:

```
mux.observe: refused backend_unavailable: malformed tmux session list:
"$0\\037herdsman" is not a record of the shape it was asked for
```

Consequence, measured against the image as built (tmux 3.5a): the tmux pane `%0`
holds a live `pi` (pid 44) with `RADAR_CONTROL_SOCKET=/run/herdsman/control.sock`,
`TMUX_PANE=%0` and the extension installed in `/opt/pi-herdsman`, yet the daemon's
state directory holds **no registration and no publication** (`state/agents/` and
`state/publications/` empty) — a container whose Pi is invisible to the fleet.

Fix route probed: tmux 3.7c built from its release tarball inside the same
container. With only that change (plus B2's sibling, below) the stack check passes:

```json
{"protocol":2,"backend":"tmux","instance":"herdsman","pane":"tmux:herdsman:%0",
 "agent_id":"d1e66ff8-0a57-4ada-a855-41efac365dba","source":"herdsman-pi","process":"verified"}
```

The registration it reads back carries `location.pane = "tmux:herdsman:%0"` and a
process claim the daemon verifies, i.e. the Pi in the entrypoint's pane is proven
alive and bound to that pane.

Approved and implemented: build a pinned tmux from its release tarball in an image
stage and drop the distribution package (see "Implemented changes"). Build needs `build-essential`, `libevent-dev`,
`libncurses-dev` and `bison` (configure fails with `yacc not found` without it);
the release asset `tmux-3.7c.tar.gz` has SHA-256
`7c60cae9a0e25288e2e24750aafc9e8800fc7fd4555e447e1b29ee4201cfb3bf`. 3.7c is the
version the host runs, i.e. the version every existing host-side validation used.
Whether 3.6 also passes is untested.

## B2 — the packaged extension needs its sibling workspace package

`extension/index.ts:101` and `extension/advisory-wake.ts:1-2` statically import
`../../pi-bash-processes/extensions/background-work.ts` and
`wake-consumer.ts` (introduced by `02224fe94`, 2026-10-01; present at HEAD). The
image packs pi-herdsman alone from a pi-herdsman-only build context, so in the
container the import cannot resolve and Pi exits at startup, which closes the pane
and takes the tmux session and server with it:

```
Error: Failed to load extension "/opt/pi-herdsman/extension/index.ts":
Failed to load extension: ResolveMessage: Cannot find module
'../../pi-bash-processes/extensions/background-work.ts' from '/opt/pi-herdsman/extension/index.ts'
Hint: Start without extensions using "pi -ne".
```

Fix route probed: copy `pi-bash-processes/extensions` (39 files, no cross-package
imports in that directory) to `/opt/pi-bash-processes/extensions`, which is where
`../../pi-bash-processes/extensions/…` resolves from `/opt/pi-herdsman/extension/`.
Pi then boots, loads the extension, and registers as above.

## Implemented changes

- `Dockerfile`: new `tmux-build` stage on the same base as the final image
  (`bison`, `build-essential`, `ca-certificates`, `curl`, `libevent-dev`,
  `libncurses-dev`, `pkg-config`), fetching the pinned release tarball, verifying
  the SHA-256 above before extraction, building, and exporting the binary, its
  `COPYING` and a `tmux-build.txt` record into the image as
  `/usr/local/bin/tmux`, `/usr/share/doc/pi-herdsman/third-party/tmux-LICENSE` and
  `/usr/share/doc/pi-herdsman/tmux-build.txt`. The distribution `tmux` package is
  gone; `libevent-core-2.1-7t64` and `libtinfo6` stay for the binary. Radar is
  untouched at `f87348032a808967c50a4e84b7e1c766a64ebfe3`.
- `Dockerfile`: the image now builds from the monorepo root. `COPY` paths carry
  the `pi-herdsman/` prefix, and the sibling runtime source is copied in
  (`pi-bash-processes/package.json`, `pi-bash-processes/extensions`) and installed
  at `/opt/pi-bash-processes`, which is what
  `../../pi-bash-processes/extensions/…` resolves to from
  `/opt/pi-herdsman/extension/index.ts`. Sibling source and lockfiles are
  untouched.
- `Dockerfile.dockerignore` (new, honoured by this builder — verified with a
  probe build): an allowlist of the package and the sibling runtime inputs, so the
  context excludes `.git`, `.jj`, `node_modules`, session records, credentials and
  unrelated projects.
- `scripts/container-smoke.sh`: resolves the monorepo root itself, builds with
  `-f pi-herdsman/Dockerfile .`, reads the manifest from `pi-herdsman/package.json`,
  asserts the image's recorded Radar commit against it, and checks the stack as
  described below. Its persistence fixture now installs a loadable package
  (`extensions/persist.ts`) instead of an empty declaration, and it asserts
  `verify_stack` after the persisted restart as well as on first start (B3).
- `docs/guides/container-deployment.md`: the build-from-checkout command and
  context note, replacing the Herdr machine sections.

## The rewritten smoke

`scripts/container-smoke.sh` no longer knows Herdr. In order: the image is built
from the pin; `verify_runtime` asserts Pi 1.1.0 at `/opt/pi/pi`, node 26, `radar`
and `tmux` present, **no** `herdr` binary, the image's recorded Radar commit equal
to `piHerdsman.runtime.radar.commit`, and that Pi loads the package extension
without `Failed to load extension`; `verify_stack` asserts exactly one pane of the
`herdsman` server runs Pi and then reads the daemon over its own control socket —
protocol 2, backend `tmux`, instance `herdsman`, the capabilities a managed launch
requires (`mux.observe`, `registry.v1`, `spawn.v1`, `spawn.close.v1`,
`spawn.launch_context.v1`), exactly one observed `tmux:herdsman:%N` pane, a
registration bound to that pane, and that registration's process verdict
`verified`. The login probe now shadows `tmux`: an interactive login must ask the
`herdsman` server for the session and then attach to it, and with `TMUX` already
set it must do neither. Herdr's stale `herdr-agent-state.ts` check is gone.

Boundary: this is setup/bootstrap acceptance. It reads the daemon; it does not
take an assignment and run a child. That is what the real-child acceptance owns.

## B3 — the smoke's persisted fixture killed Pi on the start after installing it

Root cause of the failure that stayed open in the previous pass. The smoke created
a package with only a manifest:

```sh
printf '%s\n' '{"name":"persist-package","version":"1.0.0"}' > ~/persist-package/package.json
pi install ~/persist-package
```

Pi records that path in `~/.pi/agent/settings.json` (`"../../persist-package"`
beside `"../../../../opt/pi-herdsman"`). A package exposes resources through
conventional directories (`extensions/`, `skills/`, `prompts/`, `themes/`) or an
explicit `pi` manifest (`/opt/pi/docs/packages.md`); this directory has neither, so
loading it fails and Pi exits at startup — in the pane, not only on the command
line:

```
Error: Failed to load extension "/home/herdsman/persist-package": Failed to load
 extension: ResolveMessage: Cannot find module '/home/herdsman/persist-package'
from '/$bunfs/root/pi'
Hint: Start without extensions using "pi -ne".
```

These are the pane's last words, not the container's: the pane process exits
status 1, non-`remain-on-exit` tmux closes the pane on pane-process exit, the last
pane closes the session, and the server exits leaving only the stale socket
`/tmp/tmux-1000/herdsman`. That is why `verify_stack` reported `no server running`
and why `docker logs` showed a healthy entrypoint: the pane's screen is not in the
container's stdout, and the daemon keeps running (it is started directly by the
entrypoint) with empty `state/agents/` and `state/publications/`.

Why it looked like a replacement-only defect: of the smoke's starts, only the
first ones run `verify_stack` before the fixture exists. The persisted-restart
start is the first stack check after the install, so it was where the damage
surfaced. Every start after the install was affected, including the one with no
stack check.

Evidence, one instance and one variable at a time (base commit
`b73c7ecb23335e87230cfade05ea5d61237fdfdc` plus modified working-tree build
inputs; no immutable full source snapshot was captured; runs use the same image
unless stated):

1. Reproduced with the absent `verify_stack` after the persisted restart: the
   preserved instance was container `791844e76299fc2cfe4cbcb7fe439f6a710e0088911deca9342128a566157197`
   of image `465062589e39…`, `running`, SSH answered, entrypoint, daemon (pid 41)
   and sshd alive, no `pi` process, no tmux server, stale socket present.
2. Instrumented that exact persisted home and SSH state with only
   `set-option -g remain-on-exit on` in `~/.tmux.conf` and restarted the same
   container: `pane=%0 dead=1 status=1 cmd=pi pid=43`, and `capture-pane` printed
   the load error above. The instrument is required because the failure destroys
   its own pane.
3. One-variable repair on the same volumes, same image, same container: added
   `~/persist-package/extensions/persist.ts` containing
   `export default function () {}` — the conventional entrypoint — and restarted.
   Result: `pane=%0 dead=0 cmd=pi`, and the strict probe returned
   `{"protocol":2,"backend":"tmux","instance":"herdsman","pane":"tmux:herdsman:%0",
   "agent_id":"f4599031-…","source":"herdsman-pi","process":"verified"}`.

Fix (`scripts/container-smoke.sh`, authorized scope): the fixture now installs a
valid package (`extensions/persist.ts`, a no-op) so it exercises persistence
rather than an unloadable declaration, and the persisted-restart start now asserts
`verify_stack` as well. That assertion is the one that would have caught B3; the
smoke previously checked the stack only on starts that predate the fixture.

## B4 — the remote runtime checks could not fail

Found in review and reproduced before fixing. `verify_runtime` sent one string to
the container, with the checks separated by `;`. The local `set -euo pipefail`
does not govern the remote shell, and sshd starts it without errexit, so the exit
status the smoke saw was the final `! grep -q 'Failed to load extension'`
regardless of what happened above it.

Reproduction and controls, both through the same seam: a harness extracts `start`,
`remote` and `verify_runtime` **verbatim from the script** (so the control sends
the same command string the smoke sends), starts a container from the certified
image, and varies only the expectation or the container state.

Pre-fix, against image `72c003d13c0b…` (container `f4f35a8fab37…`):

| control | remote exit | expected |
| --- | --- | --- |
| correct runtime | 0 | 0 |
| wrong expected Pi version (`9.9.9`) | 0 | nonzero |
| wrong expected Radar commit (40 zeros) | 0 | nonzero |
| forbidden `herdr` binary present | 0 | nonzero |

Three false passes, i.e. the finding reproduces at the real boundary and not only
by reading the source.

Fix (`scripts/container-smoke.sh`, authorized scope): every check is joined to the
next with `&&`, which the remote shell evaluates as one status chain, so the first
failing check is the remote status and `ssh` returns nonzero. A comment states the
invariant. The npm global-tree check now captures the listing with an assignment
step, so a failing `npm list` can no longer be mistaken for proof that the package
is absent, and `pi --offline --help` has to exit 0 before its output is grepped.
Both were measured to exit 0 in this image, so requiring their success adds no new
failure mode. The tmux-stub setup block (`mkdir; cat; chmod`) had the same shape
and is now an `&&` chain as well; the remaining `remote` calls in the file are
single commands or already chained.

Post-fix, against the same image (container `63c538c8ac99…`):

| control | remote exit | expected |
| --- | --- | --- |
| correct runtime | 0 | 0 |
| wrong expected Pi version (`9.9.9`) | 1 | nonzero |
| wrong expected Radar commit (40 zeros) | 1 | nonzero |
| forbidden `herdr` binary present | 1 | nonzero |
| `herdr` removed again | 0 | 0 |

## B5 — a claim that never held: the npm update notifier in an SSH session

Enforcing the chain exposed a link that had always been false. With the checks
individually reported through the same seam:

```
exit=0  test "$(pi --version)" = '1.1.0'
exit=0  test "$(readlink -f "$(command -v pi)")" = /opt/pi/pi
…
exit=1  test "$(npm config get update-notifier)" = false      <- the failure
…
exit=0  ! grep -q 'Failed to load extension' /tmp/pi-help
```

Cause, measured in the same container:

```
docker exec --user herdsman … env | grep -i npm      -> NPM_CONFIG_UPDATE_NOTIFIER=false
npm config get update-notifier (container process)   -> false
ssh session: env | grep -i npm                       -> no NPM_* in env
npm config get update-notifier (SSH session)         -> true
entrypoint's Pi pane: /proc/<pane pid>/environ       -> NPM_CONFIG_UPDATE_NOTIFIER=false
```

sshd builds the session environment itself, so the image's `ENV` reaches container
processes — the daemon, the Pi pane, every `docker exec` — but not an SSH session.
The image does disable the notifier where the image sets it; the old check asked an
environment that never received it, and the masking in B4 is why it went unnoticed.

Resolution here: the key stays asserted at the boundary that owns it, on the
existing direct `docker exec` check, which runs in the container's environment and
is not part of any remote list, with a comment saying why it sits there rather than
in `verify_runtime`. Coverage for the claim is unchanged; only the false duplicate
was removed.

Owner ruling: leave SSH notifier behavior unchanged in this cutover. The covered
contract is the container process environment and the Pi pane, where the image's
`NPM_CONFIG_UPDATE_NOTIFIER=false` is present; an SSH login is outside that
boundary. The direct `docker exec` assertion verifies the setting in the image
process environment. Removing the false SSH-level duplicate corrects the claim;
it does not remove container-process coverage.

## Previous open question (resolved by B3)

The earlier pass left this open: the final `verify_stack` failed with `no server
running on /tmp/tmux-1000/herdsman` about a second after that start's SSH
answered, while two earlier `verify_stack` checks in the same run passed. The
recorded guesses — that the persisted home or the symlink-attack cleanup broke
Pi, or that replacement itself was the trigger — are superseded by the measured
cause in B3; the persisted-restart start was simply the first stack check after
the unloadable package was installed. The intermediate claim that a replacement
preserves the pane was withdrawn before this pass and stays withdrawn: no such
observation was completed, and the question no longer needs one.

## Validation performed

- `bash -n scripts/container-smoke.sh` clean; no shellcheck on this host.
- Image builds from the pin; radar-commit attribution matches the manifest
  (`f87348032a808967c50a4e84b7e1c766a64ebfe3` in both).
- Stack probe passes with B1 + B2 repaired in a disposable container (result above),
  and fails on the unrepaired image as designed: with tmux 3.5a
  `mux.observe` returns the `malformed tmux session list` refusal, and the daemon
  holds no registration.
- Login probe both ways in a container whose `herdsman` server was up:
  <br>`herdsman:/home/herdsman:/home/herdsman -L herdsman has-session -t herdsman`
  <br>`herdsman:/home/herdsman:/home/herdsman -L herdsman attach-session -t herdsman`
  <br>and with `TMUX` set, `bash -ic` ran and no tmux invocation was recorded.
- Build from the monorepo root: image `465062589e39…` (also `4028f2643fee…`),
  the tmux stage reporting `3.7c` with the SHA-256 check passing, and Pi's own
  `Failed to load extension` string absent from `pi --offline --help`.
- Full `scripts/container-smoke.sh` runs, three of them, on the rebuilt image.
  The first two failed on defects the rewrite introduced (a `docker exec` whose
  `$(cat /tmp/bash-ran)` was evaluated on the host, and Dockerfile `COPY` paths
  still relative to the old context), both fixed. The third ran through the whole
  script to its last `verify_stack`, which failed as described above; every other
  check passed, including two `verify_stack` passes with
  `{"protocol":2,"backend":"tmux","instance":"herdsman","pane":"tmux:herdsman:%0",
  "agent_id":"6ab41a0f-…","source":"herdsman-pi","process":"verified"}`.
- Local log-driver adaptation, disclosed: this host's Docker-compatible runtime is
  rootless podman 5.8.8 configured for the `journald` log driver with no running
  journal, so `docker logs` returns nothing for any container (reproduced with a
  trivial `-d` container). The smoke's own checks were not weakened: a PATH shim
  adds `--log-driver=k8s-file` to `docker run` and serves `docker logs` from the
  container's log file. CI's real Docker needs none of this.
- Full `scripts/container-smoke.sh` run, exit 0 — the pass B4 and B5 were found in.
  Read its runtime checks as unenforced: `verify_stack` was binding, `verify_runtime`
  was not (B4), so the stack phases below remain valid evidence while the runtime
  assertions did not yet constrain anything. Final image `72c003d13c0bff106cc0c4d1e601152f495fe77c19369e92c81438d84b2b503b`:
  closing line
  `Container smoke test passed (Pi 1.1.0, Radar f87348032a808967c50a4e84b7e1c766a64ebfe3).`,
  with four `verify_stack` passes, each a verified daemon-bound registration
  (`8c74028a…` for the first start and after the login probe, `74aecc3a…` after the
  persisted restart, `2ca8e43a…` at the end).
- Corrected full `scripts/container-smoke.sh` run, exit 0, with every runtime check
  binding. The tested local image ID is
  `16ef0ab74d750e38a6da892aef64470c4ed69fddc5fa89a71905fd042bbc4417`. Its build
  inputs were the recorded base commit plus modified working-tree inputs described
  above; no immutable full source snapshot was captured. Closing line the same as
  above; four `verify_stack` passes, each verified and bound to
  `tmux:herdsman:%0` (`dd2a96a3…` twice, `66b22d12…`, `d4b9e773…`). Post-run checks
  on that image: recorded Radar commit `f87348032a808967c50a4e84b7e1c766a64ebfe3`,
  `tmux 3.7c`, `herdr` absent.
- Read-only content fingerprint of that exact image, via disposable command-
  override container (`podman run --rm --read-only --network none --entrypoint
  python3 <image-id> -c <walker>`). The walker did not follow symlink directories;
  it sorted entries by relative path, recorded regular files as `file<TAB>path<TAB>`
  plus each file's SHA-256, and symlinks as `symlink<TAB>path<TAB>` plus target
  text. SHA-256 was taken over newline-terminated, path-sorted manifest lines; the
  combined manifest includes the root path in each entry. Results:
  `/opt/pi-herdsman`: 153 entries, manifest SHA-256
  `a8ddb7b952e067199e3c06a14fed89a6f82155b508e7037e9eb61266a3aa90a8`;
  `/opt/pi-bash-processes`: 39 entries, `96aedeb1e308625d9e9a0ca31b875c683e0f9557dee3e1dd247be65d81c7e045`;
  combined: 192 entries,
  `675ef19818aed889ddd57f8dd9679e8befde9cceaddf0ac91b5897e3178d4aea`.
  These fingerprint packaged image contents, not a reconstructed source snapshot.
- Run-time controls for the runtime assertions (B4), through the smoke's own
  `remote`/`verify_runtime` text: pre-fix three false passes, post-fix one exit 0
  for the correct runtime and exit 1 for each of the three negatives.
- `bash -n scripts/container-smoke.sh` clean after the B4 change; no shellcheck here.
- Temporary instrumentation, all removed after use: the control harness, the
  per-link and per-environment probes and their output files (all under `/tmp`),
  the injected `herdr` stub (inside the removed control container), and the control
  container and its volumes. No `runtime-assert-control` or `pi-herdsman-smoke`
  container or volume remains.
- Final image contents re-checked after that run: `/usr/local/bin/tmux` reports
  `tmux 3.7c`, `herdr` absent, both under the same tag.
- Not validated on this host: the smoke's `docker logs` first-start check needs a
  working log driver. Rootless podman 5.8.8 here has `journald` selected with no
  running journal, so `docker logs` returns nothing for any container (reproduced
  with a trivial `-d` container). A PATH shim storing a `k8s-file` log restores it
  and the full run then passes; CI's real Docker needs no shim. No smoke assertion
  was weakened for this.
- One aborted full run is excluded from the record: its own cause was deleting the
  local log shim while it was still executing, which removed that container in
  its cleanup path; the run had already passed its third `verify_stack`.

## Existing Herdr references left in place

Out of this slice, all reported in the handoff: `package.json`'s two objective
Herdr mentions (`pi.bundle` excluded package, plugin keyword), code identifiers
in `extension/index.ts` (`TestHerdrTarget`, `HerdsmanPluginConfig.herdr`,
`HerdRun`); `supervision.ts` (`HERDR_SOCKET_PATH`, `normalizeHerdrLifecycleState`),
`radar-execution.ts` (`herdr:blocked` listener), `support-radar.ts`
(`HERDR_WORKSPACE_ID`/`HERDR_TAB_ID`), `presentation.ts` labels,
`extension/support.ts`'s `HERDR_*` fixture env and fake Herdr CLI executors;
`docs/integration-*.md` and other runtime docs owned by the runtime slice.

# Implementation evidence

Router implementation and all eleven implementation tasks are verified. Deployment activation and a single-process deployed-plugin smoke remain separate release gates. External Magic Context/config changes were implemented by their owner; no VCS mutations performed here.

## Matching host and production seam

Installed `/nix/store/f7xm46nlyfw9p020nj8j8jlmd98c3f7i-pi-bolt-0.7.4/lib/pi-bolt/package.json` identifies coding-agent **1.1.0**. Published `@earendil-works/pi-coding-agent@1.1.0` and `pi-agent-core@1.1.0` were inspected in `/tmp/pi-native-router-host`; router devDependencies pin these versions. Herdsman's existing 0.99.2 devDependency was not used as the router's validation oracle.

- coding-agent `dist/core/agent-session.js:434-488`: builds projection, awaits virtual `resolveModel`, appends returned JSON state, optionally auto-compacts, then returns physical model/context.
- agent-core `dist/agent-loop.js:123-140`: awaits prepareRequest/routing before streamAssistantResponse.
- agent-core `dist/agent-loop.js:260-268`: then awaits transformContext before provider conversion/streaming.
- coding-agent `dist/core/sdk.js:278-282`: transformContext invokes extension runner.emitContext.
- coding-agent `dist/core/agent-session.js:1385-1403`: native retries and before-settle continuations use agent.continue, therefore the same request ordering. They do **not** run before_agent_start.

The adapter registers native virtual models, never uses setModel, and returns native registry models/thinking levels. Host smoke asserts logical selection remains `route/worker` while responses carry physical provider/model and usage.

## Safe terminal cleanup

`agent-session.js:616-633` requires runnable non-assistant projected context (or queued work) for boundary continuation. Public BoundaryResult supports `context_edit` with `replacement:null` (`extensions/types.d.ts:740-754`). Commit refreshes agent context (`agent-session.js:636-640`), enabling continuation from the existing user/tool result after omitting only an empty failed assistant. Raw history remains. Native `_prepareRetry` uses the same omission concept (`agent-session.js:3028-3062`).

The adapter refuses aborts, partial text/thinking, tool/deferred content, malformed/context errors and unknown non-provider failures; it refuses recovery while queued work exists. Native tests exercise a completed tool followed by quota failure and fallback, with exactly one tool execution and its existing result retained. Native retry scheduling is unchanged. Provider exhaustion, zero transition budget and recovery limits settle without a loop.

## Owner-approved v0.1 compatibility rule

Routing sees canonical projection **before** Magic Context/other extension transformations. Final effective messages do not exist at route time. Late context/provider hooks swallow exceptions (`extensions/runner.js:1052-1060`, `1081+`), so a throwing guard there cannot reliably prevent dispatch. There is no public re-route-after-transform return field.

Owner explicitly approved proceeding **without a host patch**: use conservative canonical/latest-successful-usage estimates plus output reserve and initial logical capacity. Superseded revision: the original v0.1 rule persisted a non-decreasing capacity floor at least as large as each dispatched physical window and rejected smaller-window automatic fallback. Live testing showed that floor prevented failover entirely whenever a route's first candidate had the largest window, and that it leaked another route's window into a route being switched to. The floor is removed: candidates must now honour the route's configured capacity and fit this request, and no capacity is carried across a model switch. Reserve uses the greater of configured reserve and candidate maximum output. This is capacity preservation, **not a hard final-token guarantee**. Design/spec/README record the approved limitation. A late-preparation/re-route seam is deferred.

## Flush proof and its limits

The native host tests use actual Pi AgentSession/ModelRuntime and deterministic fake providers. The peer fixture mirrors the public protocol: flush sets a pending flag and emits success; the real Pi context pass consumes it and changes messages. The replacement fake provider actually receives those changed messages. Assertions cover native retry and terminal continuation, exactly one successful transition flush, unrelated-session filtering, failed/missing bridge, timeout and abort. Initial/same/direct dispatches do not flush. Extra waitUntil subscribers gate dispatch under the same timeout/abort boundary.

Complementary **actual Magic Context** evidence was supplied by the owner and inspected in `../magic-context/packages/pi-plugin/src/context-handler.test.ts:2419-2497`, test `registerPiContextHandler > applies executeCtxFlush changes in the next real context pass`. It calls production executeCtxFlush with a real pending drop/new compartment, then invokes the registered real context handler at 0% usage with actual M0/M1 injection. Assertions prove the next context removes the drop, injects new history and drains history/materialization flags. System-prompt refresh remains set until before_agent_start. This worker inspected the test and reused owner-supplied peer results: `bun test packages/pi-plugin/src/context-handler.test.ts` **154 pass, 0 fail, 619 expectations**; `bun run typecheck` exit 0; `bun run --cwd packages/pi-plugin biome check src/context-handler.test.ts src/ctx-lifecycle-events.ts src/commands/ctx-flush.ts` clean. These commands ran in the Magic Context repo, not here. The peer owns changes to those three external files; this worker did not edit them.

These are complementary layer checks, **not a full deployed-plugin smoke**. Flush-result itself is signaling, not materialization-completion proof. Pending drop/history transformations can reach the imminent context pass; disk/system adjunct reread is explicitly next-turn behavior, not promised on retry/continuation. Same-session results from an unrelated concurrent flush emitter remain ambiguous because the protocol has no correlation ID.

## Worker launch compatibility

Virtual registration does not populate `getRegisteredProviderIds()`. Herdsman's launcher therefore previously added `--no-extensions` for an inherited `route/worker`, making child resolution impossible. The narrow fix recognizes the **requested virtual model** in registry.getAll and includes its provider in the existing discovery decision. It does not enable discovery for an unrelated physical selection merely because that provider also has another virtual model. Real delegation tests cover both cases, with exact emitted launch arguments.

Package-entry smoke loads `src/index.ts` through Pi's actual extension loader/settings path and drives equivalent parent/worker requests through the adapter. Actual deployed wrapper/bundle inclusion is still deployment-owner work. Workers need the router and full Magic Context entry; the lean MC subagent entry does not wire the flush bridge.

## Validation commands / outcomes

- `bun install`: passed; added pinned Pi 1.1.0 validation dependencies. Lock regeneration also reconciles already-stale workspace metadata (removed pi-subagents, existing pi-reqcap/pi-jev metadata); existing Herdsman stays pinned to 0.99.2. No other manifests changed by this worker.
- `bun install --frozen-lockfile`: passed.
- `cd pi-native-router && bun run typecheck`: passed against Pi 1.1.0, production and tests.
- `cd pi-native-router && bun test tests`: **25 pass, 0 fail**, 82 assertions, 3 files. Includes native-provider recovery/flush smoke, package loading, restored JSON branch/fork, durable compaction projection, catalog-limit changes, smaller-candidate exclusion, cooldown expiry/hints and direct isolation.
- `cd pi-native-router && npm pack --dry-run`: passed; includes README, manifest and all four production source files, no test/dev scaffolding in tarball.
- `cd pi-herdsman && node --experimental-test-module-mocks --import=./scripts/test-env.mjs --test --test-timeout=10000 --test-name-pattern='parent delegates two same-definition children' extension/controller-lifecycle.test.ts`: **2 pass, 0 fail**, rerun after the final precise-discovery edit.
- `cd pi-herdsman && node --experimental-test-module-mocks --import=./scripts/test-env.mjs --test --test-timeout=10000 extension/controller-lifecycle.test.ts extension/agent-definitions.test.ts`: **139 pass, 0 fail, 1 platform skip** before the final narrowing from provider-wide to requested-model-only virtual detection; focused delegation cases above reverified the final edit.
- `openspec validate pi-native-router --strict`: passed. Initially warned on long compatibility requirement; split it into a separate scenario-backed requirement and revalidated.
- `git diff --check`: passed (read-only VCS inspection).

### Broad checks are not wholly green

- Root `bun run test`: bash-processes **387 pass**, tool-renderer **187 pass**, then pi-otel **348 pass, 19 fail, 1 skip**. Inherited TRACEPARENT affects four trace-root assertions; rerunning root as `env -u TRACEPARENT bun run test` yields pi-otel **352 pass, 15 fail, 1 skip**, remaining failures concern logs/default configuration/logger construction. Telemetry source/dependencies were not edited; causality of the remaining environment/configuration failures has not been established. Do not claim the workspace suite passed.
- Remaining packages explicitly run via `for p in pi-jev pi-native-router pi-cbmem pi-output-policy pi-reqcap; do echo "== $p"; (cd "$p" && bun run test) || exit 1; done`: passed (**204**, **22** before last budget test, **20**, **42**, **22** respectively). Final router count is 25 as above.
- `cd pi-herdsman && bun run check`: **1119 pass, 4 fail, 1 skip** out of 1124. Failures are agent-runtime background-work assertions at lines 398/583/681/877 (advisory task holds settlement; missing result status). These four were reproduced with this worker's virtual-discovery change temporarily removed: same **4 fail**. The changed file was restored byte-identically. No out-of-scope background-work fixes attempted.

## External gates and handoff

Tasks 3.2/4.2 are closed for the owner-accepted **scoped pending-transform claim** using complementary actual-MC handler and native-host ordering/provider-visible checks. Full single-process deployed-plugin/credentials smoke has not been run and is not implied by those checks. Peer completed the **Pi-only** idle-TTL override preserving shared OpenCode TTL settings and the **200000** pressure threshold; task 3.3 is verified by the external tests and independently inspected built configuration below. No paid routes activated. README provides required native compaction-off and full-entry worker loading instructions.

## Decisions to record (owner lands durable why)

1. Approved conservative v0.1 capacity floor rather than shrinking models or patching host late preparation: route precedes final context; revisit when a supported late preparation/re-route API exists. Revisited during live verification: the persisted floor was removed in favour of route-declared capacity plus this request's fit, because it blocked failover and leaked across routes.
2. User-only extension-manager configuration rather than project override: project checkouts must not silently redirect paid requests. Revisit with an independently reusable trusted-project settings surface.
3. Pending drop/history flush visibility is separated from next-turn system adjunct refresh; no synthetic user message or manual before_agent_start is injected to force adjunct rereads on retries.

Deferred: correlated flush protocol, late final-effective-context selection, finer account scopes/shared health, and deployment activation. Existing non-green broad tests are reported to their owners, not absorbed into this slice.

## Telemetry failure provenance — isolated lock/config comparison

One completed controlled experiment, run with `python3 /tmp/pi-native-router-telemetry-provenance.py`; script, four complete test logs, install logs and `results.json` are retained under `/tmp/pi-otel-lock-baseline-a_o_3_xq/` (script itself is at the command path). No shared-tree baseline swaps, telemetry source fixes, external settings edits or VCS mutations occurred.

Baseline revision: `cefd46a87bf6318bfdd21f807ee35b21b4010228`. Both lanes use identical archived HEAD `pi-otel` sources/tests; `git status`/diff confirmed telemetry has no workspace changes. Old lane uses HEAD's original lock (SHA256 `f175eca269964c5f719b76ef6511856b448027fdc0e236dd9039c4a63140b39c`); new lane uses the current lock (SHA256 `70565c93b2c7d31eea9d4131d318a248de9a66320fd74735b95c3dab6432797d`). The diff changes **no OpenTelemetry package entries**.

Setup caveat: HEAD's root manifest still names removed `pi-subagents`, whose manifest is absent at HEAD. Initial setup therefore failed before tests; attempts with other source workspace manifests also found stale metadata and an unrelated install hook. The completed experiment reconstructs **dependency-only workspace manifests from each lock's own metadata**, retaining original `pi-otel` source/manifest, and installs each graph with `bun install --frozen-lockfile --ignore-scripts`. Both installs exit 0 and both lock byte sequences remain unchanged. Installation hooks are disabled to avoid unrelated workspace/global setup, not telemetry behavior. This compares faithfully locked dependency graphs, not historical non-telemetry workspace build scripts.

All `OTEL_*`, `PI_OTEL_*`, `JITI_*`, TRACEPARENT/TRACESTATE, NODE_PATH and NODE_OPTIONS variables are removed for every lane. Node is v24.21.0; Bun is 1.4.2. Each case executes `bun run test` from its isolated `pi-otel` directory:

| Locked graph | HOME | Tests | Pass | Fail | Skip | Exit |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Original | existing user HOME | 368 | 349 | 18 | 1 | 1 |
| Current | existing user HOME | 368 | 349 | 18 | 1 | 1 |
| Original | empty temporary HOME | 368 | 364 | 3 | 1 | 1 |
| Current | empty temporary HOME | 368 | 364 | 3 | 1 | 1 |

Normalized failing test names match **exactly** between old/new locks for each HOME mode. Exactly **15** inherited-HOME failures disappear with the clean HOME under **both** locks. Read-only inspection of the user settings confirms `otel.logs:false`, `otel.traces:true`, `otel.metrics:true` and a non-default endpoint override; no secrets/endpoint value are recorded. `pi-otel/src/config.ts:344-347,452-454` reads `homedir()/.pi/agent/settings.json` and applies these settings. Tests erase environment overrides but do not isolate that settings file; for example `test/sdk.test.ts:85-95` calls `resolveConfig("/test")` and expects a logger provider even though the user configuration disables logs.

Concrete configuration-dependent signatures: `logger provider present`, `logs exported`, `logs still on`, missing `pi.session.end` log, `log record accepted` (0 versus 1), logs-export count 0, plus default-endpoint/default-enabled assertions. These are the previously reported remaining fifteen failures, not a regression attributable to the new lock.

The three failures remaining in **both clean isolated graphs** are separate dependency-resolution evidence: `grpc protocol with headers constructs exporters without errors`, `converts plain headers into grpc Metadata`, and `empty headers yield empty metadata`. All report `Cannot find module '@grpc/grpc-js'` from `pi-otel/src/sdk.ts`; the live workspace's historical node_modules had resolved these cases. The clean graph reveals this existing direct/transitive module-resolution issue, but it is identical under both locks. No package/configuration fixes are authorized or made here.

**Conclusion:** The new lock changes do **not** cause the observed fifteen telemetry failures. Their configuration provenance is established by the old/new × inherited/clean HOME comparison. This is not a claim that clean telemetry installation is wholly green: the common three gRPC-resolution failures remain a separate follow-up.

## Corrective slice — review P1 native HTTP status formatting

Review evidence: `result:router-review#1`. Owner authorized fixing this finding after the bounded telemetry experiment; no broader router re-review or telemetry production fixes were undertaken.

Pi 1.1.0 `@earendil-works/pi-ai/utils/error-body` exposes production normalizeProviderError/formatProviderError. Native provider handlers use these helpers (openai-completions, Codex responses, OpenAI responses and others). Error strings can be `403 status code (no body)`, `<status>: <body>`, or `<provider> API error (<status>): <message/body>`, not only entire JSON documents. The classifier previously recognized auth/rate HTTP statuses only in JSON, incorrectly treating native 401/403/429 as unsafe.

`src/policy.ts` now extracts status from the anchored known native formats in addition to JSON. It does not treat arbitrary mentions of numeric codes as HTTP status. Abort/partial-output guards and malformed/context-overflow checks still run before status classification. 401/403 retain provider-scoped auth cooldown; 429 retains model-scoped rate cooldown by default. No retry scheduler, transport, configuration, state format or recovery-budget changes were made.

New `tests/native-error.ts` uses the **actual native normalization/formatting functions** to supply both policy and real AgentSession/ModelRuntime regressions. Classification tests cover opaque no-body, status/body and provider-prefixed strings; misleading numeric mentions, HTTP400, context/malformed errors, abort and partial work remain unsafe. Host tests prove native-formatted 401/403 terminal recovery and 429 native retry select the fallback, flush exactly once, deliver changed request context and retain stickiness. Public auto_retry_start events prove 429 uses the native retry path (one retry), while 401/403 tests use the pre-settlement path (zero native retries).

Red/green commands:

- Before production fix: `cd pi-native-router && bun test tests/policy.test.ts tests/host.test.ts -t 'native HTTP'` → **0 pass, 4 fail**, reproducing all three missing fallback dispatches and unsafe auth classification.
- After production fix, final rerun: `cd pi-native-router && bun run typecheck && bun test tests` → typecheck exit 0; **29 pass, 0 fail, 113 assertions**, 3 test files. This supersedes the initial 25-test count above.
- Final `openspec validate pi-native-router --strict` and `git diff --check` → exit 0, valid change and clean diff formatting.

Changed paths for this follow-up: `pi-native-router/src/policy.ts`, `pi-native-router/tests/{policy.test.ts,host.test.ts,native-error.ts}` and this evidence artifact. Telemetry provenance scripts/data exist only under `/tmp`; no Herdsman, telemetry source, lock or external configuration edits were made in this follow-up.


## External Pi-only TTL implementation

Magic Context owner delivered the source/config slice separately from this repository:

- `packages/plugin/src/config/schema/magic-context.ts` and `packages/plugin/src/config/project-security.ts`: user-only `pi.cache_ttl` schema; project override rejected.
- `packages/pi-plugin/src/config/index.ts` and `packages/pi-plugin/src/index.ts`: Pi consumes its override; OMP/OpenCode retain root TTL policy.
- `~/.dotfiles/nix/modules/agents/magic-context.nix`: `pi.cache_ttl = "never"`.

Peer-reported validation: Pi config **43/43**, project security **4/4**, scheduler **13/13**, Pi context **154/154**, schema synchronization **3/3**; typecheck and lint pass. `bun run build:dists` passes with `dists LOAD OK`; strict OpenSpec validation passes in that repository. Scheduler evidence covers idle suppression with `never` while pressure execution remains enabled.

Built, **not activated**, Home Manager JSON: `/nix/store/48ipddg0pvaf489syfzi0wl4d6ypcd8k-magic-context.json`. Parent independently parsed and asserted:

- `pi.cache_ttl`: `never`.
- Root `cache_ttl`: `{default: "30m", "openai-codex/*": "10m", "anthropic/*": "60m"}` (unchanged).
- `execute_threshold_tokens.default`: `200000`.

External packaging gate resolved locally: peer's final `nix build .#pi-magic-context --no-link --print-out-paths` passes, producing `/nix/store/zgspm09kamh31709z7nwh54b699f9822-pi-magic-context-0.46.1`. The earlier `Script not found "build"` failure came from using Bun2Nix's CLI instead of its install hook and running the root build script from the `nix` bunRoot. Peer corrected hook/build/install wiring and regenerated `nix/bun.nix` from the staged lock without changing package records/hashes. Peer verified manifest `main = dist/index.js`, expected Pi entries and Node syntax checks. This is package-build evidence, not activation or live Pi-load evidence. No live idle-TTL change, paid route activation or single-process deployed-plugin smoke is claimed.

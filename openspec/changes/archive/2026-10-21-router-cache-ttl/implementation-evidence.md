# Implementation evidence

## Delivered behavior

- `cacheTtlMs` is an optional positive safe integer per physical candidate. Omission preserves existing routing. README documents estimated semantics and a user-config example; no provider TTL is asserted.
- Successful final assistant `message_end` events on the selected physical route persist a dedicated cache-activity custom entry through Pi's public `pi.appendEntry(customType, data)` API (verified against the pinned Pi 1.1.0 `core/extensions/types.d.ts:1248` and `core/agent-session.js:2721-2727`). Errors, aborts and direct requests do not update session activity. Tool-use assistant responses count as successful activity.
- Activity facts carry logical role, physical identity and timestamp; expiry acknowledgment appends the consumed timestamp. Branch reads reconcile the latest matching cache fact with branch route state, while the request's current virtual state is refreshed from that fact. This keeps resume/fork persistence and same-process retries aligned. Legacy state has no activity fact and therefore does not flush initially.
- TTL expiry is checked at `now >= activity.at + TTL`; clock rollback (`now < activity.at`) does not expire. A successful flush consumes only that activity epoch. A later successful response creates a new epoch.
- Same-model expiry invokes the native Magic Context bridge directly under its timeout/abort contract and emits only `native-router:estimated-cache-invalidation`; it does not invoke transition-only custom hooks, emit before-transition/transition, or increment physical transition counters. Simultaneous switch/expiry reuses the actual transition flush and preserves existing transition waitUntil consumers.
- The existing scoped flush claim remains unchanged: acknowledged flush materializes pending drop/history transformations in the imminent real context pass; it does not imply compression or same-turn disk-backed system-adjunct refresh.

## Targeted evidence

- Pi 1.1.0 typecheck: `cd pi-native-router && bun run typecheck` — passed.
- Native Pi AgentSession/ModelRuntime tests: `cd pi-native-router && bun test tests` — **35 pass, 0 fail, 142 assertions**, with fake providers asserting provider-visible materialized context, same-model stickiness, single flush, transition/expiry observation distinction, failure/no-consumption, retry/failure activity isolation, direct isolation, restore/fork of expired and consumed epochs, exact TTL threshold and clock rollback.
- Package contents: `cd pi-native-router && npm pack --dry-run` — passed; package includes README, manifest and four runtime source files.
- OpenSpec: `openspec validate router-cache-ttl --strict` — passed.
- Formatting: `git diff --check` — passed.

## Limits

No deployment activation, provider cache guarantee, timer/warming behavior, cross-process cache coordination or external Magic Context changes are claimed. TTL is an estimate and branch-local activity metadata can be copied by fork as ordinary branch state; it does not prove a provider shares a cache across processes. Failure/abort before a successful final response does not refresh activity. No new dependency or host patch was introduced.


## Independent review

Fresh-context review (`result:cache-ttl-review#1`) found no concrete defect. Reviewer independently ran Pi 1.1.0 typecheck and the full router suite: **35 pass, 0 fail, 142 assertions**. Review included the public `message_end`/`appendEntry` lifecycle, durable success/consumption facts, restored branch behavior, sticky same-model expiry, switch/expiry composition and failed-handshake safety. This is local implementation verification, not live activation.

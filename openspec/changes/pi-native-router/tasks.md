# Tasks

## 1. Native package and routing policy

- [x] 1.1 Establish matching Pi virtual-model and settlement contracts from real source/docs; record exact context/route ordering and safe recovery constraints in a short implementation evidence artifact.
- [x] 1.2 Add independently installable pi-native-router package, validated logical-route configuration and native model resolution; verify package loading and reject invalid configuration with focused tests.
- [x] 1.3 Implement sticky JSON branch state, deterministic isolated direct requests and context-compatible candidate selection; test normal turns, continuation, restore/fork, config changes and exhausted candidates, and document configuration.

## 2. Reliability and continuation

- [x] 2.1 Implement conservative failure classification and bounded local model/provider cooldowns with structured retry/reset hints where available; test scope isolation and expiry using controlled time.
- [x] 2.2 Implement native retry stay/advance policy and bounded safe terminal recovery at agent_before_settle; test terminal quota failover, transient migration, successful replacement stickiness, partial-output refusal, aborts and exhaustion without loops or tool replay, and document limits.

## 3. Physical transition integration

- [x] 3.1 Add replaceable awaitable transition seam and observation records; verify initial/same/direct dispatches do not trigger a session transition.
- [x] 3.2 Await the existing Magic Context flush bridge before replacement dispatch with session filtering, bounded timeout and failure behavior; test once-only transitions and real context ordering, documenting any host contract limitation.
- [x] 3.3 Coordinate Magic Context idle-TTL disablement through its owning configuration while retaining 200k pressure behavior; verify effective config or record a precise external deployment blocker rather than marking incomplete work done.

## 4. Integration verification

- [x] 4.1 Register workspace/test discovery and verify parent/Herdsman worker route launch compatibility through the actual native adapter; limit any Herdsman edits to proven required compatibility.
- [x] 4.2 Run package typecheck/tests and a faithful native-host recovery/flush smoke with deterministic fake providers; record commands, outcomes and remaining deployment gaps.
- [x] 4.3 Validate OpenSpec artifacts and review the implementation against every requirement; fix findings and update task evidence before reporting completion.

## Evidence and remaining integration gates

Local slice: 29 router tests + Pi 1.1.0 typecheck pass; package dry-run and frozen lock install pass. Real Herdsman launch/controller + agent-definition suites: 139 pass, 1 platform skip. OpenSpec strict validation passes. See implementation-evidence.md for commands, broad-suite failures and owner-approved v0.1 capacity-floor rule.

- **3.2 verified with complementary checks:** real Pi host ordering/provider-visible pending-flag materialization smoke plus peer-owned real executeCtxFlush/runPipeline test (154 pass, 0 fail in context-handler.test.ts). These establish the scoped pending drop/history claim, not a single deployed-plugin end-to-end test. System adjunct refresh waits for the next before_agent_start, not native retry/settlement continuation.
- **3.3 verified externally:** Magic Context's Pi-only `pi.cache_ttl = "never"` override is implemented and tested. Built Home Manager config independently verifies the override, unchanged shared TTL map and 200000 pressure threshold. The separate Nix package build now passes; its artifact and checks are recorded in implementation-evidence.md. No activation or live Pi-load smoke performed.
- **4.2 verified locally:** native fake-provider retry/recovery/transition smoke, current Pi typecheck and complementary actual-MC handler evidence pass. No live deployment/credentials were activated.
- **4.3 verified:** review found one native HTTP-status classification defect, now fixed with regressions. Broad workspace checks are not wholly green: telemetry failures reproduce under both lock graphs; four Herdsman background-work failures reproduce without the compatibility change. Those are reported, not silently fixed outside scope. Deployment activation and a single-process deployed-plugin smoke remain separate release gates.

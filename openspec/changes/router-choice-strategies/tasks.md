# Tasks

## 1. Public contract and module configuration

- [x] 1.1 Add the version-1 public strategy/context/choice types and `strategy` type export; verify a standalone TS module imports them without router internals and typechecks with the package.
- [x] 1.2 Parse optional per-route absolute local module paths and JSON-object options; verify existing configurations are unchanged and malformed strategy settings are rejected in configuration tests.
- [x] 1.3 Use the host's native TypeScript loader with load/version/export validation and process-lifetime cache; verify a real temporary `.ts` module loads under Bun and missing/unsupported modules fall back for only affected routes. Document trusted-code privileges, no sandbox/interruptible timeout, source-edit process-restart requirement and config reload behavior beside examples.

## 2. Prepared routing snapshots

- [x] 2.1 Build copied, deeply readonly/frozen JSON-compatible snapshots with account-expanded identities, eligibility/rejection reasons, current/pin/recovery state, estimates/provenance, effective thinking and budgets; verify two accounts remain distinct and no prompts, host references or credential declarations enter the public snapshot.
- [x] 2.2 Project existing cached quota observations with every window, refresh outcome, timestamps, authority and freshness; verify fresh, stale and unavailable data remain distinguishable and constructing a snapshot never invokes the tracker.
- [x] 2.3 Project native/catalog pricing, supported tiers, peak state and known account/model cache evidence; verify known-zero versus missing prices, incomplete switching-cost evidence and already-peak-priced Command Code do not become fabricated zero costs or double-adjusted rates. Document units, uncertainty and subscription-cost limitations with the public types.

## 3. Selection and dispatch integration

- [x] 3.1 Add choice evaluation and ordered/sticky fallback over the same eligible set; verify a custom choice can displace a healthy incumbent, invalid/ineligible IDs and throws fall back, promises are rejected safely, and an empty set uses exhaustion without invocation.
- [x] 3.2 Integrate the evaluator into session and direct dispatch while retaining recovery and admitted transient-retry precedence; treat a fresh user pin as a one-shot override and persistent pins as automatic-selection context; extend the host harness to verify the actual dispatched model/account, direct-call restrictions and unsafe partial-output refusal rather than testing a disconnected helper.
- [x] 3.3 Integrate admission-retry exclusions and remaining transition budgets; verify a denied lease cannot cause repeated selection of the same target, and a custom switch cannot bypass the awaited flush or verified activation. Reuse existing recovery/activation tests where they already prove unchanged behavior.

## 4. Preview, operator evidence and policy example

- [x] 4.1 Route footer preview and pin-to-auto normalization through the same snapshot/evaluator without admissions or state mutations; verify a strategy-selected preview target, redundant-pin clear and configured-order cycling through the real handlers.
- [x] 4.2 Extend decision records with strategy/origin/explanation, fallback category and observation times; verify a strategy-driven transition and a strategy failure are explainable without raw errors, secrets, options or full snapshot dumps. Reuse existing TUI transition notices and bound/deduplicate fallback warnings.
- [x] 4.3 Ship a packaged, typechecked sample TS strategy for peak avoidance and near-reset quota preference; document explicit rule ordering, thresholds, all-window constraints and incumbent ties. Verify a small deterministic set of cases: peak/off-peak, fresh near-reset allowance, stale/unknown quota and a conflicting exhausted window; do not add a generic scoring framework.
- [x] 4.4 Update README configuration/rollback and the default-only no-ranking guarantee; reconcile pending `physical-pin` auto/dormant route-order language with opt-in strategy behavior. Verify docs and change artifacts consistently distinguish default selection from custom preference and do not claim a deployed smoke.

## 5. Integration validation

- [x] 5.1 Run router typecheck and its existing suite plus the focused strategy coverage; record results and any unrelated baseline failures without marking incomplete behavior done.
- [x] 5.2 Validate this OpenSpec change strictly and check the packaged module/type/example paths using the documented configuration; record host-runtime or live-provider gaps separately. No real paid requests are required to establish the choice contract.

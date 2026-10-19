# Spec Delta

## Purpose

Allow operators to customize automatic physical-target selection using a synchronous TypeScript strategy over a prepared routing snapshot, without replacing native dispatch or weakening safety and recovery behavior.

## ADDED Requirements

### Requirement: Strategies are opt-in per route

A route SHALL use ordered, sticky selection when no strategy is configured. An operator MAY configure a trusted local TypeScript module and JSON-compatible options per route. The router SHALL load the module outside per-request selection, validate its supported contract version and synchronous choice function, and require an explicit reload/restart to adopt module edits. Removing the setting SHALL restore default selection without rewriting branch state.

#### Scenario: Existing configuration
- **WHEN** a route has no strategy setting
- **THEN** configured candidate order and existing stickiness determine automatic selection without quota-headroom ranking

#### Scenario: Local strategy module
- **WHEN** a supported module is configured for one route
- **THEN** only that route uses its choice function with the configured options

### Requirement: Choice receives a complete secret-free snapshot

The strategy SHALL receive a versioned, immutable, JSON-compatible snapshot of route/options, target identities/order, eligibility/rejections, current/pin/recovery state, request estimates/provenance, resolved thinking, bounded failures/exclusions, remaining budgets, explicit time, and available quota/pricing/peak/cache observations. Identical snapshots SHALL produce identical choices.

#### Scenario: Multiple accounts for one model
- **WHEN** two accounts serve the same physical model
- **THEN** the snapshot distinguishes their target IDs, quota observations and account-scoped cache evidence

#### Scenario: Preview invocation
- **WHEN** the router invokes a strategy to preview a route
- **THEN** the snapshot identifies preview mode and the invocation does not reserve a probe, switch credentials, flush context or persist a dispatch

### Requirement: Strategy input excludes privileged data and operations

The snapshot SHALL exclude raw messages, credentials, credential paths/environment references, host objects, store handles and mutation capabilities. Strategies SHALL NOT fetch data or perform dispatch. These are trusted-code interface restrictions, not a sandbox.

#### Scenario: Account key source
- **WHEN** a configured account uses a decrypted key file
- **THEN** the snapshot includes account identity but not the key or its source path

### Requirement: Unknown observations remain explicit

Quota observations SHALL retain all reported windows, timestamps, source, authority and freshness. Pricing SHALL distinguish known zero, unknown and partial rates, units, provenance and supported tier/peak information. Cache warmth and switching-cost estimates SHALL state evidence and uncertainty; absent evidence SHALL remain unknown. Selection SHALL NOT await quota or catalog refreshes.

#### Scenario: Missing quota reading
- **WHEN** the tracker has no fresh authoritative account reading
- **THEN** the snapshot exposes the missing/stale/non-authoritative status rather than inventing available quota

#### Scenario: Peak-priced candidate
- **WHEN** existing pricing logic recognizes a DeepSeek peak period
- **THEN** the snapshot exposes peak state independently of price availability and does not double rates already adjusted by the provider

#### Scenario: Insufficient switching-cost evidence
- **WHEN** the router cannot estimate the price of rebuilding a target's cache
- **THEN** the cost is unknown rather than zero and any known account/model cache activity remains available

### Requirement: A strategy chooses only an eligible target

A successful strategy result SHALL identify exactly one supplied eligible target and a nonempty bounded explanation. The router SHALL reject unknown IDs, ineligible IDs, malformed results and asynchronous results. An empty eligible set SHALL retain the existing exhaustion path without invoking the strategy. A custom strategy SHALL own automatic stickiness and MAY choose a different eligible target even when the previous target remains healthy.

#### Scenario: Deliberate peak avoidance
- **WHEN** the current target is healthy but a strategy chooses another eligible target to avoid peak pricing
- **THEN** normal automatic stickiness does not override that choice

#### Scenario: Unregistered choice
- **WHEN** a strategy returns an ID outside the eligible set
- **THEN** the router does not dispatch it and uses compatibility fallback with an explanatory diagnostic

### Requirement: Estimates are not verified spend

Quoted model rates SHALL NOT be labelled verified spend or converted into a subscription's marginal charge.

#### Scenario: Subscription model list price
- **WHEN** a subscribed model has known USD-per-token list rates
- **THEN** those rates remain labelled price estimates rather than a verified additional cash charge

### Requirement: Router safety and explicit preferences precede strategies

Bounded same-target transient retries and explicit recovery targets SHALL retain precedence over automatic strategies. A manual pin SHALL be included in the strategy context as a preference; it SHALL NOT displace an eligible current target under ordered selection or bypass eligibility. A custom strategy MAY choose another eligible target using the supplied pin, current-target and request context. Strategies SHALL NOT bypass authentication, context fit, quota/health blocks, probe leases, activation verification, retry replay safety, transition budgets or awaited Magic Context flushes.

#### Scenario: Current target and pin under ordered selection
- **WHEN** an eligible current target differs from the pin and no custom strategy is configured
- **THEN** ordered selection keeps the current target sticky
- **AND** the pin remains preferred over configured order if the current target becomes ineligible

#### Scenario: Custom strategy receives pin
- **WHEN** an eligible pin and current target are supplied to a custom strategy
- **THEN** the strategy chooses among eligible targets using the pin as context, without the router bypassing its selection

#### Scenario: Dormant pin
- **WHEN** a pin is ineligible
- **THEN** the strategy may select another eligible target without clearing the pin

#### Scenario: Partial output
- **WHEN** a failure is unsafe to replay
- **THEN** health observation may occur but no strategy is used to migrate and replay the request

#### Scenario: Strategy requests a transition
- **WHEN** a valid strategy choice changes the physical target or account
- **THEN** dispatch waits for the existing transition flush and verified activation, and respects transition limits

### Requirement: Direct calls retain credential and session isolation

Direct calls SHALL preserve their existing active-credential restrictions and SHALL NOT acquire session-only pin, cache or persistence semantics.

#### Scenario: Inactive account on a direct call
- **WHEN** a configured account cannot be used under the existing active-credential restriction
- **THEN** that target is not selectable by the direct-call strategy and no session pin or cache state is mutated

### Requirement: Reselection is bounded and keeps exclusions

When a selected target cannot be admitted or fails and routing permits another attempt, the router SHALL update eligibility and failure context before reselecting. A strategy SHALL NOT repeatedly select a refused/excluded target within that selection attempt. Genuine retries and failovers SHALL retain existing budgets and safety checks.

#### Scenario: Probe lease denied
- **WHEN** another process holds the selected target's recovery lease
- **THEN** the next choice sees that target excluded and cannot loop indefinitely on it

#### Scenario: Eligible alternatives exhausted
- **WHEN** every target has been rejected or excluded
- **THEN** the router reports exhaustion rather than repeatedly invoking the strategy

### Requirement: Strategy failure falls back observably

If loading, contract validation or execution fails, the router SHALL use ordered/sticky selection over the same remaining eligible set and retain all safeguards. Diagnostics SHALL distinguish strategy failure from provider failure, avoid writing provider cooldowns for strategy errors, and be bounded and secret-free. An unsupported async result SHALL be handled as a strategy failure, not awaited as dispatch work.

#### Scenario: Module throws
- **WHEN** the choice function throws
- **THEN** the router uses default selection and reports a strategy execution failure without exposing arbitrary exception text

### Requirement: Preview and dispatch share selection semantics

Route preview and dispatch SHALL use the same choice contract and precedence rules. Preview SHALL remain tentative because time, observations and admissions can change. Manual cycling SHALL retain configured eligible order rather than a potentially changing strategy order. Clearing a redundant pin SHALL compare against the automatic choice that the configured strategy would make for the same preview snapshot without the pin.

#### Scenario: Pin matches automatic strategy choice
- **WHEN** the operator pins the target already selected by automatic strategy preview
- **THEN** the pin is normalized to auto without changing the previewed target

### Requirement: Operators can explain a choice

Physical selection changes and strategy fallbacks SHALL report the strategy identifier, selection origin, bounded explanation and relevant non-secret observation timestamps alongside existing decision identity fields. Strategy-triggered transitions SHALL use existing TUI transition notices. Repeated unchanged successful choices SHALL NOT require per-request UI notifications or full snapshot logging.

#### Scenario: Choice due to expiring quota
- **WHEN** a strategy moves to a different account because of an expiring quota window
- **THEN** the decision log identifies the account, strategy and explanation with the quota observation time without logging keys, prompts or raw tracker output

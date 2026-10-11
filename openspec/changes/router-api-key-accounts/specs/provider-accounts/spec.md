# Spec Delta

## Purpose

Select named API-key accounts without compromising native provider execution, credential isolation or the router's persistent cache-conscious lifecycle.

## ADDED Requirements

### Requirement: Named accounts are trusted key references

The router SHALL accept user-owned named API-key accounts bound to one provider and one secret reference. It SHALL treat each configured key as one account, reject unknown or mismatched account references, and exclude account configuration from project settings.

#### Scenario: Two accounts serve the same model
- **WHEN** a route lists the same provider/model with two distinct valid accounts
- **THEN** both targets are accepted in configured order
- **AND** repeating the same provider/model/account target is rejected

#### Scenario: A project attempts to supply a key account
- **WHEN** project settings define or override a named account
- **THEN** those settings cannot affect credential selection

### Requirement: Account activation follows the Pi runtime key pattern

For each provider, the router SHALL activate the selected named API key through Pi's runtime credential operation before dispatch and verify the effective key without exposing it. Activation SHALL be serialized and fail closed when the runtime credential surface is unavailable or activation cannot be verified. It SHALL preserve the registered native provider, model catalog, API selection, streaming, reasoning and usage accounting.

#### Scenario: Sequential account fallback
- **WHEN** a request at a safe Pi request boundary selects account B after account A
- **THEN** the runtime activates and verifies B's key before native provider preparation
- **AND** the selected native provider implementation handles the request

#### Scenario: Runtime credential operation is unavailable
- **WHEN** a named account is selected on a host without the Pi runtime key operation
- **THEN** dispatch fails before provider execution with an actionable compatibility error
- **AND** routes using only the provider's native default auth remain usable

### Requirement: One active credential exists per provider and Pi runtime

Named-account activation changes provider-wide runtime auth, not a request-local credential. All requests in one Pi runtime that use a provider SHALL observe its currently active key. The router SHALL NOT claim isolation between overlapping requests or auxiliary calls; operators SHALL configure at most one concurrent active account per provider in a Pi runtime.

#### Scenario: Concurrent calls share the runtime account
- **WHEN** a named-account change overlaps another call using the same provider in the same Pi runtime
- **THEN** the limitation is documented and account routing does not claim per-request isolation
- **AND** the router does not swap keys while an owned routed request is still in flight

#### Scenario: Native Go behavior is preserved
- **WHEN** a named account dispatches a Go model
- **THEN** native API selection, model metadata and session headers remain present
- **AND** no router-owned proxy or replacement streaming transport executes it

### Requirement: Account selection is sticky and branch-resident

Successful selection SHALL persist provider/model/account identity across user turns, continuations, restore and fork. A successful fallback SHALL remain sticky. Removing a configured account SHALL make its stored target ineligible without resetting recovery or context-capacity safeguards.

#### Scenario: Restoring a fallback account
- **WHEN** a session resumes after successful fallback to account B
- **THEN** its next session request uses B while eligible instead of returning to A

#### Scenario: Legacy branch has no explicit account
- **WHEN** an existing branch stores only its provider/model identity
- **THEN** it is interpreted as native default auth for that provider
- **AND** no arbitrary named account is substituted for that default

### Requirement: Account changes are cache boundaries

A session account change SHALL await one Magic Context pending-transform flush before replacement dispatch, even when provider/model remain unchanged. Concurrent model-change and TTL-expiry boundaries SHALL share that flush. Failed or aborted flushes SHALL block replacement without committing the new account.

#### Scenario: Same model changes account
- **WHEN** a session moves from A to B on the same physical provider/model
- **THEN** pending transformations materialize before B's request
- **AND** the lifecycle observation identifies an account change, not a nonexistent physical-model change
- **AND** successful cache activity for A does not refresh B's cache epoch

#### Scenario: Account and model change together
- **WHEN** one replacement changes both account and model while the old cache epoch is expired
- **THEN** one successful pre-dispatch flush handles all boundaries
- **AND** the replacement consumes the existing bounded transition/recovery budget

### Requirement: Direct routing remains independent

Direct routing SHALL select physical candidates deterministically without reading or changing session stickiness, cache epochs or recovery budgets, and SHALL NOT trigger session Magic Context flushes. Because credentials are runtime-global, direct calls to a provider with named-account routing use that provider's currently active runtime key; configurations requiring a distinct concurrent direct-call account SHALL use another Pi runtime.

#### Scenario: Auxiliary request during account fallback
- **WHEN** a direct request occurs while a session is sticky on fallback B
- **THEN** direct model selection remains independent and does not mutate session account state
- **AND** a call using B's provider observes the active runtime credential B
- **AND** session branch state and cache activity remain unchanged

### Requirement: Account identity is observable without secrets

Diagnostics and available dispatch telemetry SHALL distinguish the logical route, physical provider/model and opaque configured account ID. Secret values, derived key fingerprints and raw auth headers SHALL NOT appear in branch state, events, health records or telemetry.

#### Scenario: Account-labelled generation
- **WHEN** effective physical dispatch identity includes named account B
- **THEN** telemetry reports B separately from physical and virtual model identity
- **AND** unavailable account identity is omitted rather than guessed from the current session selection

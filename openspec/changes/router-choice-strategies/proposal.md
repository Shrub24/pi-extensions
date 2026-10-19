# Proposal

## Why

The router currently chooses by configured order and stickiness. Operators need to express preferences such as avoiding DeepSeek peak pricing or using substantial quota before reset without adding each policy to dispatch code.

## What Changes

- Add an opt-in, per-route TypeScript strategy module: a synchronous function receives a versioned, immutable routing snapshot and strategy options, then returns one eligible target ID and a bounded explanation.
- Expose physical/account identity, configured order, quota windows and provenance, pricing and peak state, cache activity, effective thinking, request estimates, selection mode and exclusions without exposing credentials or prompts.
- Retain ordered/sticky selection as the default and fallback. A custom strategy owns automatic stickiness; bounded transient retries and explicit recovery targets retain precedence unless the user has just made a one-shot pin override. A fresh pin switches to its eligible target on the next request, then the selected model stays sticky; persistent pins remain context/preferences for automatic selection.
- Validate every choice and reapply existing admission, activation, transition and flush safeguards. Reselect after exclusion without bypassing retry safety or budgets.
- Use the same selection module for route preview and dispatch, and explain strategy decisions and fallback in existing diagnostics.
- Document the trusted-code loading contract and provide an illustrative peak/quota-aware TS strategy rather than introducing a built-in scoring engine.

## Capabilities

### New Capabilities

- `route-choice-strategies`: Pluggable, snapshot-based selection among eligible physical targets, with compatibility fallback and operator explanations.

### Modified Capabilities

None in the main spec inventory. Related router capabilities currently live in unarchived changes. This change extends their selection behavior, preserving safety contracts. The README's unconditional no-quota-ranking statement becomes a guarantee of the default strategy only; custom strategies may use quota headroom explicitly. Pending physical-pin rules for auto/dormant pins use configured strategy selection on opted-in routes instead of unconditional route order.

## Impact

- `pi-native-router/src/config.ts`, `policy.ts`, `index.ts`, decision logging, and a small strategy contract/loader/snapshot module.
- Read-only adapters over existing shared quota data, pricing/catalog data and account-scoped cache activity; no new quota fetcher, transport or state database.
- Router README, package exports/files for the public TS contract and example, native TS module loading, and focused configuration/policy/host coverage.
- Existing configurations retain their behavior. No deployment configuration is changed by this planning change.

## Non-goals

External processes, Python/JSON protocols, a rules DSL, LLM-based routing, quality prediction, automatic spend verification, new quota meters, proactive cache warming, or a built-in adaptive optimization algorithm. Strategies cannot define routes or add candidates, and this is not a security sandbox.

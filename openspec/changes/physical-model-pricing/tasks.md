# Tasks

## 1. Pricing model and host decision

- [x] 1.1 Record that Pi 1.1.0 has no public single-model cost update; `registerProvider(name, {models})` replaces a provider's whole model list, so the router does not mutate the registry (design, Context and Decision 1).
- [x] 1.2 Define and test a typed pricing snapshot with exact `(provider, model)` identity, nullable rate components, USD-per-million units, source, catalog version and retrieval time; absent cache rates stay unknown and explicit zero stays known.

## 2. Bounded source refresh and lookup

- [x] 2.1 Implement opt-in bounded fetch of models.dev provider records and LiteLLM's map (20 s, 12 MB, redirects refused), strict validation, and last-valid snapshot retention; verify with fixtures for valid, malformed, oversized and unavailable responses.
- [x] 2.2 Implement exact provider/model lookup and exact-key `pricing.overrides` precedence with provenance; test that same-name models under other providers do not cross-map and unknown records stay untouched.
- [x] 2.3 Document source semantics, units, override configuration, cache bounds, the `/pricing` commands, and that estimates are not billed cost, with provider-specific examples that distinguish missing from explicit zero.

## 3. Reconciliation rules

- [x] 3.1 Decide the backfill rule: missing or placeholder zero (design, decision 3), recorded in the design and the spec before implementation.
- [x] 3.2 Implement the backfill rule in the `message_end` reconciliation. Unit tests in `reconcile.test.ts` cover a nonzero Pi cost, a placeholder zero, a genuinely free model, and a partial record. `backfill-wiring.test.ts` drives the installed handler against a saved snapshot.
- [x] 3.3 Peak adjustment for the listed DeepSeek models in the published windows, with `peakMultiplier` set. Covered by handler-driven tests in `peak-cost.test.ts`. Live confirmation is tracked in 5.1.

## 4. Telemetry provenance and integration

- [x] 4.1 Attach catalog and override provenance (`pi.pricing.source`) to backfilled usage in the router, and export it in pi-otel next to `gen_ai.usage.cost` without recalculating cost. The backfill now resolves through exact lookup with `pricing.overrides`. Tests: `reconcile.test.ts` and `backfill-wiring.test.ts` (router); `tracker.test.ts` 'exports the pricing source only for catalog or override estimates' (pi-otel).
- [ ] 4.2 Integration test with one frozen snapshot: the native total and the exported total match, and no exported estimate is labelled as invoice, actual charge or subscription cost.
- [ ] 4.3 Confirm disabled or unmapped configurations preserve current costs. Document rollback: delete the snapshot or disable the handler.

## 5. Live confirmation

- [ ] 5.1 On live OpenCode Go DeepSeek traffic, confirm a weekday peak-window request carries `peakMultiplier` 2 and the doubled cost, and an off-peak request does not.

# Tasks

## 1. Establish the supported pricing seam

- [ ] 1.1 Verify the exact supported Pi host's public physical-model registry API can update cost metadata before provider usage accounting; add a focused host-level test proving a resolved physical model receives rates before `Usage.cost` is computed, or document the blocking API gap and keep runtime application disabled.
- [ ] 1.2 Define and test a typed pricing snapshot containing exact physical `(provider, model)` identity, nullable rate components, USD-per-million units, source/provenance, catalog version, and retrieval time; assert absent cache rates remain unknown while explicit zero remains known.

## 2. Bounded source refresh and mapping

- [ ] 2.1 Implement opt-in bounded fetch/cache of provider-specific models.dev API pricing records, strict input validation, version/retrieval metadata, and last-valid-snapshot retention; verify with deterministic fixtures for valid, malformed, oversized, and unavailable responses.
- [ ] 2.2 Implement exact provider/model mapping and exact-key local override precedence, preserving source provenance; test same-name/different-provider models do not cross-map and unknown model records remain untouched.
- [ ] 2.3 Document source semantics, units, mapping/override configuration, cache bounds, opt-in refresh, and the fact catalog estimates are not billed cost; verify examples use provider-specific identities and distinguish missing from explicit zero.

## 3. Apply native physical rates and verify accounting

- [ ] 3.1 On the supported host seam only, apply complete applicable frozen rate sets to the resolved physical model before usage calculation; verify dispatch performs no catalog network access, does not expose credentials, and routing selection is unchanged.
- [ ] 3.2 Add targeted native accounting tests for input/output/cache-read/cache-write arithmetic in USD per million, including zero, partial/missing cache rates, incomplete totals, and no accidental unknown-as-free behavior; assert provider-reported usage cost is not overwritten.
- [ ] 3.3 If the public host seam is unavailable, test that the integration reports the feasibility limitation and leaves native model costs unchanged; keep this as an explicit blocker rather than mutating private registry internals.

## 4. Telemetry provenance and integration

- [ ] 4.1 Add targeted pi-otel tests proving it exports the supplied `Usage.cost.total` without independent recalculation and exposes estimated/catalog provenance only through a supported metadata path; verify provider-reported amounts remain distinguishable from estimates.
- [ ] 4.2 Run focused native-accounting and telemetry integration tests with one frozen mapped price snapshot; verify token components produce the same native total and telemetry total, and assert catalog estimates are not labeled as invoice, actual charge, subscription cost, or provider-billed cost.
- [ ] 4.3 Verify the pricing component can be enabled/disabled independently of account/shared-health work and without native-router activation; document rollback and confirm disabled/unmapped configurations preserve existing behavior.

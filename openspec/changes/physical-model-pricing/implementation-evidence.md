# Implementation evidence: physical-model-pricing

## Implemented (catalog side only)
- `pi-native-router/src/pricing/catalog.ts`: models.dev and LiteLLM parsers, exact snapshot construction (models.dev authoritative), exact-key lookup with overrides, unknown-preserving complete/partial/unpriced estimates.
- `pi-native-router/src/pricing/cache.ts`: bounded fetch (20 s, 12 MB cap, redirects refused), private atomic last-valid snapshot.
- `/pricing refresh` and `/pricing show <provider>/<model>` commands; `pricing.overrides` config.

## Verification
- `bun run typecheck` passes; `bun test tests` 69 pass.
- Live refresh against models.dev and LiteLLM: 11,236 records, no failures. `anthropic/claude-haiku-4-5` complete; `opencode-go/mimo-v2.5` partial (no cache-write rate); `opencode-go/claude-haiku-4-5` unpriced.

## Reconciliation as built
- `message_end` keeps Pi's recorded cost and applies the peak multiplier for OpenCode Go DeepSeek models in the published windows (`pi-native-router/src/pricing/reconcile.ts`).
- The catalog backfill runs when Pi has no model for the physical key, or when the recorded cost for a message with tokens is zero (design, decision 3). It fills only from a complete, nonzero exact record. A nonzero Pi cost is never overwritten.
- Verification: `bun run typecheck` passes; `bun test tests` 103 pass (includes `reconcile.test.ts` and `backfill-wiring.test.ts`).

## Not done
- No catalog provenance is exported yet (task 4.1).
- Peak adjustment has not been checked on live traffic (task 5.1).
- Registry-level price application was rejected (design, Context). No host seam is used.

## Rollback documentation (task 4.3, documentation part only)
- Catalog backup: deleting `$PI_CODING_AGENT_DIR/pi-native-router/pricing.json` stops backfill; Pi's recorded cost stands. Documented in the router README.
- DeepSeek peak doubling is not gated by the snapshot and has no configuration switch. Disabling it requires a router change; this is an open decision, not a documented rollback.
- The check that disabled or unmapped configurations preserve costs is still open (4.3 stays unchecked).

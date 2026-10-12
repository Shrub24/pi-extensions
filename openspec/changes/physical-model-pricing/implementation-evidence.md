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
- The catalog backfill runs only when Pi's registry returns no model for the physical key. Pi registers every model it knows with a cost object, so the backfill does not run for models in our routes. No test exercises it with a registered model. The rule is an open decision (design, decision 3).

## Not done
- The backfill rule is undecided (task 3.1), so its behaviour is not claimed as active.
- No catalog provenance is exported yet (task 4.1).
- Peak adjustment has not been checked on live traffic (task 5.1).
- Registry-level price application was rejected (design, Context). No host seam is used.

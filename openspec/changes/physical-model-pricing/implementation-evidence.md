# Implementation evidence: physical-model-pricing

## Implemented (catalog side only)
- `pi-native-router/src/pricing/catalog.ts`: models.dev and LiteLLM parsers, exact snapshot construction (models.dev authoritative), exact-key lookup with overrides, unknown-preserving complete/partial/unpriced estimates.
- `pi-native-router/src/pricing/cache.ts`: bounded fetch (20 s, 12 MB cap, redirects refused), private atomic last-valid snapshot.
- `/pricing refresh` and `/pricing show <provider>/<model>` commands; `pricing.overrides` config.

## Verification
- `bun run typecheck` passes; `bun test tests` 69 pass.
- Live refresh against models.dev and LiteLLM: 11,236 records, no failures. `anthropic/claude-haiku-4-5` complete; `opencode-go/mimo-v2.5` partial (no cache-write rate); `opencode-go/claude-haiku-4-5` unpriced.

## Not done (blocked on host seam, task 1.1)
- Prices are not applied to Pi's native `Usage.cost` or to OTel. The inspected Pi 1.1.0 registry exposes no public price-update API, so runtime application stays disabled. No private mutation was used.
- Tiered pricing is reported as partial and is not applied.

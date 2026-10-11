# Design

## Context

See proposal.md for motivation. Current `config.ts` deduplicates candidates by provider/model; `policy.ts` and branch/cache state use that same identity. `index.ts` checks native default auth and observes successful activity through assistant `message_end`.

Matching Pi 1.1.0 exposes only model, thinking level and state in `ModelRoute` (`dist/core/virtual-models.d.ts`). Native runtime resolves the physical model and its configured provider auth. The public Go factory has a fixed provider ID and native API/session-header behavior; an arbitrary config alias does not inherit it. Source recon is recorded by `result:key-accounts#1` and `result:key-accounts#2`.

The unarchived native-router and TTL specs remain the baseline. Herdsman's main `herdsman-model-policy` capability controls launch-model admission, not account selection inside an authorized route, and needs no change.

## Goals / Non-Goals

**Goals:** Add an account dimension without changing native execution, recovery safety, non-shrinking capacity or default-auth compatibility. Establish one secret-free identity used later by shared health and quota fetching.

**Non-goals:** Multiple keys per account, quota pools, multi-account OAuth, auth-store switching, provider aliases that reconstruct Go internals, hot credential rebinding, secret provisioning or deploying host/config changes during planning.

## Decisions

### Named account configuration is user-owned and reference-only

Add a strict accounts map to the existing router user-settings namespace. Each entry binds a stable opaque ID to a canonical provider and an environment-variable key reference; candidate `account` is optional. This is proposed configuration, not an API already supported by Pi 1.1.0:

```json
{
  "accounts": {
    "go-a": { "provider": "opencode-go", "apiKeyEnv": "OPENCODE_GO_A_KEY" },
    "go-b": { "provider": "opencode-go", "apiKeyEnv": "OPENCODE_GO_B_KEY" }
  },
  "routes": {
    "worker": {
      "candidates": [
        { "provider": "opencode-go", "id": "MODEL-ID", "account": "go-a" },
        { "provider": "opencode-go", "id": "MODEL-ID", "account": "go-b" }
      ]
    }
  }
}
```

No account means the provider's native default auth, including its existing OAuth behavior. Reserve an internal default-account marker; reject unknown accounts, provider mismatches, literal keys, unknown fields and duplicate provider/model/account tuples. Missing named key references are unavailable targets, never permission to fall through to another key.

One key is one account by owner decision. Do not hash a key into an ID or attempt account discovery. Use a new account ID when replacing its key; mutable live rebinding and automatic key-rotation detection are outside this slice. Environment references avoid secrets in generated Nix settings. Parent/child launch environments must receive the referenced secrets separately.

### Use serialized Pi runtime-key activation, with its explicit concurrency limit

The owner approved the established `pi-accounts` model: activate the selected key with Pi's `ModelRuntime.setRuntimeApiKey(providerId, apiKey)` before native request preparation, serialize and generation-fence mutations, verify the effective key, and fail closed on errors. The existing native provider object/catalog remains responsible for API selection, session headers, streaming, reasoning and usage. No provider alias or recreated transport is needed.

In Pi 1.1.0 this operation exists on `ModelRuntime`, but `ExtensionContext.modelRegistry` exposes only a facade whose `runtime` field is declared private. `pi-accounts` discovers the runtime/auth-storage object by a structural cast over `ctx.modelRegistry`, `.runtime`, and `.authStorage`, then feature-detects `setRuntimeApiKey`/`removeRuntimeApiKey`; this is a compatibility adapter over host internals, not a public ExtensionAPI method. Implement the smallest fail-closed adapter patterned on that upstream source and test it against the exact supported host. Do not claim public-API stability. If the shape changes or verification cannot prove activation, named-account dispatch fails before provider execution; native default-auth candidates continue normally.

`pi-accounts` upstream was inspected at SHA `67357f8387ad2203d9083b902abde0a90377029c` (`result:key-accounts#3`). Its runtime auth queue, generation fencing, pre-turn synchronization and effective-key verification are reusable. It does not provide Go-specific adapter coverage; this router must verify the built-in Go provider remains the registered implementation.

This model makes one account active per provider per Pi runtime. Parent and Herdsman workers are separate processes and therefore have independent active keys. Within one process, routed generation calls are expected to be sequential at Pi request boundaries; don't change the key while an owned routed request is in flight. Overlapping direct/provider calls are not isolated and use the currently active key. Document this limitation plainly and require a separate Pi runtime when a concurrent call needs a different account. Account telemetry identifies the account active at dispatch; it must not be inferred after dispatch from a later mutable account setting.

The account activation adapter is also the future private credential lookup for quota fetching; do not add a second secret resolver.

### Keep target and cache identities account-aware

A target is canonical provider/model/account. Keep actual native provider/model identity distinct from account identity; account selection does not itself change the physical model.

Version branch state to add the selected account. Read legacy state/cache entries as native-default only. Persist no secret reference values or fingerprints. Route stickiness, terminal fallback selection and duplicate detection use full target identity. Recovery budgets count account replacements as target transitions, including same-model replacement; account changes cannot bypass existing limits or capacity checks.

Use account-aware cache activity so successful traffic on A cannot warm B. Restore/fork retain the account and consumed TTL epoch. Direct routing remains ordered and independent of branch state.

### Coalesce cache boundaries and distinguish observations

Extend the existing awaitable pre-dispatch flush seam to carry an account-change reason. Account-only changes must not fabricate physical-model transitions. Account plus model change or expiry shares one bounded flush; commit account/epoch state only after acknowledgment and abort checks.

The existing pending-drop/history materialization contract applies. This is not unconditional compression or a same-turn reread of disk-backed system adjuncts. The existing 200k pressure setting and Pi-only idle-TTL policy stay unchanged.

### Publish only proven account attribution

Expose the stable account ID with route diagnostics/events. Add a separate `pi.route.account_id` attribute where native dispatch evidence supplies it; retain standard physical model/provider and `pi.route.virtual_model`. Direct and completion-only identity must be correlated to the attempt. Missing evidence is omitted, not filled from current selection.

## Risks / Trade-offs

- [Runtime key surface is an internal compatibility seam] -> Feature-detect the exact Pi runtime operation, verify effective activation, fail closed on drift, pin/test the host shape and retain default-auth routes when unavailable.
- [Same physical model hides credential changes] -> Full target identity and explicit account cache boundaries, with correlated attempt identity.
- [Different processes bind the same ID to different keys] -> One user-owned config and immutable account mappings per launch; document replacement IDs and reject mismatched provider bindings.
- [Key provisioning differs between parent and child] -> Test launch environment references without embedding secrets in Nix or branch state.
- [Account labels expose personal identity] -> Opaque user-chosen labels, no email discovery or raw auth payloads.

## Migration Plan

1. Implement and test the feature-detected runtime-key adapter against Pi 1.1.0 and the deployed host package; record the provider-global limitation.
2. Add account parsing/state compatibility while existing candidate lists continue using native default auth.
3. Verify sequential account fallback on the native Go provider and a distinct Pi process per account; test overlapping same-runtime calls use only the documented active key semantics.
4. Document parent/worker secret provisioning and full Magic Context loading; activation remains an operator step.
5. Roll back by removing named-account candidates and retaining native-default routes. An unsupported host must fail named-account targets explicitly rather than reinterpret them.

## Validation

Use the current native fake-provider host harness for routing/state/flush regressions, plus a matching-host runtime-auth integration proving effective-key activation and Go API/session-header preservation. Test default auth without accounts, named auth without a default key, partial/aborted outcomes, restored account B, account removal, direct selection independence with current-provider-key semantics, and account+model+TTL flush coalescing. Synthetic key assertions inspect public outputs; do not claim concurrent per-request credential isolation.

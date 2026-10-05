# Tasks: model policy

## 1. Configuration

- [x] 1.1 Add `modelScopes` to `HerdsmanConfig`, `DEFAULT_CONFIG` and validation: an optional
  `allow` list, optional per-definition lists under `agents`, and pattern validation (exact,
  trailing wildcard, or `$inherited`). Test each rejection and the accepted shapes. An empty
  `agents` map is accepted (it is the same as omitting it, so a generated config may emit it);
  an empty `allow` list is rejected, because a scope that permits nothing is a
  misconfiguration rather than a policy.
- [x] 1.2 Document the key, the pattern syntax, the "every scope must permit" rule and the
  nested-agent inheritance rule in `docs/reference/configuration.md`.

## 2. Enforcement

- [x] 2.1 Check the resolved model against the applicable scopes inside child-model resolution,
  failing with a typed error that names the definition, the model, whether it was pinned or
  inherited, and the rejecting scope. Test the pinned, inherited, per-definition-restriction,
  wildcard and `$inherited` cases. Enforced in the launch path before any process is started,
  next to the child-model resolution that produced the model.
- [x] 2.2 No code change: the pinned model is already part of `resolveAgentLaunchInputs` and so
  of the stored fingerprint, and an inherited model is deliberately excluded from that record
  so the same worker does not fingerprint differently depending on how it was started. The
  origin needs no entry either — a violation fails the launch rather than changing it. The
  spec's original wording asked for both and was corrected.
- [x] 2.3 Covered by the existing child-model resolution tests, which now run against the
  default empty policy: a configured model still outranks the inherited one, the inherited
  provider exception still applies, and the enforcement block does nothing when no scope
  exists.

## 3. The denied-discovery contradiction

- [x] 3.1 Detect a pinned model whose provider is extension-registered alongside
  `noExtensions: true`, and fail the launch before starting a child, with a diagnostic naming
  the definition, the model and both remedies. The check runs before `agentLaunchArgs`
  composes the argv, so no process exists to clean up.
- [x] 3.2 Confirmed by test: `deniedDiscoveryModelError` returns undefined for a definition
  that allows extensions and for a pinned model a built-in provider serves, and the existing
  inherited-model tests pin the exception unchanged.

## 4. Gates

- [x] 4.1 Run the `pi-herdsman` suite and `npm run package:audit`, and record the counts and
  the source checkpoint. 2026-10-05: `npm run validate` green at working copy `kpzumwru` on
  `main` 4fd08969 — 936 tests, 935 pass, 0 fail, 1 skipped; `package audit passed: 108
  files`.
- [x] 4.2 Strict OpenSpec validation for this change.
- [x] 4.3 Report the policy to the dotfiles agent, including the `scout` definition that
  pinned an extension-provided model while inheriting `noExtensions: true` — already fixed on
  their side by setting `noExtensions: false`, with the fail-fast now covering the case if it
  is reintroduced. Reported 2026-10-05 over intercom with the exact config shape and the
  "every scope must permit" and `$inherited` semantics.

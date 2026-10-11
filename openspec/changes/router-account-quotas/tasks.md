# Tasks

Prerequisites: router-api-key-accounts for private key binding and router-shared-health for transactional causes/admission/leases.

## 1. Verified Go source and snapshot semantics

- [ ] 1.1 Pin the original Go usage protocol and obtain a sanitized authenticated response for the configured endpoint; record account-identity association, required window fields, units and reset semantics, and keep the adapter disabled if this real-source compatibility gate is unavailable.
- [ ] 1.2 Implement the normalized account/source-labelled snapshot and Go parser with complete/incomplete window coverage, observation/fetch times and credible resets; verify fixtures for rolling available plus weekly exhausted, all-window capacity, missing/malformed fields and explicit unit conversion without unknown-as-zero.
- [ ] 1.3 Implement a bounded trusted-origin HTTPS fetch through the existing private account binding; verify per-account auth, cross-origin redirect rejection, timeout, unavailable/unsupported responses and no keys/raw bodies in stored snapshots or diagnostics.
- [ ] 1.4 Document direct Go support, one-key/one-account references and source/freshness semantics; verify examples require neither CodexBar, browser auth nor local OpenCode usage estimates.

## 2. Shared asynchronous refresh

- [ ] 2.1 Add per-account snapshot persistence and atomic refresh admission/commit through the shared transactional store; verify two processes issue one refresh and cannot cross-write accounts or accept an expired lease result.
- [ ] 2.2 Add opt-in session-start/stale-cache refresh and operator refresh with bounded interval, freshness, timeout and failure backoff; verify crashed leases expire, shutdown cancels owned fetches and a slow monitor never delays provider dispatch.
- [ ] 2.3 Document bounded default/override values, disabling and last-valid-but-stale behavior; test quota endpoint failures do not become generation auth/rate/outage penalties or fabricated zero capacity.

## 3. Account eligibility and fenced reconciliation

- [ ] 3.1 Translate fresh authoritative exhausted applicable windows into source-labelled account quota causes; verify exclusion crosses all models/routes but does not rank headroom, move a healthy sticky account or refresh its cache epoch.
- [ ] 3.2 Reconcile complete newer authoritative capacity under the captured fetch-start health revision; test old healthy fetch after newer quota failure, incomplete coverage, stale/estimated data and independent auth/rate/outage causes that must remain.
- [ ] 3.3 Integrate reset-to-probe admission with shared health, including unknown resets and stale snapshots; verify one recovery probe at expiry and no unrestricted account re-admission merely from wall-clock or polling failure.
- [ ] 3.4 Add quota inspect output distinguishing monitoring freshness/coverage/refresh lease from error-derived health; verify normalized reset/source details and no unsupported billing/spend claims.

## 4. Composed verification

- [ ] 4.1 Run the native-router host harness with a slow/local quota peer and two shared-store processes; verify correct account binding, non-blocking cached eligibility, sticky fallback and failed/stale monitoring independent of native retry/terminal continuation.
- [ ] 4.2 Run targeted parser/store/router tests and typecheck plus strict OpenSpec validation; record provider contract revision, authenticated evidence sanitization and exact runner results without implying deployment activation.

## Workflow follow-up

- Future providers or an optional CodexBar importer may supply the same normalized snapshots; no generic plugin framework is required now.
- Review and archive after authenticated compatibility and composed acceptance pass; activation remains separate.

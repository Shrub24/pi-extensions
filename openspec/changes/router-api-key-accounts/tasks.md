# Tasks

## 1. Native binding prerequisite

- [ ] 1.1 Implement the pinned pi-accounts runtime-key adapter with structural feature detection, serialized/generation-fenced mutation and effective-key verification; test that it fails closed when the runtime auth surface is absent and does not alter default-auth requests.
- [ ] 1.2 Verify named key activation before request auth resolution on Pi 1.1.0, including no canonical default key; assert actual sequential A-to-B key use, unchanged native Go provider/API/session headers, and record the provider-global one-active-key-per-runtime limitation rather than claiming request isolation.
- [ ] 1.3 Add compatibility detection and an actionable pre-dispatch named-account error; verify a host lacking the runtime key operation dispatches no named-account request while existing default-auth routes remain usable, and document the limitation in router README.

## 2. Trusted account configuration and identity

- [x] 2.1 Extend strict user-only router configuration with named provider/API-key environment references and optional candidate accounts; test missing/mismatched references, literal-key rejection, unknown fields and duplicate full targets while permitting the same provider/model on A and B.
- [x] 2.2 Make target identity and private native auth eligibility account-aware; verify accounts can resolve without a canonical default key and missing named auth never silently uses another credential.
- [x] 2.3 Document the reference-only configuration, one-key/one-account assumption, immutable account IDs and parent/child environment provisioning; verify examples contain no secret values and existing no-account/OAuth settings retain native behavior.

## 3. Persist selection and integrate cache boundaries

- [ ] 3.1 Version account-aware branch and cache-activity state with legacy default-auth decoding; verify sticky fallback B across normal turns, continuation, resume/fork, account removal and legacy branches without leaking key references/values.
- [ ] 3.2 Extend pre-dispatch lifecycle for account changes, sharing model-change/TTL flushes and counting replacements against existing recovery budgets; verify same-model A-to-B materialization, one combined flush, failed/aborted flush blocking and no false physical-model transition.
- [ ] 3.3 Keep direct routing independent and correlate successful cache activity with the actual dispatched account; verify direct traffic changes no branch/TTL state and success for A cannot warm B.
- [ ] 3.4 Document account lifecycle observations and the unchanged pending-transform/system-adjunct boundary; check examples distinguish account-only from physical-model transitions and preserve the 200k pressure policy.

## 4. Observable identity and composed verification

- [x] 4.1 Export opaque selected account ID separately from virtual and physical identity, including pi-otel where evidence is available; test sequential account-switch and completion-only attribution, direct-selection independence with current runtime-key semantics, omission without evidence, and absence of synthetic secrets in events/state/telemetry.
- [ ] 4.2 Run router typecheck/tests and relevant OTel/Herdsman launch tests under their declared runners, plus the matching-host binding smoke; record exact host version, credential-isolation/lifecycle evidence and any unresolved gate rather than claiming deployed support.
- [ ] 4.3 Validate this change strictly and verify documentation/loading instructions for parent and full-Magic-Context workers without modifying live credentials or activating a deployment.

## Workflow follow-up

- Integrate native-host changes through their own approved owner/repository scope; no private runtime patch belongs in this extension.
- Apply router-shared-health next, then router-account-quotas. Pricing is independent.
- Review and archive only after all implementation gates pass; activation remains a separate operator action.

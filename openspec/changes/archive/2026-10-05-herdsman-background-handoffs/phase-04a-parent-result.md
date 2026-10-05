# Waiting evidence codec — parent acceptance

## Decision and scope

The codec-only slice is accepted. Task 3.1 remains unchecked: no mailbox field, protocol update, provider consumer or runtime waiting guard has been wired.

Only `pi-herdsman/extension/background-waiting.ts` and `background-waiting.test.ts` were added. Dispatch used `/tmp/herdsman-waiting-codec-brief.md`; worker run `15057927-7629-43a4-afc2-b0aba5d38ebb`, correction on the same worker session as run `9652415b-2726-4873-86d7-7c444d95aee2`. Neither ran commands or advanced beyond its task.

## Review and correction

Parent found the initial Unicode budget test was a false positive: all 128 ids were identical, so it rejected `taskIds[1]` as duplicate before testing bytes. Parent reproduced that exact rejection on a 66054-byte value. The bounded correction uses 128 distinct 256-unit/512-byte strings, checks uniqueness and byte overflow, and requires the specific state-budget error. The unused error-length constant was removed; error-bound assertions remain.

## Verification

After correction:

- `npm test -- extension/background-waiting.test.ts`: **15 pass / 0 fail**, exit 0.
- Pinned TypeScript 5.9.3, strict no-emit, ESNext/bundler/ES2022, Node types, only the codec and its test: **no diagnostics**, exit 0.

Before the assertion-only correction and unused-constant removal, `npm run check` completed the Herdsman deterministic suite: **832 tests, 831 pass / 0 fail / 1 skipped**, exit 0. This package check is its test runner, not a TypeScript compiler. It was not rerun merely to repair test coverage; the changed slice was rerun and strictly typechecked above. Final package-wide gates remain in Group 6.

Source checkpoint before this document: `e5a7e0f9e0b82a22cbf33f65fa48b23a97779623`.

SHA-256:
- `background-waiting.ts`: `e944c68b821266b10a18473462c6786f79e96fe417517e20163b703177ff7ba3`
- `background-waiting.test.ts`: `f38eb90801c881402d18ffdd0e112cb3bd923ef7bc049f908469359f18804e44`

Raw reports and parent logs are under `/home/saurabhj/.pi/agent/sessions/--home-saurabhj-Projects-dev-custom-pi-extensions--/subagent-artifacts/outputs/d8eb9b03-88c0-40f3-814c-8c1e2917b102/outputs/`: initial-submission and correction reports, `parent-codec-corrected-tests.log`, `parent-codec-corrected-typecheck.log`, and `parent-herdsman-check.log`.

## Next boundary

D9 requires waiting and accepted contract metadata to participate in a coherent paired wire-format update and explicit legacy-assignment migration. Do not silently append waiting metadata to the old transport and let old projection treat it as idle. The parent will specify the exact protocol slice; production integration and task advancement remain parent-owned.

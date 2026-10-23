## 1. Implementation

- [x] 1.1 Add session/route local order and enabled state, reset and route-exit cleanup.
- [x] 1.2 Apply effective order and eligibility at shared selection and resumption boundaries without mutating config or health.
- [x] 1.3 Preserve custom strategy choice, explicit pin/recovery safety and one-shot reconsideration.
- [x] 1.4 Implement native custom UI with documented keyboard matching and draft apply/cancel.

## 2. Validation and documentation

- [x] 2.1 Exercise apply/reset, one-time reconsideration and stickiness, cancel, invalid draft, route exit, manual disabled pin/cycle, account identity and custom strategy order in real host tests.
- [x] 2.2 Exercise disabled-target readiness and effective-order dispatch with controlled resumption timers.
- [x] 2.3 Exercise editor keys and width truncation at the component boundary.
- [x] 2.4 Add README usage example and record design choices and validation limits.
- [x] 2.5 Run full router Bun suite, focused typecheck, strict OpenSpec validation and diff check after final edits.

Live terminal rendering is unchecked; no paid provider calls or deployment are part of validation. The ordinary package typecheck has a pre-existing example import-alias error; the focused check uses a temporary external tsconfig mapping that alias to the existing strategy source.

Final evidence: `bun test pi-native-router/tests` passed 203 tests; focused TypeScript check passed with the temporary alias mapping; `openspec validate router-session-order --strict` and scoped `git diff --check` passed.

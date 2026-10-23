## Decisions

Store an ordered list of account-qualified candidate identities and enabled bits in an in-memory map keyed by session and route. A pending flag requests one priority reconsideration at the next prepared session dispatch. Preview does not consume it. Reset installs the configured order with all configured candidates enabled and the same pending flag. Leaving the route removes the override; session start/shutdown also clear local entries. Resume/fork persistence is intentionally unsupported. Full-state branch snapshots were rejected because this preference is temporary and scoped to the selected route.

Selection projects a new route and sorted candidate list without mutating config. Disabled candidates are removed from normal selection and strategy eligibility, while strategy targets retain them with a session-disabled rejection reason. Custom strategy choice retains precedence over ordered fallback. The pending flag removes incumbent preference for one automatic decision; explicit fresh pin, retry and recovery priorities retain their existing safety guarantees.

Explicit pin lookup uses the full available list before automatic filtering, retaining fit, admission and one-shot consumption rules. After that dispatch, disabled targets cannot be automatically selected even by a stored pin or transient retry. Manual picker and cycle retain all candidates; cycle follows the overridden order. No health state is cleared by toggling a candidate.

Resumption's candidate callback receives only enabled candidates in effective order, so readiness and execution use the same local preferences plus the saved authorization scope. The final dispatch check remains in place.

The UI edits a draft using documented `matchesKey`/`Key` helpers. Enter returns it; Escape discards it. The command rejects an all-disabled draft before replacing the map. Rendering uses native terminal-width truncation and a bounded selection window. Non-TUI clients can reset and receive feedback that the editor requires TUI mode.

## Validation and limits

Host tests use real Pi sessions, virtual routing, native retry/terminal recovery, synthetic providers, a real health store and controlled resumption timers. Component tests cover key decoding, draft cancellation and terminal width. No paid provider calls are made. Live terminal rendering, theme switching and terminal-specific Shift key delivery are not verified.

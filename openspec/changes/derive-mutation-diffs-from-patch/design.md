# Design

## Context

`pi-tool-renderer` wraps Pi's builtin `edit`/`write`, and today attaches its own whole-file diff to the result (`details.kendexDiff`). Pi's `edit` already returns `{ diff, patch, firstChangedLine }`; `write` returns no details. See `proposal.md` for the measured size and correctness evidence, and `specs/mutation-diff-derivation/spec.md` for the contract.

## Goals / Non-Goals

**Goals**
- One maintained, pure-JS diff implementation; no hand-rolled LCS or size-based bail-out.
- No persisted diff rows; mutation payloads bounded by a small integer summary.
- Identical rendering path for live and resumed sessions.

**Non-Goals**
- Changing how non-mutation rows render, or how the diff row is drawn (numbering, colours, word highlights, collapse).
- Recovering a `write` diff after resume: the previous contents are not persisted anywhere, so the row renders its summary.
- Reading or migrating the old `kendexDiff` field.

## Decisions

### Use jsdiff (`diff`) 9.x as the only diff engine

Pure JavaScript, ESM, **zero dependencies**, no native addons, no code generation — it bundles cleanly into the plugin entry (measured: 21 KB for `diffLines` + `diffWordsWithSpace` + `parsePatch`) and needs only a `package.json` entry plus the lockfile update. It provides `diffLines` (text to text, with `timeout` and `maxEditLength`), `parsePatch` (unified patch to hunks) and `diffWordsWithSpace` (intra-line ranges, replacing the current `wordDiffRanges`).

Rejected: `diff-sequences` (faster but Jest-coupled, callback-only, no bail-out), `fast-myers-diff` (fastest, but last published 2024, single maintainer, no bail-out), `diff-match-patch`/`patience-diff`/`myers-diff` (unmaintained since 2022).

### Two entry points, one row shape

- `structuredDiffFromPatch(patch, lineCount?)` — `parsePatch`, then map each hunk line to the existing `StructuredDiffLine`, numbering from the hunk headers and collapsing unchanged gaps into separators. Used by `edit` rows.
- `buildStructuredDiff(oldText, newText)` — `diffArrays` over lines with a time budget, mapped to the same rows. Used by call previews (`edit` before commit, `write`, `apply_patch`, command diffs in `generic.ts`). The name is kept so existing callers do not change.

Both return the existing `StructuredDiff` shape, so the renderer, collapse logic and hunk numbering are untouched. Word-level highlights stay on their existing per-line implementation: it is bounded per line and is not the source of the bloat.

### Summary, not rows, in `details`

`edit` and `write` store `details.kendexDiffSummary` — integers and a flag only, a few dozen bytes:

- `edit` stores `{ lineCount }`. Its counts come from Pi's patch, which is already on the result, so they are not duplicated. `lineCount` is the file's line count after the edit; a unified patch cannot express how many unchanged lines follow the last hunk.
- `write` stores `{ additions, removals, hunks, lineCount, created }`. Pi returns no patch for a write, so these counts come from the previous contents.

`write` rows render their counts and the line total; they show no diff rows after the call.

### Reads kept, and why

The wrappers no longer keep a before/after snapshot of the file, and nothing is read back to build rows. Two reads remain, both gated by the 700 KB limit and both used only for integers:

- `edit` reads the file once after the edit, to count its lines for the trailing separator. If the file is over the limit, the trailing separator is omitted.
- `write` reads the previous contents once, to count changed lines. A file that exists but is over the limit gets no counts and is never reported as newly created.

### Bounded work

`rowsFromTexts` passes a time budget to `diffLines`; a `undefined` result means "did not finish within budget" and the caller renders counts only, marking the row as unavailable rather than retrying or partially drawing. `parsePatch` is linear in patch size and needs no budget; rows are still capped by the existing display limit.

### Rendering cache

Parsed rows are cached per result object in a `WeakMap` keyed by the patch string's identity (`details.patch` is stable for a given result), so repeated frames re-render without reparsing. Width-dependent work stays in the existing render caches.

## Risks / Trade-offs

- **Old sessions** still contain `kendexDiff`. Ignoring it costs a resumed `write` row its diff (its summary is absent too, so it shows `written`); resumed `edit` rows are unaffected because their patch is present. Accepted: the field is dead weight and the state is one release old.
- **A `write` diff is not recoverable after resume** — by construction, not by regression.
- **jsdiff's worst case** on two unrelated large texts takes seconds; the timeout turns that into a counts-only row. A preview that hits the budget is less informative, never blocking.
- **Dependency resolution in packaging**: the plugin build must resolve `diff` from `node_modules`; if the nix plugin builder does not install runtime dependencies, the bundle step fails loudly rather than shipping a broken plugin, and the fix is a build-input change rather than a code change.

## Migration Plan

No data migration. New results carry the summary; old results keep their rows unread. Rollback is reverting the change: old readers of `kendexDiff` never see new fields, so a revert loses only the summary rendering.

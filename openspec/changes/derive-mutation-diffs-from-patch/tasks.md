# Tasks

## 1. Replace the diff engine with jsdiff

- [x] 1.1 Add `diff@^9` to `pi-tool-renderer/package.json`, install it, and verify the entry bundles with the library included (`bun build ./extensions/tool-renderer.ts`) and that the containing lockfile records a pure-JS, dependency-free package.
- [x] 1.2 Add a regression that two one-line edits 6,000 lines apart report two changes rather than the whole span; verify it fails against the current `diffOps` and passes once `rowsFromTexts` uses `diffLines`.
- [x] 1.3 Implement `rowsFromTexts(oldText, newText)` over `diffLines` with a time budget, returning the existing `StructuredDiff` shape; verify the regression in 1.2, the existing diff-rendering tests, and a counts-only result when the budget is exceeded.
- [x] 1.4 Delete `diffOps`, `DIFF_LCS_CELL_LIMIT` and the wholesale del/add fallback; verify no renderer path references them. Word-level highlights keep their existing per-line implementation (bounded, not the source of the bloat).

## 2. Derive rows from Pi's patch

- [x] 2.1 Add a parser test over a captured three-hunk patch from a real session; verify additions, removals, hunk count, row line numbers, and collapsed gap counts match the patch's own numbers.
- [x] 2.2 Implement `rowsFromPatch(patch)` over `parsePatch` and render `edit` rows from it, caching parsed rows per result; verify a live-rendered edit and the same result rendered from a resumed transcript produce identical lines.
- [x] 2.3 Verify the trailing unchanged region after the last hunk uses the stored line count, and that a result without a patch renders its error state and no rows.

## 3. Store a summary instead of rows

- [x] 3.1 Replace `attachDiffDetails` with a summary writer for `edit` and `write` (`additions`, `removals`, `hunks`, `lineCount`); verify a mutation result's serialized details stay under a few hundred bytes for both a small edit in a large file and a whole-file write.
- [x] 3.2 Render `write` rows from the summary and line count; verify a resumed write row shows path, line count and counts with no rows.
- [x] 3.3 Remove the before/after snapshots from the `edit`/`write` wrappers. Rows are never built from file reads; `edit` reads the file once for its line count and `write` reads the previous contents once for its counts, both gated and integer-only. Verify both tools still execute unchanged.

## 4. Bound the work and document it

- [x] 4.1 Verify a preview comparing two large unrelated texts returns a counts-only row within the budget instead of blocking, with no partial rows.
- [x] 4.2 Run the full renderer suite and bundle; verify only pre-existing failures remain, then document the derivation, the summary payload and the dependency in `pi-tool-renderer/README.md` and the CHANGELOG.

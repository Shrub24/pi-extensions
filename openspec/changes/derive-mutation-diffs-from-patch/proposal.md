# Proposal

## Why

`edit` and `write` results persist `details.kendexDiff` — a fully materialized row list of the whole-file diff. In one long session that was **50.4 MB over 2,339 results**, 70 % of all `details` bytes, with **82 % of it from 126 results**. The same session's own unified patches (`details.patch`, which Pi already writes) hold the identical change in **3.7 MB**: for the 2,122 edits that carry both, **2,012 have identical addition/removal counts**. We store the same information 13× over.

Storing it is also a *correctness* defect, not just weight. `diffOps` (`diff.ts:331`) trims the common prefix/suffix and then runs an LCS only when the remaining middle is ≤ 250,000 cells; otherwise it emits that middle as delete-all + add-all. A multi-hunk edit makes the middle span the whole file, so a 28-line edit with three hunks was stored as **7,914 removed + 7,932 added lines** and rendered as `−2123 +2126` for a three-line change. Measured on the real file: two one-line edits 6,000 lines apart report `+6,001/−6,001`.

Storage buys no measurable speed. Parsing a patch into our rows costs **0.015 ms mean (0.78 ms worst)** across 300 real patches, and renders are already cached per component.

## What Changes

- Replace the hand-rolled diff with **jsdiff (`diff`) 9.x**: `diffLines` for text-to-text diffs (call previews, `apply_patch`, command diffs) and `parsePatch` for Pi's stored unified patch.
- **Stop persisting diff rows.** `details.kendexDiff` and `details.kendexDiffWasNewFile` are removed; mutation results store only an integer summary (`additions`, `removals`, `hunks`, `lineCount`).
- **Derive rows at render** from `details.patch` for `edit`; `write` results have no Pi patch, so they render their summary and line count, with no rows.
- **Delete the disk-snapshot capture**: `readTextForDiff` and the before/after reads around the builtin `edit`/`write` calls, and `attachDiffDetails`.
- **Bound the work**: text-to-text diffs run with a time budget and degrade to a counts-only summary rather than blocking a render.
- Drop compatibility reads of the old stored field: resumed sessions render through the same patch-derived path as live ones; a resumed `write` row shows its line count and status.

## Capabilities

### New Capabilities
- `mutation-diff-derivation`: how `edit`/`write` rows obtain their diff, and what mutation results may persist.

### Modified Capabilities

None.

## Impact

- `pi-tool-renderer/extensions/tool-renderer/diff.ts` — `buildStructuredDiff` internals replaced; `attachDiffDetails`, `readTextForDiff` and the snapshot helpers deleted.
- `pi-tool-renderer/extensions/tool-renderer/tools.ts` — `edit`/`write` wrappers stop reading the file; renderers read the patch and the summary.
- `pi-tool-renderer/extensions/tool-renderer/generic.ts` — command-diff previews keep working through the library-backed text diff.
- `pi-tool-renderer/package.json` + `bun.lock` — new runtime dependency `diff@^9`; the packaged plugin build must resolve it (verify the nix plugin build, which bundles the entry).
- Renderer README and CHANGELOG.
- Existing sessions keep their stored rows on disk; nothing reads them, and nothing new writes them.

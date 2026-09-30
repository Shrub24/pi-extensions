# Vendored: pi-vcc summarizer

Algorithmic (no-LLM) conversation summarizer, vendored from
[pi-vcc](https://github.com/sting8k/pi-vcc) (`@sting8k/pi-vcc` 0.8.0, MIT — see LICENSE).

Used by `child-compaction.ts` to summarize a subagent child's context at the
turn boundary instead of paying for pi's LLM summarizer. Layout and relative
imports are preserved from upstream so the files stay diffable against
`src/core/` and `src/extract/`; only the extension entrypoints
(`index.ts`, `hooks/`, `commands/`, `tools/`) are not vendored.

Runtime dependencies: none. `@earendil-works/pi-ai` is imported for types only.

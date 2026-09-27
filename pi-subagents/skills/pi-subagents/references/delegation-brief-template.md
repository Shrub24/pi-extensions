# Delegation Brief Template

A compact, reusable brief for substantial delegated implementation. Write it as a file,
hand the child the file path as the first line of the launch prompt, and require the child
to read it before any discovery. The file — not the launch prompt prose — is the source of
truth for the contract. Do not use a brief for trivial one-shot tasks; a plain prompt is
enough there.

Copy the skeleton below, fill every section, and delete nothing. If a section is genuinely
empty, write why. Any contract decision you leave blank is a decision the child will have
to invent — which is exactly what this brief exists to prevent.

---

```markdown
# Delegation Brief: <short task name>

## Objective
<One paragraph: the concrete outcome the child must produce, and the seam or scope it
owns. What is in scope, what is explicitly out of scope.>

## Repo / CWD / Ref
- Repo: <exact path or URL>
- cwd: <exact working directory the child must run in>
- Ref: <branch, commit, tag, or "current working tree (uncommitted)">
- Do not commit/push unless this section says so.

## Authority / Edit Boundary
- May edit: <files, directories, or seams>
- May NOT touch: <protected files, unrelated dirty changes, generated files>
- May run: <commands, tests, typecheck>
- May NOT: <push, publish, install deps, spawn subagents — unless explicitly granted>

## Pre-Decided Design
Decisions already made — implement, do not re-litigate:
- <decision 1>
- <decision 2>

Unresolved choices — do NOT invent these. If the work needs a decision this brief does
not make, stop and ask the supervisor via contact_supervisor with the concrete options.
<list any left open, or "none — every material decision is made above">

## Context / Evidence Paths
- <path>: <what it is and why it matters>
- <path>: <...>
Name exact files, symbols, and seams before asking the child to search.

## Acceptance / Validation
- Must pass: <exact commands and expected results>
- Run only focused tests for changed modules; do not run the full suite unless told.
- Evidence required: changed files, commands run with exit codes, validation output.

## Output Artifact / Report
- Write findings to: <exact path>
- Final message shape: changed files, validation commands + results, residual risks,
  recommended next step.

## Stop / Escalate / Ask Rules
- Stop and report when: <conditions, e.g. approved scope exhausted, blockers found>
- Ask the supervisor when: <missing contract decisions, ambiguity that changes scope>
- Never: silently widen scope, invent missing decisions, or report success without
  running the validation above.
```

---

## Why file-based

- The launch prompt is ephemeral and lossy in long sessions; a file survives, is diffable,
  and can be updated mid-run with `extend`-style steering without re-launching.
- Naming the brief path first means the child reads the contract before discovery shapes
  its assumptions.
- The ask-the-supervisor rule gives the child a legitimate stop instead of guessing.

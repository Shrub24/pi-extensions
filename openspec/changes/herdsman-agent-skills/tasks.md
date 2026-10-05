# Tasks: agent skill resolution and preloading

## 1. Resolution

- [x] 1.1 Add a skill resolver to `pi-herdsman` that resolves a bare name against the
  project, user, package and settings skill roots in the specified priority order, and
  passes paths through unchanged. Cover each root, the priority order and the
  path-passthrough case with tests.
- [x] 1.2 Fail the launch with a typed error for a value that is neither a path nor a
  resolvable name, naming the value and the roots searched. Test the unknown-name case and
  the missing-explicit-path case separately.
- [x] 1.3 Add the package-declared roots: `pi.skills` entries in the manifests of packages
  installed under the project's and the user's `npm/node_modules`, with scoped packages
  handled. Test a resolved package skill and the priority of a directory root over it.
- [x] 1.4 Add the settings-declared roots: package declarations and skill paths in the
  project and user `settings.json`. Test a resolved settings skill and a malformed settings
  file that must not abort resolution.

## 2. Preloading

- [x] 2.1 Add the `preloadedSkills` frontmatter field to the definition schema and
  validation. Test the type error for a non-array value and for an empty entry.
- [x] 2.2 Inline each preloaded skill's body with frontmatter stripped into the launch's
  prompt files, appended with `--append-system-prompt` after the definition body and
  before inherited context files. Test the prompt order and that the body reaches the first
  request.
- [x] 2.3 Drop a skill named in both `skills` and `preloadedSkills` from the advertised
  list, and confirm other advertised skills are unaffected. Test both.
- [x] 2.4 Enforce the 64 KiB total cap and the readable-regular-file rule as typed errors,
  never truncation. Test the cap, a directory target and an unreadable file.

## 3. Provenance and documentation

- [x] 3.1 Record each preloaded skill's body as a launch prompt snapshot and include
  `preloadedSkills` in the launch inputs the stored fingerprint covers. Test that a
  preloaded definition fingerprints differently from the same definition without it, and
  that a fresh assignment transports and then cleans up the snapshot.
- [x] 3.2 Document `preloadedSkills` in `docs/reference/agent-definition-schema.md`
  alongside `skills`, `noSkills` and `inheritSkills`, including the per-request token
  cost. Add `briefProfile` and `responseContract` to the same field table.
- [x] 3.3 Update `docs/guides/agent-definitions.md` with one worked example of a
  definition that advertises one skill and preloads another.

## 4. Gates

- [x] 4.1 Run the `pi-herdsman` suite and the typecheck, and record the counts and the
  source checkpoint. Map every scenario above to a test. 2026-10-05: `npm run validate`
  green at working copy `kpzumwru` on `main` 4fd08969 — 926 tests, 925 pass, 0 fail,
  1 skipped; `package audit passed: 108 files`.
- [x] 4.2 Strict OpenSpec validation for this change.
- [x] 4.3 Report the resolved field semantics to the dotfiles agent adopting herdsman, since
  its definitions list bare skill names today. Reported 2026-10-05 over intercom: the root
  set and priority, the fail-closed launch, the `preloadedSkills` syntax, and that absolute
  `skills` paths keep working. The agent then moved `lean-implementation` from `skills` to
  `preloadedSkills` on worker and delegate and measured the cost at ~6 KB (~1.6k tokens) per
  child request.

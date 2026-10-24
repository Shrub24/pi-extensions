# Tasks

Target: pi-radar 0.12.0, Radar 0.7.0 at 2c9c460a, wire revision 10, runtime 6.
The change directory retains its original name; 0.10 is not a supported target.

- [x] Review the superseding brief and published SDK.
- [x] Pin the registry SDK, regenerate the npm lock and align the Nix integrity and daemon source pin.
- [x] Use the shared baseline runtime; remove Herdsman's registrar and launch-generation addressing.
- [x] Store child subjects and use subject-only request and handoff identity.
- [x] Prove lead and Chief coordination records by subject instead of registration.
- [x] Continue through `launchRadarWorker({continues: subject})` only.
- [x] Restart through `children.restart`; do not pre-close, retire or erase the worker's state.
- [x] Close through `children.close` with replay of the same request id after an unknown outcome.
- [x] Batch recurring observations through `children.list`, restricted to current mailboxes; drop the child-pane cache.
- [x] Expose and select the Radar baseline in Nix; explicitly load it for children.
- [x] Add owned regressions for subject continuation, restart, batched reads and duplicate-claim refusal.
- [x] Build the npm tarball, actual plugin tree and compiled Pi-Bolt output.
- [x] Retarget the Pi-Bolt flake input to the plugin-interface branch tip (58b74d6ed) and re-verify: `nix flake check`, `pi-bolt`, compiled-plugin and plugin-tree builds pass on that interface.
- [ ] Repair the six excluded composed suites, which fail independently of this adoption: of 338 tests, 215 fail, and the largest classes are four helpers referenced but defined nowhere (`leadExec`, `cascadeExecutor`, `agentControllerExecutor`, `agentFromState`) plus a removed `handleInput` harness method. That is Herdr-removal fixture rot, not Radar addressing; migrate them against current fixtures and keep every owned case.
- [x] Run the isolated real-daemon join: launch, handoff persist-before-ack, repeat retrieval, restart, close replay, retained roster and continue of the same subject. The SDK-only worker must mirror the baseline's awaited shutdown release; without it the fixture leaves its claim attached.
- [ ] Run full Pi worker / agent_complete acceptance on the deployed matching daemon (task 39).

The typecheck is already in `npm run check`, but its unrelated baseline remains
red and visible (task 37). No blanket suppression or baseline allowlist is added.

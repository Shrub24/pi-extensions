# Live smoke — partial, blocked

Runtime smoke is now **user-owned and not an agent completion gate**. Retention and same-process continuation were observed in a real Herdr session; the soft-deadline, extend and Clear idle scenarios have not been run. Task **9.2** now names independent logic review and remains unchecked. The observations below are preserved, not discarded or expanded into claims of unrun success.

## Provenance

- Source checkpoint: jj change `zltswkvv`, commit `3d7303f4c0c2f0f2044de7a9765386822db9cd4d`.
- Validation worker: `d6213709-02c9-4dbd-98ae-12980f80aecc`; workflow `419deeab-1f80-47d9-a033-4988723e19dd`.
- Driver: `/tmp/hs-final-smoke/driver.mjs`.
- Raw evidence: `/tmp/hs-final-smoke/evidence.jsonl`; SHA-256 at capture: `b8c57af02843d42aaf4146ce998140720c5c866ddfede33d70f9c16b8f72acdf`.
- Worker transcript: `/tmp/pi-subagents-uid-1000/async-subagent-runs/d6213709-02c9-4dbd-98ae-12980f80aecc/output-0.log`.
- Temporary configuration: `retainWorkers: true`, `softTimeoutMs: 120000`; model `omniroute/coder-high`, Pi 0.99.2. The real fork extension was loaded from `pi-herdsman/dist/index.js`.
- Session metadata: `/tmp/hs-final-smoke/state.json`.

Times below are UTC. Raw files are temporary; the verified identity and result observations are preserved here for resumption.

## 1. Retention after delivery — observed

The lead called `agent_delegate` for definition `scout`, label `smoke1`, with a short task returning `SMOKE1_DONE`.

- Result delivered at `2026-10-02T03:21:06.107Z`, status `completed`, result index 1 (evidence line 44).
- Request: `7fe2378d-5888-47a4-98ad-5724ade907e8`.
- Worker run: `0f510f1a-0d22-4af1-bb90-477b5fb0d5fb`.
- Worker session: `01a0faa1-2857-7744-adf4-212b09731b91`.
- At `03:25:25.857Z`, the actual `agent_list` response included (line 47):

```text
Agents: 1

smoke1 · definition scout · idle · available_tools: agent_inspect, agent_transcript, agent_close
  session: 01a0faa1-2857-7744-adf4-212b09731b91
```

The pane remained `w1:p2`; process inspection at `03:25:25.865Z` showed the live Pi process, PID/process-group `1548368`, shell PID `1548313` (line 49).

## 2. Same-process continuation — observed

The lead called `agent_continue` with the existing worker session path and a second task returning `SMOKE2_DONE`.

| Identity | Before | After |
|---|---|---|
| Pane | `w1:p2` | `w1:p2` |
| Pi PID/process group | `1548368` | `1548368` |
| Shell PID | `1548313` | `1548313` |
| Worker session | `01a0faa1-2857-7744-adf4-212b09731b91` | unchanged |
| Worker run | `0f510f1a-0d22-4af1-bb90-477b5fb0d5fb` | unchanged |
| Worker pane count | 1 | 1 |

Sources: evidence lines 52 and 58–60, captured at `03:25:36.945Z` and `03:25:51.412Z`.

The second assignment had a new request ID, `d2afd296-f616-4c44-8757-afe6a1e582fb`. Its result was delivered at `03:25:42.830Z`, status `completed`, result index 2, text `SMOKE2_DONE` (line 56). The same worker session file grew from 8,394 to 9,263 bytes and contained the second task (line 59).

Interpretation: the two assignments used one live pane, Pi process, run and session; this was reuse, not a replacement pane or process.

## Remaining user-owned smoke and historical blocker

The validation worker failed with **HTTP 402: credit balance depleted** on the routed `deepseek/deepseek-v4.1-flash` model before producing its final handoff. This is a provider failure, not evidence that the remaining fork behaviors pass or fail.

Still required:

1. A real long-running assignment and advisory digest after the configured two-minute window (allowing scan granularity).
2. `agent_extend` deferring the next digest.
3. Actual `/agents` → Clear idle confirmation, closing only eligible owned idle workers.
Agent acceptance is separate: compile/test provenance, strict OpenSpec validation and independent logic review. The user owns runtime smoke; no further agent-run smoke or completed-smoke handoff is required.

The fresh validation run separately completed `npm test`: 817 tests, 816 passed, 1 skipped, 0 failed, `EXIT=0`; log `/tmp/hs-final-npm-test.log`. Do not infer the missing smoke scenarios from this suite.

## Resource checkpoint and resumption

The experiment was not cleaned up when its validation worker lost model access. Parent process inspection after the failure confirmed the recorded lead and worker Pi processes still existed. No claim is made about their current Herdr eligibility beyond the last recorded lifecycle observations.

- Nested Herdr session: `hs-final-smoke-7c538499`, workspace `w1`.
- Host tab/pane: `wQ:tH` / `wQ:pJ`.
- Lead pane: `w1:p1`, PID `1546105`, lead session `01a0faa0-d94f-735d-b075-b49f92727559`.
- Worker pane: `w1:p2`, PID `1548368`, worker session above.
- Lead transcript: `/tmp/hs-final-smoke/pi-sessions/2026-10-02T03-20-40-527Z_01a0faa0-d94f-735d-b075-b49f92727559.jsonl`.
- Worker transcript: `/tmp/hs-final-smoke/pi-sessions/2026-10-02T03-21-00-759Z_01a0faa1-2857-7744-adf4-212b09731b91.jsonl`.

No agent-owned live-smoke continuation is planned under the revised acceptance decision. Keep this checkpoint available for the user's runtime validation or owner-guarded cleanup. Revalidate the recorded experiment/session identities before using them. Preserve the completed scenarios; do not rebuild the implementation or rerun valid models merely to recreate reporting. Cleanup must follow the installed Herdr skill's ownership and atomic identity/state guards; no unconditional close of a reused pane or another session's resources.

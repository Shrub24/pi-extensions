# Managed worker startup probe

Result: **startup confirmed** — the task was accepted and this artifact was written
by the managed worker itself.

Probe observed at: 2026-10-05T12:45:34Z (first shell command executed by the worker).

## Identity

| Field | Value | Source |
| --- | --- | --- |
| Pi session id | `01a10c18-e0dc-7459-925e-3dd377f53cef` | `PI_SESSION_ID`, `PI_BG_SESSION`, `PI_INTERCOM_SESSION_ID` (all three agree) |
| Pi session file | `/home/saurabhj/.pi/agent/sessions/--home-saurabhj-Projects-dev-custom-pi-extensions--/2026-10-05T12-45-19-452Z_01a10c18-e0dc-7459-925e-3dd377f53cef.jsonl` | `PI_SESSION_FILE` |
| Herdr pane id | `wQ:pT` | `HERDR_PANE_ID` |
| Herdr tab id | `wQ:tD` | `HERDR_TAB_ID` |
| Herdr workspace id | `wQ` | `HERDR_WORKSPACE_ID`, `PI_HERDSMAN_WORKSPACE_ID` |
| Herdr env marker | `1` | `HERDR_ENV` |
| Owner (lead) session id | `01a0ff9d-d487-7553-8c69-967c040d82cc` | `PI_HERDSMAN_OWNER_SESSION_ID`, `PI_SUBAGENT_PARENT_SESSION` |
| Herdsman run id | `6635f270-280b-42f3-b920-0f92f3062356` | `PI_HERDSMAN_RUN_ID` |
| Herdsman label | `startup-probe` | `PI_HERDSMAN_LABEL` |
| Agent definition | `worker` | `PI_HERDSMAN_AGENT_DEFINITION` |
| Brief profile | `execution` | `PI_HERDSMAN_BRIEF_PROFILE` |
| Model / provider | `coder-high` / `omniroute` | `PI_MODEL`, `PI_PROVIDER` |
| Managed-child markers | `PI_SUBAGENT_CHILD=1`, `PI_CODING_AGENT=true`, `AI_AGENT=pi` | environment |

## Startup evidence

1. The worker process exists with the managed-worker environment above; the session
   id is shared consistently across the herdsman, background-task and intercom
   channels, and the pane/tab ids resolve to the same Herdr workspace `wQ`.
2. `PI_CODING_AGENT=true` with `PI_SUBAGENT_CHILD=1` identifies this as a managed
   Pi child rather than a top-level interactive session.
3. The parent/owner session (`01a0ff9d…`) differs from this worker's session
   (`01a10c18…`), confirming a delegated child rather than the lead process itself.
4. The session file name prefix `2026-10-05T12-45-19-452Z` places worker startup at
   12:45:19Z; the first probe command ran at 12:45:34Z — the worker was live and
   executing within ~15s of session creation.
5. The workspace started with no `.pi-herdsman/` directory present, and this file is
   the worker's own first write into it — the worker has real write access to the
   project tree.

## Scope note

Verification-only run: no product source, VCS state, pane-facts implementation or
delegation was touched. This file is the sole artifact.

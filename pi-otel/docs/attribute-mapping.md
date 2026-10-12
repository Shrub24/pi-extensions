# Attribute mapping: pi-otel to Langfuse and Latitude

This file is the contract between the exporter (`pi-otel`) and the collector
(`nix-homelab`, `modules/flake/telemetry.nix`). Source of truth: the constants
in `src/attrs.ts` and the writers in `src/tracker.ts`. Function names are given
instead of line numbers, which drift.

## Ownership

- **pi-otel** emits canonical `gen_ai.*` and `pi.*` fields, plus the vendor-native
  keys listed under "Vendor-native keys". It does not dedupe per destination.
- **The collector** selects, copies, renames and deletes fields per destination
  with OTTL. It contains no dedup logic and no conditional business logic.

## Canonical fields

These are sent to every destination.

**gen_ai.\* span attributes**

- Operation and model: `gen_ai.operation.name` (`chat`, `invoke_agent`,
  `execute_tool`), `gen_ai.provider.name`, `gen_ai.request.model`,
  `gen_ai.response.model`, `gen_ai.response.id`, `gen_ai.response.finish_reasons`,
  `gen_ai.request.stream`, `gen_ai.response.time_to_first_chunk`, `gen_ai.agent.name`
- Correlation: `gen_ai.conversation.id` (equal to the Pi session id), `session.id`
- Usage: `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`,
  `gen_ai.usage.total_tokens`, `gen_ai.usage.cache_read.input_tokens`,
  `gen_ai.usage.cache_creation.input_tokens`, `gen_ai.usage.reasoning.output_tokens`,
  `gen_ai.usage.cost` (USD), `gen_ai.token.type`
- Legacy-dialect usage names (emitted only under the older dialect):
  `gen_ai.usage.cache_read_input_tokens`, `gen_ai.usage.cache_write_input_tokens`,
  `gen_ai.usage.cache_write_1h_input_tokens`, `gen_ai.usage.reasoning_tokens`
- Content: `gen_ai.input.messages`, `gen_ai.output.messages`,
  `gen_ai.system_instructions`, `gen_ai.tool.definitions`, `gen_ai.system.prompt.hash`
- Tools: `gen_ai.tool.name`, `gen_ai.tool.call.id`, `gen_ai.tool.call.arguments`,
  `gen_ai.tool.call.result`
- Legacy span events (events, not attributes): `gen_ai.user.message`,
  `gen_ai.tool.message`, `gen_ai.assistant.message`, `gen_ai.choice`,
  `gen_ai.first_token`, `gen_ai.completion`
- Errors: `error.type`, `exception.message`, `http.response.status_code`

**pi.\* span attributes**

- Run identity: `pi.run.kind`, `pi.agent.role`, `pi.agent.label`, `pi.agent.run_id`,
  `pi.agent.owner_session_id`, `pi.agent.workspace_id`
- Session: `pi.session.id`, `pi.session.name`, `pi.session.mode`, `pi.session.file`,
  `pi.session.reason`, `pi.session.parent_id`, `pi.session.compact`,
  `pi.session.start`, `pi.session.end`, `pi.cwd`
- Interaction and turn: `pi.interaction.id`, `pi.interaction.origin`,
  `pi.turn.index`, `pi.turn_count`, `pi.turn.count`, `pi.turn.cancellations`,
  `pi.tool_count`, `pi.error_count`, `pi.cancelled`, `pi.orphaned`
- Attempt: `pi.attempt.number`, `pi.attempt.reason`
- Prompt: `pi.user_prompt`, `pi.user_prompt_length`, `pi.prompt.count`, `pi.input`,
  `pi.input.image_count`, `pi.user_bash`, `pi.user_bash.cwd`,
  `pi.user_bash.exclude_from_context`
- Context and cache: `pi.context.tokens`, `pi.context.window`, `pi.context.percent`,
  `pi.cache.epoch`
- Route and pricing: `pi.route.virtual_model`, `pi.route.previous_model`,
  `pi.route.account_id`, `pi.route.transition_reason`, `pi.model.current`,
  `pi.model.previous`, `pi.model.source`, `pi.model.changed`,
  `pi.pricing.peak_multiplier`
- Tools: `pi.tool.is_error`, `pi.tool.duration_ms`, `pi.tool.calls`
- LLM timing and retries: `pi.llm_request`, `pi.llm_request.error`,
  `pi.llm.time_to_first_token`, `pi.llm.time_to_completion`, `pi.provider.retries`
- Compaction: `pi.compaction.reason`, `pi.compaction.will_retry`,
  `pi.compaction.tokens_before`, `pi.compaction.tokens_after`,
  `pi.compaction.from_extension`, `pi.compaction.count`
- Parent linkage: `pi.parent.trace_id`, `pi.parent.span_id`
- Message provenance: `pi.message.source`, `pi.message.index`, `pi.message.details`
- Self-test only: `pi.otel.self_test`, `pi.otel.self_test.event`, `pi.test`

**Metrics, not span attributes:** `gen_ai.client.operation.duration`,
`gen_ai.client.token.usage`, `gen_ai.client.operation.time_to_first_chunk`,
`pi.llm.time_to_first_token`, `pi.llm.time_to_completion`, `pi.tool.calls`,
`pi.session.duration`, `pi.prompt.count`, `pi.turn.count`, `pi.provider.retries`,
`pi.turn.cancellations`, `pi.compaction.count`.

## Vendor-native keys

Written by the tracker, in addition to the canonical fields.

### Langfuse

| Source | Langfuse key | Written in |
|---|---|---|
| `pi.session.name` | `langfuse.trace.name` | `commonAttrs` |
| `pi.run.kind`, `pi.session.mode`, `pi.agent.role`, `pi.agent.label` | `langfuse.trace.tags`: string array of `run-kind:…`, `mode:…`, `role:…`, `agent:…` | `commonAttrs` |
| `pi.run.kind`, `pi.session.mode`, `pi.session.name`, `pi.agent.role`, `pi.agent.label`, `pi.agent.run_id`, `pi.agent.owner_session_id`, `pi.agent.workspace_id` | `langfuse.trace.metadata.pi_run_kind`, `…pi_session_mode`, `…pi_session_name`, `…pi_agent_role`, `…pi_agent_label`, `…pi_agent_run_id`, `…pi_agent_owner_session_id`, `…pi_agent_workspace_id` (values cut to 256 characters) | `commonAttrs` |
| Span kind | `langfuse.observation.type`: interaction `agent`, attempt `span`, turn `chain`, LLM `generation`, compaction `span`, tool `tool` | `openInteraction`, `startAttempt`, `startTurn`, `openLlm`, `startCompaction`, `startTool` |
| LLM span: `gen_ai.system_instructions`, `gen_ai.input.messages`, `gen_ai.tool.definitions` | `langfuse.observation.input` = JSON `{system_instructions, messages, tools}`; prompt capture only | `writeLangfuseInput` |
| LLM span: `gen_ai.output.messages` | `langfuse.observation.output` (same JSON string) | `emitAssistantMessageEvents` |
| Interaction root: `pi.user_prompt` | `langfuse.observation.input` = `{messages:[{role:"user", parts:[…]}]}`; prompt capture only | `openInteraction` |
| Interaction root: final output | `langfuse.observation.output` | `endInteraction` |
| Tool span: `gen_ai.tool.call.arguments` | `langfuse.observation.input` (same value) | `startTool` |
| Tool span: `gen_ai.tool.call.result` | `langfuse.observation.output` (same value) | `endTool` |

### Latitude

| Source | Latitude key | Written in |
|---|---|---|
| Root span name (session name, else `pi.interaction`) | `latitude.capture.name` | `openInteraction` |
| Same tags as `langfuse.trace.tags` | `latitude.tags`: JSON string of the array | `commonAttrs` |
| Same fields as the Langfuse metadata row | `latitude.metadata`: JSON object string with dotted keys `pi.run.kind` … `pi.agent.workspace_id` (values cut to 256 characters) | `commonAttrs` |

Latitude has no vendor-only content keys. It reads the canonical `gen_ai.*`
input, output and system-instruction fields.

## Destination-exclusive keys

- **Langfuse only:** `langfuse.trace.name`, `langfuse.trace.tags`,
  `langfuse.trace.metadata.*`, `langfuse.observation.type`,
  `langfuse.observation.input`, `langfuse.observation.output`
- **Latitude only:** `latitude.capture.name`, `latitude.tags`, `latitude.metadata`
- **Shared and kept on both routes:** all canonical `gen_ai.*` and `pi.*` fields,
  `session.id`, `gen_ai.conversation.id`, `gen_ai.usage.cost`

## Duplicate content a route may drop

Each row carries the same content under two keys. The collector keeps the one the
destination reads and drops the other.

| Canonical key | Vendor duplicate | Destination that reads the vendor key |
|---|---|---|
| `gen_ai.input.messages` (LLM) | `langfuse.observation.input` `.messages` | Langfuse |
| `gen_ai.system_instructions` (LLM) | `langfuse.observation.input` `.system_instructions` | Langfuse |
| `gen_ai.tool.definitions` (LLM) | `langfuse.observation.input` `.tools` | Langfuse |
| `gen_ai.output.messages` (LLM) | `langfuse.observation.output`, and the root's output | Langfuse |
| `gen_ai.tool.call.arguments` | `langfuse.observation.input` (tool) | Langfuse |
| `gen_ai.tool.call.result` | `langfuse.observation.output` (tool) | Langfuse |
| `pi.user_prompt` (root) | `langfuse.observation.input` (root) | Langfuse |
| `pi.session.name` | `langfuse.trace.name`, `latitude.capture.name` | Langfuse and Latitude |
| — | `latitude.tags` duplicates `langfuse.trace.tags` | Latitude and Langfuse |
| — | `latitude.metadata` duplicates `langfuse.trace.metadata.*` (dotted and underscored key names) | Latitude and Langfuse |

## Current state

- **The exporter still emits every vendor-native key above.** Removing the
  duplicates from the exporter is gated on the collector transforms being
  committed and verified against both backends. Removing them first would strip
  Latitude tags and metadata and Langfuse observation input and output before the
  collector provides them.
- **Tool payloads are still clamped.** `gen_ai.tool.call.arguments`,
  `gen_ai.tool.call.result`, and the tool spans' `langfuse.observation.input` and
  `output` pass through `clampAttr`. Object payloads are serialized and then cut at
  64 KiB, so a truncated tool payload is invalid JSON. Structured fields on LLM and
  interaction spans are never truncated.

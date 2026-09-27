# OpenTelemetry Collector in front of pi-otel

pi-otel exports traces, metrics, and logs over OTLP. Point `OTEL_EXPORTER_OTLP_ENDPOINT` at a collector when you want batching, sampling, and redaction on your network before data reaches a hosted backend.

## Why run a collector

**Tail-sampling without starving interesting sessions.** The extension ships every span by default (`PI_OTEL_SAMPLE_RATIO` and `OTEL_TRACES_SAMPLER_ARG` default to 1.0). A collector tail-sampling processor keeps full traces when `error.type` is set on an LLM or tool span, when the session span reports `pi.error_count > 0`, or when `pi.turn_count` crosses your threshold, and drops most routine coding sessions with a low probabilistic rate.

**Redact prompt text at the gateway.** pi-otel can limit capture with `captureContent` (`metadata_only`, `no_tool_content`, `full`). A collector attributes or transform processor deletes `gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.tool.call.arguments`, and `gen_ai.tool.call.result` on the wire so prompt bodies never reach a SaaS ingest even if a project ships `full`.

**Batch and shape traffic to rate-limited ingest.** Agent sessions burst spans on every turn and tool call. The batch processor merges exports so your backend sees fewer, larger requests.

## Quick start (Docker Compose)

Configs live in [collector-configs/](collector-configs/).

```bash
cd docs/collector-configs
docker compose -f docker-compose.yaml up
```

Point pi at the collector HTTP receiver:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
pi
```

In pi, run `/otel-test`. Open Jaeger at http://localhost:16686 and search for service `pi` or `pi.otel.self_test`.

## Collector layout

The sample config in [otel-collector-config.yaml](collector-configs/otel-collector-config.yaml) uses the **contrib** collector image so the **tail_sampling** processor is available.

| Block | Role for pi-otel |
|--------|------------------|
| **receivers.otlp** | Listens on gRPC `4317` and HTTP `4318`, matching pi's default HTTP/protobuf export. |
| **memory_limiter** | Bounds RAM before tail sampling buffers incomplete traces. |
| **tail_sampling** | Decides keep/drop after spans finish; tuned for agent errors and long sessions. |
| **batch** | Groups OTLP payloads before the exporter. |
| **exporters.otlp** | Forwards to your backend (`backend:4317` in the sample; Jaeger in compose via a network alias). |
| **exporters.logging** | Prints a short line per batch to collector stdout (`verbosity: basic`) while you debug. |

Metrics and logs pipelines skip tail sampling in the sample. They still pass through `memory_limiter` and `batch`.

## Tail sampling for agent traces

pi-otel labels provider failures on LLM spans with `error.type` (`rate_limit`, `server_error`, `auth_error`, `timeout`, `request_too_large`, `client_error`, `content_filter`). Tool failures use `tool_error`. The sample policies keep traces when any of these match, when the session span carries `pi.error_count` at least 1, when `pi.turn_count` is at least 25, when a span name matches `pi.session*`, or with 10% probability otherwise.

Tail sampling waits for trace completion (`decision_wait` in the config, 15s in the sample). The collector holds spans in memory until the decision. Long turns or many parallel tools need a higher `decision_wait` and a larger `memory_limiter` limit.

Policy source is duplicated for reference in [tail-sampling.yaml](collector-configs/tail-sampling.yaml). Adjust `min_value` on `pi.turn_count` and `sampling_percentage` to match your ingest budget.

Official processor docs: [Tail sampling processor](https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/processor/tailsamplingprocessor).

## Redacting prompt content

Uncomment the `attributes/redact-prompts` processor in [otel-collector-config.yaml](collector-configs/otel-collector-config.yaml) and insert it in the traces pipeline after `tail_sampling` and before `batch`:

```yaml
processors: [memory_limiter, tail_sampling, attributes/redact-prompts, batch]
```

Active block:

```yaml
attributes/redact-prompts:
  actions:
    - key: gen_ai.input.messages
      action: delete
    - key: gen_ai.output.messages
      action: delete
    - key: gen_ai.tool.call.arguments
      action: delete
    - key: gen_ai.tool.call.result
      action: delete
```

Use `captureContent=metadata_only` in pi when you want the extension to avoid attaching raw payloads. Use the collector when you need an enforced drop for every project and exporter path.

## Sending to a hosted backend

Change the `otlp/backend` exporter endpoint to the platform OTLP URL. Set TLS and headers for auth:

```yaml
exporters:
  otlp/backend:
    endpoint: ingest.example.com:443
    headers:
      x-api-key: YOUR_KEY
    tls:
      insecure: false
```

The same pattern works for any OTLP-compatible host. Remove or disable the `logging` exporter in production if stdout noise matters.

For gRPC from pi, set `OTEL_EXPORTER_OTLP_PROTOCOL=grpc` and `OTEL_EXPORTER_OTLP_ENDPOINT=http://my-collector:4317`.

## Verification

1. Start the compose stack or your own collector with the sample config.
2. Export `OTEL_EXPORTER_OTLP_ENDPOINT` to the collector HTTP or gRPC port.
3. In pi, run `/otel-test` to emit one synthetic span, metric, and log record, then flush.
4. Check Jaeger (local), collector logging exporter output, or your vendor UI for service `pi` and span `pi.otel.self_test`.
5. Run `/otel-status` if export fails; it shows the last error per signal.

Trigger a real session and confirm long or failing sessions stay at full fidelity while short routine sessions mostly drop after you enable tail sampling.
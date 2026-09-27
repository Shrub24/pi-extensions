/**
 * Child process for the shutdown-exit test.
 *
 * Starts a real telemetry runtime against an OTLP endpoint that accepts the
 * connection and never responds, emits one span, and shuts down. The exporter
 * request timeout is 60s while the shutdown budget is 500ms: if shutdown does
 * not abort the in-flight export, the pending socket keeps this process's
 * event loop alive for the full 60s.
 *
 * There is intentionally NO process.exit() here: the process must exit by
 * draining its event loop, which is exactly what a pending export blocks.
 */

import { startRuntime } from "../../src/sdk.ts";
import { harnessConfig } from "../helpers.ts";

const port = process.env.PI_OTEL_TEST_SINK_PORT;
if (!port) throw new Error("PI_OTEL_TEST_SINK_PORT not set");

const endpoint = `http://127.0.0.1:${port}`;
const cfg = harnessConfig({
  protocol: "http/json",
  endpoint,
  tracesEndpoint: `${endpoint}/v1/traces`,
  metricsEndpoint: `${endpoint}/v1/metrics`,
  logsEndpoint: `${endpoint}/v1/logs`,
  metrics: { enabled: false },
  logs: { enabled: false },
  tracesExportTimeoutMs: 60_000,
  shutdownTimeoutMs: 500,
});

const rt = await startRuntime(cfg);
const span = rt.tracer.startSpan("shutdown-exit-probe");
span.end();
await rt.shutdown();
// No process.exit: the event loop must drain on its own.

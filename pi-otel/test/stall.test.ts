import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";

/**
 * Pin the contract that all three signal processors keep exporting across
 * windows, not just the first. The processors in scope are:
 *   BatchSpanProcessor            (traces)
 *   PeriodicExportingMetricReader (metrics)
 *   BatchLogRecordProcessor       (logs)
 *
 * A regression here leaves the per-signal export count at 1 (the initial
 * flush) while later data is never sent. These tests start a real
 * TelemetryRuntime against a loopback OTLP/HTTP sink, record telemetry
 * continuously, and count HTTP requests per signal across several windows.
 * The health counters (spansExported, metricBatchesExported,
 * logRecordsExported) double as an independent witness.
 */

const SINK_PORT = 14319; // distinct from e2e.test.ts (14318)
const ENDPOINT = `http://127.0.0.1:${SINK_PORT}`;

// Above config.ts MIN_EXPORT_INTERVAL_MS (100). Short enough that several
// windows fit inside the test budget.
const EXPORT_INTERVAL_MS = 200;

// How many windows to let pass before asserting. 4 windows at 200ms = 800ms,
// leaving slack for slow CI while still finishing in ~1.5s of active export.
const ASSERT_AFTER_MS = EXPORT_INTERVAL_MS * 4;

let server: Server;
const counts = { traces: 0, metrics: 0, logs: 0 };
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_METRIC_EXPORT_INTERVAL",
  "OTEL_TRACES_EXPORT_INTERVAL",
  "OTEL_LOGS_EXPORT_INTERVAL",
  "PI_OTEL_DISABLED",
] as const;

before(async () => {
  for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
  server = createServer((_req, res) => {
    // Count by signal path. Reply with HTTP 200 and an empty body so the
    // test exercises the deserialize-warning path in otlp-exporter-base:
    // an empty response body is spec-compliant but yields no JSON to parse.
    const url = _req.url ?? "";
    if (url.endsWith("/v1/traces")) counts.traces++;
    else if (url.endsWith("/v1/metrics")) counts.metrics++;
    else if (url.endsWith("/v1/logs")) counts.logs++;
    // Drain the request so the exporter's keep-alive socket is released.
    _req.resume();
    res.writeHead(200, { "Content-Type": "application/x-protobuf", Connection: "close" });
    res.end(Buffer.alloc(0));
  });
  await new Promise<void>((resolve) => server.listen(SINK_PORT, "127.0.0.1", resolve));
});

after(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function resetCounts() {
  counts.traces = 0; counts.metrics = 0; counts.logs = 0;
}

function stallConfig() {
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = ENDPOINT;
  process.env.OTEL_METRIC_EXPORT_INTERVAL = String(EXPORT_INTERVAL_MS);
  process.env.OTEL_TRACES_EXPORT_INTERVAL = String(EXPORT_INTERVAL_MS);
  process.env.OTEL_LOGS_EXPORT_INTERVAL = String(EXPORT_INTERVAL_MS);
  return {
    ...resolveConfig("/stall"),
    // Pin short intervals directly so the test does not depend on env parsing.
    metricExportInterval: EXPORT_INTERVAL_MS,
    tracesExportInterval: EXPORT_INTERVAL_MS,
    logsExportInterval: EXPORT_INTERVAL_MS,
  };
}

import { resolveConfig } from "../src/config.js";
import { startRuntime, type TelemetryRuntime } from "../src/sdk.js";
import { emitLog } from "../src/logging.js";

/** Record one unit of telemetry on each signal. */
function recordOnce(rt: TelemetryRuntime, i: number) {
  // Trace: a fresh span per call so the BatchSpanProcessor buffer is non-empty.
  const span = rt.tracer.startSpan(`pi.stall_probe`);
  span.setAttribute("probe.i", i);
  span.end();

  // Metric: counter add + histogram record give the periodic reader data to
  // export on every tick.
  rt.metrics?.toolCalls.add(1, { "probe.i": i });
  rt.metrics?.tokenUsage.record(i + 1, { "gen_ai.usage.token.type": "output" });

  // Log: a fresh record per call so the BatchLogRecordProcessor buffer is non-empty.
  emitLog(rt.logger, "pi.stall_probe", "info", `probe ${i}`, { "probe.i": i });
}

describe("periodic export does not stall after the first batch", () => {
  test("all three signals keep exporting across multiple windows", async () => {
    resetCounts();
    const cfg = stallConfig();
    const rt = await startRuntime(cfg);
    try {
      // Record continuously across ASSERT_AFTER_MS so each signal's processor
      // has fresh data on every tick. setInterval(5ms) keeps the event loop
      // honest; the unreffed SDK timers fire on top of it.
      let i = 0;
      const iv = setInterval(() => recordOnce(rt, i++), 5);
      // unref our own timer so it cannot keep the process alive on its own;
      // the SDK timers are what we are exercising.
      iv.unref?.();
      await new Promise((r) => setTimeout(r, ASSERT_AFTER_MS));
      clearInterval(iv);

      // Each signal must have produced more than one export. A stall leaves
      // the count at exactly 1 (the initial flush) for traces/metrics.
      assert.ok(
        counts.traces >= 2,
        `traces exported ${counts.traces} times (expected >= 2): BatchSpanProcessor stalled`,
      );
      assert.ok(
        counts.metrics >= 2,
        `metrics exported ${counts.metrics} times (expected >= 2): PeriodicExportingMetricReader stalled`,
      );
      assert.ok(
        counts.logs >= 2,
        `logs exported ${counts.logs} times (expected >= 2): BatchLogRecordProcessor stalled`,
      );

      // The health counters are the repo's own stall-detection surface
      // (/otel-status). They must climb in lockstep with the HTTP counts.
      assert.ok(rt.health.spansExported >= 2, `health.spansExported=${rt.health.spansExported}`);
      assert.ok(rt.health.metricBatchesExported >= 2, `health.metricBatchesExported=${rt.health.metricBatchesExported}`);
      assert.ok(rt.health.logRecordsExported >= 2, `health.logRecordsExported=${rt.health.logRecordsExported}`);

      // And no signal recorded an export error.
      assert.equal(rt.health.tracesError, undefined, "no traces export error");
      assert.equal(rt.health.metricsError, undefined, "no metrics export error");
      assert.equal(rt.health.logsError, undefined, "no logs export error");
    } finally {
      await rt.shutdown();
    }
  });

  test("empty-body 200 response does not strand the metric reader or span processor", async () => {
    // The sink replies with HTTP 200 + empty body (Content-Length: 0). In
    // otlp-exporter-base that triggers a non-fatal deserialize warning but the
    // export must still resolve SUCCESS. This test confirms the callback fires
    // so the processors never get stuck waiting on a response that already
    // arrived: counts keep climbing well past the first export.
    resetCounts();
    const cfg = stallConfig();
    const rt = await startRuntime(cfg);
    try {
      const before = { ...counts };
      let i = 0;
      const iv = setInterval(() => recordOnce(rt, i++), 5);
      iv.unref?.();
      await new Promise((r) => setTimeout(r, ASSERT_AFTER_MS));
      clearInterval(iv);

      // Every signal advanced past its first export despite the empty body.
      assert.ok(counts.metrics > before.metrics + 1, "metric reader advanced past first export");
      assert.ok(counts.traces > before.traces + 1, "span processor advanced past first export");
      assert.ok(counts.logs > before.logs + 1, "log processor advanced past first export");
    } finally {
      await rt.shutdown();
    }
  });

  test("metrics keep ticking even when the SDK timers are the only handles", async () => {
    // The unref() call on the flush/interval timers means they will not
    // keep the event loop alive on their own. This test holds the loop alive
    // with a single ref'd timer (no busy setInterval) and confirms the
    // unreffed SDK timers still fire alongside it.
    resetCounts();
    const cfg = stallConfig();
    const rt = await startRuntime(cfg);
    try {
      // One ref'd timer advances the clock. We record metrics inside it so the
      // reader has data each tick, but we do NOT keep the loop busy.
      let i = 0;
      await new Promise((resolve) => {
        const refd = setInterval(() => {
          rt.metrics?.toolCalls.add(1, { "probe.i": i++ });
          rt.metrics?.tokenUsage.record(1, { "gen_ai.usage.token.type": "input" });
          if (i >= 8) { clearInterval(refd); resolve(undefined); }
        }, Math.floor(EXPORT_INTERVAL_MS / 2));
      });
      // Let one more window fire to flush the last batch.
      await new Promise((r) => setTimeout(r, EXPORT_INTERVAL_MS * 2));

      assert.ok(counts.metrics >= 2, `metrics ticked ${counts.metrics} times under a ref'd timer (expected >= 2)`);
    } finally {
      await rt.shutdown();
    }
  });
});


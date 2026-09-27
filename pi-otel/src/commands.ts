/**
 * Slash commands: /otel-status, /otel-flush, /otel-test.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TelemetryRuntime } from "./sdk.js";
import { SeverityNumber } from "@opentelemetry/api-logs";
import { emitLog } from "./logging.js";
import { extensionVersion } from "./version.js";

/** Structural tracker surface the status command needs (avoids a tracker import). */
type TraceIdSource = { activeTraceId(): string | undefined };

export function registerCommands(
  pi: ExtensionAPI,
  getRuntime: () => TelemetryRuntime | null,
  getTracker: () => TraceIdSource | null = () => null,
): void {
  // console.log in print mode, ctx.ui.notify when a dialog-capable UI
  // exists (TUI and rpc). In json mode stdout is the JSON-lines event stream,
  // so the fallback writes to stderr instead of interleaving a non-event
  // line a strict consumer would reject.
  const notify = (ctx: ExtensionContext, msg: string, level: "info" | "warning"): void => {
    if (ctx.hasUI) {
      ctx.ui.notify(msg, level);
    } else if (ctx.mode === "json") {
      console.error(`${level.toUpperCase()}: ${msg}`);
    } else {
      console.log(`${level.toUpperCase()}: ${msg}`);
    }
  };
  pi.registerCommand("otel-status", {
    description: "Show pi-otel configuration and export health",
    handler: async (_args, ctx: ExtensionContext) => {
      const rt = getRuntime();
      if (!rt) {
        notify(ctx, "pi-otel: disabled (no telemetry runtime)", "warning");
        return;
      }
      const c = rt.config;
      const h = rt.health;
      const traceId = getTracker()?.activeTraceId();
      const lines = [
        `enabled            ${c.enabled}`,
        `endpoint           ${c.endpoint}`,
        `traces             ${c.traces.enabled ? c.tracesEndpoint : "(off)"}${h.tracesError ? `  ERROR: ${h.tracesError}` : ""}`,
        `traces exporters   ${c.tracesExporters.join(",")}`,
        `metrics            ${c.metrics.enabled ? c.metricsEndpoint : "(off)"}${h.metricsError ? `  ERROR: ${h.metricsError}` : ""}`,
        `metrics exporters  ${c.metricsExporters.join(",")}`,
        `logs               ${c.logs.enabled ? c.logsEndpoint : "(off)"}${h.logsError ? `  ERROR: ${h.logsError}` : ""}`,
        `logs exporters     ${c.logsExporters.join(",")}`,
        `protocol           ${c.protocol}`,
        `service.name       ${c.serviceName}`,
        `captureContent     ${c.captureContent}`,
        `semconv            ${c.semconv}`,
        `sampleRatio        ${c.sampleRatio}`,
        `active trace id    ${traceId || "(none)"}`,
        `shutdown timeout   ${c.shutdownTimeoutMs}`,
        `spans accepted     ${h.spansAccepted}`,
        `exported spans     ${h.spansExported}${h.spansAccepted > h.spansExported ? `  (${h.spansAccepted - h.spansExported} unexported)` : ""}`,
        `metric batches     ${h.metricBatchesExported}`,
        `logs accepted      ${h.logRecordsAccepted}`,
        `log records        ${h.logRecordsExported}${h.logRecordsAccepted > h.logRecordsExported ? `  (${h.logRecordsAccepted - h.logRecordsExported} unexported)` : ""}`,
        `last shutdown err  ${h.lastShutdownError ?? "(none)"}`,
      ];
      const text = lines.join("\n");
      notify(ctx, text, "info");
    },
  });

  pi.registerCommand("otel-flush", {
    description: "Force-flush pending OTel telemetry",
    handler: async (_args, ctx: ExtensionContext) => {
      const rt = getRuntime();
      if (!rt) {
        notify(ctx, "pi-otel: disabled", "warning");
        return;
      }
      await rt.flush();
      notify(ctx, "pi-otel: flushed", "info");
    },
  });

  pi.registerCommand("otel-test", {
    description: "Emit a synthetic span, metric, and log to verify the pipeline",
    handler: async (_args, ctx: ExtensionContext) => {
      const rt = getRuntime();
      if (!rt) {
        notify(ctx, "pi-otel: disabled", "warning");
        return;
      }
      const c = rt.config;
      // Snapshot counts by value: exporter callbacks mutate the live health
      // object during the flush, so a reference copy would zero the deltas.
      const h0 = {
        spansExported: rt.health.spansExported,
        metricBatchesExported: rt.health.metricBatchesExported,
        logRecordsExported: rt.health.logRecordsExported,
      };
      // --- Trace ---
      if (c.traces.enabled) {
        const span = rt.tracer.startSpan("pi.otel.self_test", {
          attributes: { "pi.test": true },
        });
        span.addEvent("pi.otel.self_test.event", { note: "synthetic" });
        span.end();
      }
      // --- Metric ---
      if (c.metrics.enabled) {
        // Use the meter via the runtime's provider so it lands in the right exporter.
        const meter = rt.meterProvider?.getMeter("pi-otel", extensionVersion());
        const counter = meter?.createCounter("pi.otel.self_test", {
          description: "pi-otel self-test counter",
          unit: "{event}",
        });
        counter?.add(1, { source: "otel-test" });
      }
      // --- Log ---
      // Explicit user action: emit regardless of selfLogs so the self-test
      // always exercises all enabled signals.
      if (c.logs.enabled && rt.logger) {
        emitLog(rt.logger, "pi.otel.self_test", SeverityNumber.INFO, "pi-otel self-test log record", {
          "pi.test": true,
        });
      }
      await rt.flush();
      // Report what actually shipped, not just what was emitted: read the
      // export counters around the flush so a dead endpoint is visible here.
      const h = rt.health;
      const shipped = `spans +${h.spansExported - h0.spansExported}, metric batches +${h.metricBatchesExported - h0.metricBatchesExported}, log records +${h.logRecordsExported - h0.logRecordsExported}`;
      const errors = [
        h.tracesError ? `traces: ${h.tracesError}` : null,
        h.metricsError ? `metrics: ${h.metricsError}` : null,
        h.logsError ? `logs: ${h.logsError}` : null,
      ].filter((e): e is string => e !== null);
      const ok = c.traces.enabled || c.metrics.enabled || c.logs.enabled;
      if (!ok) {
        notify(ctx, "pi-otel: all signals disabled", "warning");
        return;
      }
      if (errors.length > 0) {
        notify(ctx, `pi-otel: self-test flushed (${shipped}) with export errors: ${errors.join("; ")}`, "warning");
      } else {
        notify(ctx, `pi-otel: self-test flushed (${shipped}). Check your backend.`, "info");
      }
    },
  });
}


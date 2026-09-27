import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { trace, metrics, diag, DiagLogLevel } from "@opentelemetry/api";
import { logs as logsApi } from "@opentelemetry/api-logs";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  InMemorySpanExporter,
  type ReadableSpan,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { InMemoryLogRecordExporter } from "@opentelemetry/sdk-logs";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  shutdownProviders,
  startRuntime,
  detectHostId,
  resolveMetricTemporalityPreference,
  installSignalShutdown,
  buildSampler,
  effectiveExporterTokens,
  boundedExportTimeout,
  grpcMetadataFromHeaders,
  piAtLeast,
  processOwner,
  piVersion,
  type ExportHealth,
} from "../src/sdk.ts";

describe("pi version detection", () => {
  test("piVersion returns a parseable semver string", () => {
    const v = piVersion();
    assert.match(v, /^\d+\.\d+\.\d+/, "semver major.minor.patch prefix");
  });

  test("piAtLeast compares major, minor, and patch in order", () => {
    assert.equal(piAtLeast("0.80.5", "0.80.5"), true, "equal versions satisfy the floor");
    assert.equal(piAtLeast("0.80.5", "0.80.4"), false, "patch below the floor");
    assert.equal(piAtLeast("0.80.5", "0.81.0"), true, "minor above the floor");
    assert.equal(piAtLeast("0.80.5", "1.0.0"), true, "major above the floor");
    assert.equal(piAtLeast("0.80.5", "0.9.0"), false, "minor compared numerically: 9 < 80");
    assert.equal(piAtLeast("0.80.5", "0.80.10"), true, "patch compared numerically, not lexically");
  });

  test("piAtLeast treats malformed versions as older than everything", () => {
    assert.equal(piAtLeast("0.80.5", "unknown"), false);
    assert.equal(piAtLeast("0.80.5", ""), false);
    assert.equal(piAtLeast("0.80.5", "not.a.version"), false);
  });

  test("piAtLeast ignores prerelease suffixes", () => {
    assert.equal(piAtLeast("0.80.5", "0.80.6-beta.1"), true);
    assert.equal(piAtLeast("0.80.5", "0.80.5-rc.2"), true);
  });
});
import { AggregationTemporalityPreference } from "@opentelemetry/exporter-metrics-otlp-http";
import { resolveConfig } from "../src/config.ts";

/**
 * SDK lifecycle tests: startRuntime/shutdown behavior, idempotency, and the
 * critical "no global provider registration" property that lets pi-otel
 * survive /reload and session replacement.
 */

let savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_EXPORTER_OTLP_PROTOCOL",
  "PI_OTEL_ENABLED", "PI_OTEL_TRACES", "PI_OTEL_METRICS", "PI_OTEL_LOGS",
  "OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE",
] as const;

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

// Use a configurable endpoint so exporters don't actually try a real host.
function cfg(overrides: Record<string, unknown> = {}) {
  return { ...resolveConfig("/test"), endpoint: "http://127.0.0.1:9", ...overrides } as ReturnType<typeof resolveConfig>;
}

describe("startRuntime", () => {
  test("returns a runtime with all three providers when enabled", async () => {
    const rt = await startRuntime(cfg());
    try {
      assert.ok(rt.traceProvider, "trace provider present");
      assert.ok(rt.meterProvider, "meter provider present");
      assert.ok(rt.loggerProvider, "logger provider present");
      assert.ok(rt.tracer, "tracer present");
      assert.ok(rt.metrics, "metrics bound to this runtime");
      assert.ok(rt.logger, "logger bound to this runtime");
      assert.ok(typeof rt.flush === "function");
      assert.ok(typeof rt.shutdown === "function");
    } finally {
      await rt.shutdown();
    }
  });

  test("a malformed traces endpoint fails that signal alone, not the runtime", async () => {
    // The exporter constructor throws on an unparseable URL. That must land
    // on health.tracesError with metrics and logs still live.
    const rt = await startRuntime(cfg({
      tracesEndpoint: "not a url at all",
      metricsEndpoint: "http://127.0.0.1:9/v1/metrics",
      logsEndpoint: "http://127.0.0.1:9/v1/logs",
    }));
    try {
      assert.ok(rt.health.tracesError?.includes("Could not parse"), "construction error surfaced");
      assert.equal(rt.health.metricsError, undefined, "metrics unaffected");
      assert.equal(rt.health.logsError, undefined, "logs unaffected");
      assert.ok(rt.meterProvider, "meter provider still built");
      assert.ok(rt.loggerProvider, "logger provider still built");
    } finally {
      await rt.shutdown();
    }
  });

  test("all three endpoints malformed still yields a usable runtime", async () => {
    const rt = await startRuntime(cfg({
      tracesEndpoint: "not a url",
      metricsEndpoint: "also not a url",
      logsEndpoint: "still not a url",
    }));
    try {
      assert.ok(rt.health.tracesError && rt.health.metricsError && rt.health.logsError);
      assert.ok(rt.tracer, "no-op tracer available");
      assert.equal(rt.metrics, null, "no metrics instruments");
      assert.equal(rt.logger, null, "no logger");
    } finally {
      await rt.shutdown();
    }
  });

  test("json mode strips console exporters through startRuntime wiring", async () => {
    // hasUI is false in json mode; the mode flag must still suppress console
    // output so span JSON cannot interleave with the json-mode event stream.
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.join(" ")); };
    let rt;
    try {
      rt = await startRuntime(cfg({ tracesExporters: ["console"] }), { hasUI: false, mode: "json" });
      const span = rt.tracer.startSpan("json-mode-leak-check");
      span.end();
      await rt.flush();
      assert.ok(!logs.some((l) => l.includes("json-mode-leak-check")), "no console span output in json mode");
      assert.ok(rt.traceProvider, "provider built from the otlp fallback");
    } finally {
      console.log = orig;
      await rt?.shutdown();
    }
  });

  test("grpc protocol with headers constructs exporters without errors", async () => {
    // Exercises the headers -> grpc Metadata translation through the real
    // construction path (the grpc exporters reject plain `headers` config by
    // type and ignored it by behavior before the fix).
    const rt = await startRuntime(cfg({
      protocol: "grpc",
      endpoint: "127.0.0.1:9",
      tracesEndpoint: "127.0.0.1:9",
      metricsEndpoint: "127.0.0.1:9",
      logsEndpoint: "127.0.0.1:9",
      headers: { "x-api-key": "test" },
    }));
    try {
      assert.equal(rt.health.tracesError, undefined, "traces exporter built");
      assert.equal(rt.health.metricsError, undefined, "metrics exporter built");
      assert.equal(rt.health.logsError, undefined, "logs exporter built");
    } finally {
      await rt.shutdown();
    }
  });

  test("omits trace provider when traces disabled", async () => {
    const rt = await startRuntime(cfg({ traces: { enabled: false } }));
    try {
      assert.equal(rt.traceProvider, undefined);
      assert.ok(rt.meterProvider, "metrics still on");
      assert.ok(rt.loggerProvider, "logs still on");
    } finally {
      await rt.shutdown();
    }
  });

  test("omits all providers when master-enabled is false", async () => {
    const rt = await startRuntime(cfg({ enabled: false }));
    try {
      assert.equal(rt.traceProvider, undefined);
      assert.equal(rt.meterProvider, undefined);
      assert.equal(rt.loggerProvider, undefined);
      assert.equal(rt.metrics, null, "no metrics without a meter provider");
      assert.equal(rt.logger, null, "no logger without a logger provider");
      // tracer still returned (no-op) so callers don't have to branch
      assert.ok(rt.tracer);
      // no-op span methods must be safe to call
      const span = rt.tracer.startSpan("disabled");
      assert.equal(span.isRecording(), false);
      span.setAttribute("k", "v");
      span.addEvent("e");
      span.updateName("x");
      span.end();
    } finally {
      await rt.shutdown();
    }
  });
});

describe("shutdown", () => {
  test("is idempotent (second call does not throw)", async () => {
    const rt = await startRuntime(cfg());
    await rt.shutdown();
    await assert.doesNotReject(() => rt.shutdown());
  });

  test("flush completes without error even with no collector", async () => {
    const rt = await startRuntime(cfg());
    try {
      // flush against a dead endpoint; must not reject
      await assert.doesNotReject(() => rt.flush());
    } finally {
      await rt.shutdown();
    }
  });

  test("shutdown completes even against a dead endpoint (best-effort)", async () => {
    const rt = await startRuntime(cfg());
    await assert.doesNotReject(() => rt.shutdown());
  });

  test("shutdown returns within shutdownTimeoutMs against a hanging collector", async () => {
    // Simulate a dead collector with an in-process exporter whose export()
    // never invokes its callback. This is exactly what a TCP listener that
    // accepts but never responds looks like from the SDK's side: the
    // BatchSpanProcessor's forceFlush/shutdown awaits the export result
    // forever. We avoid a real socket here because the OTLP HTTP exporter's
    // keep-alive agent holds the client-side socket in its pool after the
    // timeout fires, keeping the test process alive on teardown.
    const hangingExporter: SpanExporter = {
      export(_spans: ReadableSpan[], _cb: (r: { code: number }) => void): void {
        // deliberately never call the callback: simulates a hung collector.
      },
      async shutdown(): Promise<void> {
        // The exporter itself shuts down fine; the hang is in export() above.
        // (BatchSpanProcessor.forceFlush is what blocks on the never-called cb.)
      },
    };
    const traceProvider = new BasicTracerProvider({
      resource: resourceFromAttributes({ "service.name": "pi-test" }),
      spanProcessors: [
        // exportTimeoutMillis bounds the BatchSpanProcessor's own internal
        // export-wait timer (which is a referenced timer in the SDK). We set it
        // just above shutdownTimeoutMs so our shutdown race is what fires first
        // (proving the timeout path), while the processor's timer still settles
        // shortly after so the test process exits without hanging on it.
        new BatchSpanProcessor(hangingExporter, { exportTimeoutMillis: 600 }),
      ],
    });
    // End a span so the batch processor has pending work to flush on shutdown;
    // otherwise forceFlush/shutdown complete instantly with nothing to export.
    const span = traceProvider.getTracer("pi-otel-test", "0.0.0").startSpan("hang.test");
    span.end();

    const health: ExportHealth = { spansAccepted: 0, spansExported: 0, logRecordsAccepted: 0, metricBatchesExported: 0, logRecordsExported: 0 };
    const timeoutMs = 400;
    const start = Date.now();
    await shutdownProviders(traceProvider, undefined, undefined, timeoutMs, health);
    const elapsed = Date.now() - start;
    // Returns within the budget (not the full 2000ms default) and the timeout
    // fired at roughly shutdownTimeoutMs.
    assert.ok(elapsed < 2000, `shutdown should respect the timeout, took ${elapsed}ms`);
    assert.ok(elapsed >= timeoutMs, `shutdown should have waited for the timeout, took ${elapsed}ms`);
    assert.ok(health.lastShutdownError, "lastShutdownError should be set when the timeout fires");
    assert.match(health.lastShutdownError!, /timeout/i);
  });
});

describe("no global registration (survives /reload)", () => {
  test("does not register a global tracer provider", async () => {
    // Capture the global tracer provider reference before start; it must be
    // the same (no-op) provider after start as before.
    const before = trace.getTracerProvider();
    const rt = await startRuntime(cfg());
    try {
      assert.equal(trace.getTracerProvider(), before, "global tracer provider unchanged");
    } finally {
      await rt.shutdown();
    }
    assert.equal(trace.getTracerProvider(), before, "still unchanged after shutdown");
  });

  test("does not register a global meter provider", async () => {
    const before = metrics.getMeterProvider();
    const rt = await startRuntime(cfg());
    try {
      assert.equal(metrics.getMeterProvider(), before);
    } finally {
      await rt.shutdown();
    }
  });

  test("does not register a global logger provider", async () => {
    const before = logsApi.getLoggerProvider();
    const rt = await startRuntime(cfg());
    try {
      assert.equal(logsApi.getLoggerProvider(), before);
    } finally {
      await rt.shutdown();
    }
  });

  test("two sequential runtimes do not interfere (reload simulation)", async () => {
    const before = trace.getTracerProvider();
    const rt1 = await startRuntime(cfg());
    await rt1.shutdown();
    const rt2 = await startRuntime(cfg());
    try {
      assert.equal(trace.getTracerProvider(), before, "global still not set after rt1+rt2");
      assert.ok(rt2.traceProvider, "rt2 has its own provider");
    } finally {
      await rt2.shutdown();
    }
  });
});

describe("resource", () => {
  test("resource carries service.name and pi.cwd", async () => {
    const rt = await startRuntime(cfg());
    try {
      const resource = (rt.traceProvider as unknown as { _resource: { attributes: Record<string, unknown> } })._resource;
      const attrs = resource.attributes;
      assert.equal(attrs["service.name"], "pi");
      assert.equal(attrs["pi.cwd"], "/test");
    } finally {
      await rt.shutdown();
    }
  });
});

describe("diag routing", () => {
  const silence = () =>
    diag.setLogger(
      { verbose() {}, debug() {}, info() {}, warn() {}, error() {} },
      { logLevel: DiagLogLevel.NONE, suppressOverrideMessage: true },
    );

  test("diagLogLevel WARN routes warn to stderr and filters debug", async () => {
    const lines: string[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => { lines.push(args.join(" ")); };
    try {
      const rt = await startRuntime(cfg({ diagLogLevel: DiagLogLevel.WARN }));
      diag.warn("warned-through");
      diag.debug("debug-filtered");
      await rt.shutdown();
    } finally {
      console.error = orig;
      silence();
    }
    assert.ok(lines.some((l) => l.includes("warned-through")), "warn reaches stderr");
    assert.ok(!lines.some((l) => l.includes("debug-filtered")), "debug filtered by level");
  });

  test("default diagLogLevel NONE emits nothing", async () => {
    const lines: string[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => { lines.push(args.join(" ")); };
    try {
      const rt = await startRuntime(cfg());
      diag.error("error-suppressed");
      await rt.shutdown();
    } finally {
      console.error = orig;
      silence();
    }
    assert.equal(lines.length, 0, "no diag output at NONE");
  });
});

describe("per-signal exporters", () => {
  test("multi-exporter traces: otlp+console yields two span processors", async () => {
    const origWrite = process.stdout.write.bind(process.stdout);
    const out: string[] = [];
    process.stdout.write = ((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    const rt = await startRuntime(cfg({ tracesExporters: ["otlp", "console"] }));
    try {
      assert.ok(rt.traceProvider, "trace provider present");
      const span = rt.tracer.startSpan("console-export-test");
      span.end();
      await rt.flush();
      const joined = out.join("");
      assert.match(joined, /console-export-test/);
    } finally {
      process.stdout.write = origWrite;
      await rt.shutdown();
    }
  });

  test("metrics console exporter does not throw", async () => {
    const rt = await startRuntime(cfg({ metricsExporters: ["console"] }));
    try {
      const meter = rt.meterProvider!.getMeter("pi-otel-test");
      const counter = meter.createCounter("test.counter");
      counter.add(1);
      await assert.doesNotReject(() => rt.meterProvider!.forceFlush());
    } finally {
      await rt.shutdown();
    }
  });

  test("none alone disables traces", async () => {
    const rt = await startRuntime(cfg({ tracesExporters: ["none"] }));
    try {
      assert.equal(rt.traceProvider, undefined);
      const span = rt.tracer.startSpan("noop-span");
      assert.ok(span);
      span.end();
    } finally {
      await rt.shutdown();
    }
  });

  test("console stripped in TUI mode, falls back to otlp", async () => {
    const rt = await startRuntime(cfg({ tracesExporters: ["console"] }), { hasUI: true });
    try {
      assert.ok(rt.traceProvider, "fell back to otlp trace provider");
      const span = rt.tracer.startSpan("tui-fallback");
      assert.ok(span);
      span.end();
    } finally {
      await rt.shutdown();
    }
  });

  test("startRuntime does not mutate OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE", async () => {
    delete process.env.OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE;
    const rt = await startRuntime(cfg());
    try {
      assert.equal(
        process.env.OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE,
        undefined,
        "process.env must stay untouched",
      );
    } finally {
      await rt.shutdown();
    }
  });

  test("startRuntime leaves a preset temporality env value alone", async () => {
    process.env.OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE = "CUMULATIVE";
    const rt = await startRuntime(cfg());
    try {
      assert.equal(process.env.OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE, "CUMULATIVE");
    } finally {
      await rt.shutdown();
    }
  });

  test("logsExportInterval is passed to BatchLogRecordProcessor", async () => {
    const rt = await startRuntime(cfg({ logsExportInterval: 1234 }));
    try {
      assert.ok(rt.loggerProvider, "logger provider present");
      // Walk the provider's shared state to the batch processor's delay. The
      // first processor is the counting wrapper; its `inner` is the batch one.
      const shared = (rt.loggerProvider as unknown as {
        _sharedState: {
          processors: Array<{ _scheduledDelayMillis?: number; inner?: { _scheduledDelayMillis?: number } }>;
        };
      })._sharedState;
      const delay = shared.processors[0]?.inner?._scheduledDelayMillis
        ?? shared.processors[0]?._scheduledDelayMillis;
      assert.equal(delay, 1234, "scheduledDelayMillis must match logsExportInterval");
    } finally {
      await rt.shutdown();
    }
  });
});

describe("processOwner", () => {
  test("returns the OS username when userInfo succeeds", () => {
    assert.equal(processOwner(() => ({ username: "stan" })), "stan");
  });

  test("returns unknown when userInfo throws (unregistered UID in a container)", () => {
    assert.equal(processOwner(() => { throw new Error("ENOENT: no such user"); }), "unknown");
  });

  test("returns unknown when username is missing", () => {
    assert.equal(processOwner(() => ({})), "unknown");
  });
});

describe("grpcMetadataFromHeaders", () => {
  test("converts plain headers into grpc Metadata", async () => {
    const metadata = await grpcMetadataFromHeaders({ "x-api-key": "secret", authorization: "Bearer tok" });
    const grpcjs = await import("@grpc/grpc-js");
    assert.ok(metadata instanceof grpcjs.Metadata, "grpc Metadata instance");
    assert.equal(metadata.get("x-api-key")[0], "secret");
    assert.equal(metadata.get("authorization")[0], "Bearer tok");
  });

  test("empty headers yield empty metadata", async () => {
    const metadata = await grpcMetadataFromHeaders({});
    assert.equal(metadata.get("x-api-key").length, 0);
  });
});

describe("boundedExportTimeout", () => {
  test("caps the exporter request timeout at the shutdown budget", () => {
    assert.equal(boundedExportTimeout(60_000, 2_000), 2_000);
    assert.equal(boundedExportTimeout(10_000, 2_000), 2_000);
  });

  test("keeps a shorter timeout unchanged", () => {
    assert.equal(boundedExportTimeout(500, 2_000), 500);
  });

  test("floors at 100ms so a zero shutdown budget cannot produce an invalid timeout", () => {
    assert.equal(boundedExportTimeout(10_000, 0), 100);
  });
});

describe("effectiveExporterTokens", () => {
  test("print mode keeps console exporters", () => {
    assert.deepEqual(
      effectiveExporterTokens(["otlp", "console"], false, "print"),
      ["otlp", "console"],
    );
    // No mode (older pi): hasUI alone decides.
    assert.deepEqual(effectiveExporterTokens(["console"], false, undefined), ["console"]);
  });

  test("TUI and rpc modes strip console via hasUI", () => {
    assert.deepEqual(effectiveExporterTokens(["otlp", "console"], true, "tui"), ["otlp"]);
    assert.deepEqual(effectiveExporterTokens(["otlp", "console"], true, "rpc"), ["otlp"]);
  });

  test("json mode strips console even though hasUI is false", () => {
    // pi's json mode streams session events as JSON lines on stdout; console
    // exporter output would interleave with that protocol stream.
    assert.deepEqual(effectiveExporterTokens(["otlp", "console"], false, "json"), ["otlp"]);
  });

  test("console-only configuration falls back to otlp when stripped", () => {
    assert.deepEqual(effectiveExporterTokens(["console"], true, "tui"), ["otlp"]);
    assert.deepEqual(effectiveExporterTokens(["console"], false, "json"), ["otlp"]);
  });

  test("order and dedupe are preserved by the caller's parse; stripping keeps order", () => {
    assert.deepEqual(effectiveExporterTokens(["console", "otlp", "none"], true, "tui"), ["otlp", "none"]);
  });
});

describe("resolveMetricTemporalityPreference", () => {
  test("defaults to DELTA when unset", () => {
    assert.equal(resolveMetricTemporalityPreference({}), AggregationTemporalityPreference.DELTA);
  });

  test("honors cumulative and lowmemory", () => {
    assert.equal(
      resolveMetricTemporalityPreference({ OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: "cumulative" }),
      AggregationTemporalityPreference.CUMULATIVE,
    );
    assert.equal(
      resolveMetricTemporalityPreference({ OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: "LOWMEMORY" }),
      AggregationTemporalityPreference.LOWMEMORY,
    );
  });

  test("unknown values fall back to DELTA", () => {
    assert.equal(
      resolveMetricTemporalityPreference({ OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: "nope" }),
      AggregationTemporalityPreference.DELTA,
    );
  });
});

// Re-exports used only for the type narrowing above.
void diag; void InMemorySpanExporter; void InMemoryLogRecordExporter;

describe("detectHostId", () => {
  test("returns a non-empty string", () => {
    const id = detectHostId();
    assert.ok(typeof id === "string");
    assert.ok(id.length > 0, "host id is non-empty");
  });

  test("on non-linux platforms it falls back to hostname", { skip: process.platform === "linux" }, () => {
    // On non-linux there is no machine-id file; the result must equal hostname().
    assert.equal(detectHostId(), require("node:os").hostname());
  });
});

describe("signal handler lifecycle", () => {
  test("shutdown removes the SIGTERM/SIGHUP handlers", async () => {
    // Baselines per signal: other libraries in the process (OTel SDK, node
    // itself) may own their own signal listeners, so only the delta this
    // runtime adds is asserted.
    const beforeT = process.listenerCount("SIGTERM");
    const beforeH = process.listenerCount("SIGHUP");
    const rt = await startRuntime(cfg());
    assert.equal(process.listenerCount("SIGTERM"), beforeT + 1, "SIGTERM handler registered");
    assert.equal(process.listenerCount("SIGHUP"), beforeH + 1, "SIGHUP handler registered");
    await rt.shutdown();
    assert.equal(process.listenerCount("SIGTERM"), beforeT, "SIGTERM handler removed on shutdown");
    assert.equal(process.listenerCount("SIGHUP"), beforeH, "SIGHUP handler removed on shutdown");
  });

  test("removeProcessHooks detaches without shutting down", async () => {
    const beforeT = process.listenerCount("SIGTERM");
    const beforeH = process.listenerCount("SIGHUP");
    const rt = await startRuntime(cfg());
    rt.removeProcessHooks();
    assert.equal(process.listenerCount("SIGTERM"), beforeT, "SIGTERM handler detached");
    assert.equal(process.listenerCount("SIGHUP"), beforeH, "SIGHUP handler detached");
    // flush still works after detaching (the runtime is not shut down).
    await rt.flush();
    await rt.shutdown();
  });

  test("repeated removeProcessHooks is a safe no-op", async () => {
    const rt = await startRuntime(cfg());
    rt.removeProcessHooks();
    rt.removeProcessHooks(); // must not throw
    await rt.shutdown();
  });
});

describe("installSignalShutdown", () => {
  interface Kill { pid: number; signal: string }
  function fakeProc() {
    const listeners = new Map<string, Array<() => void>>();
    const kills: Kill[] = [];
    const proc = {
      pid: 4242,
      on(sig: string, l: () => void) {
        (listeners.get(sig) ?? listeners.set(sig, []).get(sig)!).push(l);
      },
      removeListener(sig: string, l: () => void) {
        const arr = listeners.get(sig) ?? [];
        const i = arr.indexOf(l);
        if (i >= 0) arr.splice(i, 1);
      },
      listenerCount(sig: string) {
        return (listeners.get(sig) ?? []).length;
      },
      kill(pid: number, signal: string) {
        kills.push({ pid, signal });
      },
    };
    return {
      proc,
      kills,
      emit(sig: string) {
        for (const l of [...(listeners.get(sig) ?? [])]) l();
      },
    };
  }
  const settle = () => new Promise<void>((r) => setTimeout(r, 0));

  test("flushes and re-raises when it is the last handler", async () => {
    const f = fakeProc();
    let shutdowns = 0;
    installSignalShutdown(async () => { shutdowns++; }, f.proc);
    f.emit("SIGTERM");
    await settle();
    assert.equal(shutdowns, 1, "shutdown ran");
    assert.deepEqual(f.kills, [{ pid: 4242, signal: "SIGTERM" }], "signal re-raised to restore default termination");
    assert.equal(f.proc.listenerCount("SIGTERM"), 0, "listener removed");
  });

  test("does not re-raise when another handler owns the signal", async () => {
    const f = fakeProc();
    const other = () => {};
    f.proc.on("SIGTERM", other);
    installSignalShutdown(async () => {}, f.proc);
    f.emit("SIGTERM");
    await settle();
    assert.deepEqual(f.kills, [], "no re-raise while another handler is registered");
    assert.equal(f.proc.listenerCount("SIGTERM"), 1, "our listener removed, theirs kept");
  });

  test("detach removes listeners without running shutdown", async () => {
    const f = fakeProc();
    let shutdowns = 0;
    const detach = installSignalShutdown(async () => { shutdowns++; }, f.proc);
    detach();
    f.emit("SIGHUP");
    await settle();
    assert.equal(shutdowns, 0);
    assert.deepEqual(f.kills, []);
  });

  test("a shutdown rejection still re-raises", async () => {
    const f = fakeProc();
    installSignalShutdown(async () => { throw new Error("collector hung"); }, f.proc);
    f.emit("SIGHUP");
    await settle();
    assert.deepEqual(f.kills, [{ pid: 4242, signal: "SIGHUP" }], "re-raise happens even when the flush fails");
  });
});

// --- sampler selection --------------------------------------------------------

describe("buildSampler", () => {
  test("always_on and unsampled parentbased resolve to the SDK default", () => {
    assert.equal(buildSampler(cfg({ sampler: "always_on" })), undefined);
    assert.equal(buildSampler(cfg({ sampler: "parentbased_traceidratio", sampleRatio: 1 })), undefined);
  });

  test("always_off yields a non-recording tracer", async () => {
    const rt = await startRuntime(cfg({ sampler: "always_off" }));
    try {
      const span = rt.tracer.startSpan("off");
      assert.equal(span.isRecording(), false);
      span.end();
    } finally {
      await rt.shutdown();
    }
  });

  test("traceidratio with ratio 0 yields a non-recording tracer", async () => {
    const rt = await startRuntime(cfg({ sampler: "traceidratio", sampleRatio: 0 }));
    try {
      const span = rt.tracer.startSpan("zero-ratio");
      assert.equal(span.isRecording(), false);
      span.end();
    } finally {
      await rt.shutdown();
    }
  });

  test("always_on ignores the ratio", async () => {
    const rt = await startRuntime(cfg({ sampler: "always_on", sampleRatio: 0 }));
    try {
      const span = rt.tracer.startSpan("on");
      assert.equal(span.isRecording(), true);
      span.end();
    } finally {
      await rt.shutdown();
    }
  });
});

// --- accepted-count visibility -------------------------------------------------

describe("counting processors", () => {
  test("health counts accepted spans and log records", async () => {
    const rt = await startRuntime(cfg());
    try {
      const span = rt.tracer.startSpan("counted");
      span.end();
      rt.logger?.emit({ severityNumber: 9, severityText: "INFO", body: "counted" });
      await rt.flush();
      assert.equal(rt.health.spansAccepted, 1, "span accepted by the batch processor");
      assert.equal(rt.health.logRecordsAccepted, 1, "log record accepted");
    } finally {
      await rt.shutdown();
    }
  });

  test("a garbage OTEL_EXPORTER_OTLP_TIMEOUT still builds a runtime", async () => {
    // The OTLP exporter constructor throws on a non-positive timeoutMillis;
    // config resolution must clamp before the value reaches it.
    process.env.OTEL_EXPORTER_OTLP_TIMEOUT = "not-a-number";
    try {
      const rt = await startRuntime(cfg());
      await rt.shutdown();
    } finally {
      delete process.env.OTEL_EXPORTER_OTLP_TIMEOUT;
    }
  });
});

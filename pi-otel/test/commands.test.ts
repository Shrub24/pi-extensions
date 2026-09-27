import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerCommands } from "../src/commands.ts";
import { resolveConfig, type ResolvedConfig } from "../src/config.ts";
import type { ExportHealth, TelemetryRuntime } from "../src/sdk.ts";

type CommandHandler = (args: unknown, ctx: ExtensionContext) => Promise<void>;

function captureRegisterCommands(
  getRuntime: () => TelemetryRuntime | null,
  getTracker: () => { activeTraceId(): string | undefined } | null = () => null,
): {
  commands: Record<string, { handler: CommandHandler }>;
  runStatus: (mode?: string) => Promise<string>;
  /** Both streams captured by the last runStatus call. */
  lastStreams: { out: string; err: string };
} {
  const commands: Record<string, { handler: CommandHandler }> = {};
  const lastStreams = { out: "", err: "" };
  const fakePi = {
    registerCommand: (name: string, def: { handler: CommandHandler }) => {
      commands[name] = def;
    },
  } as unknown as ExtensionAPI;
  registerCommands(fakePi, getRuntime, getTracker);

  async function runStatus(mode?: string): Promise<string> {
    const fakeCtx = { hasUI: false, mode } as unknown as ExtensionContext;
    const orig = console.log;
    const origErr = console.error;
    let captured = "";
    let capturedErr = "";
    try {
      console.log = (s: string) => {
        captured = s;
      };
      console.error = (s: string) => {
        capturedErr = s;
      };
      await commands["otel-status"]!.handler([], fakeCtx);
    } finally {
      console.log = orig;
      console.error = origErr;
    }
    lastStreams.out = captured;
    lastStreams.err = capturedErr;
    return mode === "json" ? capturedErr : captured;
  }

  return { commands, runStatus, lastStreams };
}

function minimalRuntime(
  configOverrides: Partial<ResolvedConfig>,
  health: Partial<ExportHealth> = {},
): TelemetryRuntime {
  const base = resolveConfig("/test");
  const config = { ...base, ...configOverrides };
  const fullHealth: ExportHealth = {
    spansAccepted: 0,
    spansExported: 0,
    logRecordsAccepted: 0,
    metricBatchesExported: 0,
    logRecordsExported: 0,
    ...health,
  };
  return { config, health: fullHealth } as TelemetryRuntime;
}

const EXPECTED_LABELS = [
  "enabled",
  "endpoint",
  "traces",
  "traces exporters",
  "metrics",
  "metrics exporters",
  "logs",
  "logs exporters",
  "protocol",
  "service.name",
  "captureContent",
  "semconv",
  "sampleRatio",
  "active trace id",
  "shutdown timeout",
  "spans accepted",
  "exported spans",
  "metric batches",
  "logs accepted",
  "log records",
  "last shutdown err",
] as const;

/** Label field is 19 characters; values begin at 0-based index 19. */
function assertLabelColumnAligned(text: string, valueStart = 19): void {
  const lines = text.split("\n").filter((l) => l.length > 0);
  for (const line of lines) {
    assert.ok(line.length > valueStart, `line too short for aligned column: ${line}`);
    assert.equal(
      line.charAt(valueStart - 1),
      " ",
      `label column must be ${valueStart} chars (space-padded), line: ${line}`,
    );
  }
}

describe("otel-status command", () => {
  test("json mode writes to stderr, never stdout", async () => {
    // pi's json mode streams session events as JSON lines on stdout; a
    // console.log fallback there interleaves a non-event line. The output
    // must land on stderr instead, with print mode unchanged on stdout.
    const { runStatus, lastStreams } = captureRegisterCommands(() => minimalRuntime({}));
    const stderrText = await runStatus("json");
    assert.ok(stderrText.includes("enabled"), "status text present on stderr");
    assert.ok(stderrText.startsWith("INFO:"), "level prefix present");
    assert.equal(lastStreams.out, "", "stdout untouched in json mode");
    const stdoutText = await runStatus();
    assert.ok(stdoutText.includes("enabled"), "print mode still prints to stdout");
    assert.equal(lastStreams.err, "", "stderr untouched in print mode");
  });

  test("renders all expected lines with correct labels and alignment", async () => {
    const endpoint = "https://otel.example:4318";
    const serviceName = "pi-status-test";
    const shutdownTimeoutMs = 4500;
    const health: ExportHealth = {
      spansAccepted: 5,
      spansExported: 12,
      metricBatchesExported: 3,
      logRecordsAccepted: 9,
      logRecordsExported: 7,
    };
    const { runStatus } = captureRegisterCommands(() =>
      minimalRuntime(
        {
          endpoint,
          serviceName,
          shutdownTimeoutMs,
          tracesExporters: ["otlp", "console"],
          metricsExporters: ["otlp"],
          logsExporters: ["none"],
        },
        health,
      ),
    );

    const text = await runStatus();

    for (const label of EXPECTED_LABELS) {
      assert.ok(text.includes(label), `missing label: ${label}`);
    }
    assertLabelColumnAligned(text);
    assert.ok(text.includes(`endpoint           ${endpoint}`));
    assert.ok(text.includes(`service.name       ${serviceName}`));
    assert.ok(text.includes("traces exporters   otlp,console"));
    assert.ok(text.includes(`shutdown timeout   ${shutdownTimeoutMs}`));
    assert.ok(text.includes("last shutdown err  (none)"));
    assert.ok(text.includes("exported spans     12"));
    assert.ok(text.includes("metric batches     3"));
    assert.ok(text.includes("log records        7"));
  });

  test("signals off render as (off)", async () => {
    const base = resolveConfig("/test");
    const health: Partial<ExportHealth> = {
      spansExported: 0,
      metricBatchesExported: 0,
      logRecordsExported: 0,
    };
    const { runStatus } = captureRegisterCommands(() =>
      minimalRuntime(
        {
          traces: { enabled: false },
          tracesEndpoint: base.tracesEndpoint,
        },
        health,
      ),
    );

    const text = await runStatus();
    assert.ok(text.includes("traces             (off)"));
    assert.ok(!text.match(/^traces             \(off\).*ERROR:/m), "off traces must not show ERROR suffix");
  });

  test("export errors surface inline", async () => {
    const health: Partial<ExportHealth> = {
      spansExported: 0,
      metricBatchesExported: 0,
      logRecordsExported: 0,
      tracesError: "connection refused",
    };
    const { runStatus } = captureRegisterCommands(() => minimalRuntime({}, health));

    const text = await runStatus();
    const tracesLine = text.split("\n").find((l) => l.startsWith("traces             "));
    assert.ok(tracesLine, "traces line present");
    assert.ok(tracesLine!.endsWith("ERROR: connection refused"));
  });

  test("last shutdown error renders when set", async () => {
    const health: Partial<ExportHealth> = {
      spansExported: 0,
      metricBatchesExported: 0,
      logRecordsExported: 0,
      lastShutdownError: "OpenTelemetry shutdown timeout",
    };
    const { runStatus } = captureRegisterCommands(() => minimalRuntime({}, health));

    const text = await runStatus();
    assert.ok(text.includes("last shutdown err  OpenTelemetry shutdown timeout"));
  });

  test("no-runtime path returns the disabled message", async () => {
    const { runStatus } = captureRegisterCommands(() => null);
    const text = await runStatus();
    assert.equal(text, "WARNING: pi-otel: disabled (no telemetry runtime)");
  });
});

/** Capture the last headless console.log line a command prints. */
function captureLog(fn: () => Promise<void>): Promise<string> {
  const orig = console.log;
  let captured = "";
  return (async () => {
    try {
      console.log = (s: string) => { captured = s; };
      await fn();
    } finally {
      console.log = orig;
    }
    return captured;
  })();
}

describe("otel-flush and otel-test commands", () => {
  // These commands must work headless (hasUI: false). An earlier version
  // called ctx.ui.notify unconditionally in otel-flush/otel-test and would
  // throw when pi ran without a UI.
  test("otel-flush does not throw headless and prints a confirmation", async () => {
    let flushed = false;
    const rt = minimalRuntime({}, { spansExported: 0, metricBatchesExported: 0, logRecordsExported: 0 } as Partial<ExportHealth>);
    rt.flush = async () => { flushed = true; };
    const { commands } = captureRegisterCommands(() => rt);
    const fakeCtx = { hasUI: false } as unknown as ExtensionContext;
    await commands["otel-flush"]!.handler([], fakeCtx); // must not throw
    assert.equal(flushed, true, "flush was called");
    const out = await captureLog(() => commands["otel-flush"]!.handler([], fakeCtx));
    assert.match(out, /pi-otel: flushed/);
  });

  test("otel-test does not throw headless with all signals disabled", async () => {
    const rt = minimalRuntime(
      { traces: { enabled: false }, metrics: { enabled: false }, logs: { enabled: false } },
      { spansExported: 0, metricBatchesExported: 0, logRecordsExported: 0 } as Partial<ExportHealth>,
    );
    rt.flush = async () => {};
    const { commands } = captureRegisterCommands(() => rt);
    const out = await captureLog(() => commands["otel-test"]!.handler([], { hasUI: false } as unknown as ExtensionContext));
    assert.match(out, /all signals disabled/);
  });

  test("otel-flush with no runtime prints the disabled message headless", async () => {
    const { commands } = captureRegisterCommands(() => null);
    const out = await captureLog(() => commands["otel-flush"]!.handler([], { hasUI: false } as unknown as ExtensionContext));
    assert.match(out, /pi-otel: disabled/);
  });
});
describe("otel-status export counts", () => {
  test("shows an unexported hint when accepted exceeds exported", async () => {
    const { commands, runStatus } = captureRegisterCommands(() =>
      minimalRuntime({}, { spansAccepted: 10, spansExported: 7, logRecordsAccepted: 4, logRecordsExported: 4 }),
    );
    void commands;
    const out = await runStatus();
    assert.match(out, /exported spans\s+7\s+\(3 unexported\)/, "span delta hint");
    assert.doesNotMatch(out, /log records\s+4\s+\(/, "no hint when nothing pending");
  });

  test("shows no hint when everything exported", async () => {
    const { runStatus } = captureRegisterCommands(() =>
      minimalRuntime({}, { spansAccepted: 7, spansExported: 7 }),
    );
    const out = await runStatus();
    assert.match(out, /exported spans\s+7$/m);
  });
});

describe("otel-test health reporting", () => {
  const fakeTracer = () => ({
    startSpan: () => ({ addEvent() {}, setAttribute() {}, end() {} }),
  });

  test("reports flushed deltas on success", async () => {
    const rt = minimalRuntime({}, { spansExported: 3, metricBatchesExported: 1, logRecordsExported: 2 });
    rt.tracer = fakeTracer() as unknown as TelemetryRuntime["tracer"];
    rt.logger = null;
    rt.flush = async () => {
      rt.health.spansExported = 4;
      rt.health.metricBatchesExported = 2;
      rt.health.logRecordsExported = 3;
    };
    const { commands } = captureRegisterCommands(() => rt);
    const out = await captureLog(() => commands["otel-test"]!.handler([], { hasUI: false } as unknown as ExtensionContext));
    assert.match(out, /self-test flushed \(spans \+1, metric batches \+1, log records \+1\)/);
    assert.doesNotMatch(out, /ERROR/, "no errors on success");
  });

  test("surfaces export errors as a warning", async () => {
    const rt = minimalRuntime({}, { tracesError: "connection refused" });
    rt.tracer = fakeTracer() as unknown as TelemetryRuntime["tracer"];
    rt.logger = null;
    rt.flush = async () => {};
    const { commands } = captureRegisterCommands(() => rt);
    const out = await captureLog(() => commands["otel-test"]!.handler([], { hasUI: false } as unknown as ExtensionContext));
    assert.match(out, /WARNING: pi-otel: self-test flushed .*traces: connection refused/);
  });

  test("emits the log record regardless of selfLogs", async () => {
    // selfLogs gates lifecycle chatter, not an explicit pipeline check.
    const rt = minimalRuntime({ selfLogs: false }, {});
    rt.tracer = fakeTracer() as unknown as TelemetryRuntime["tracer"];
    const emitted: Array<Record<string, unknown>> = [];
    rt.logger = { emit: (rec: Record<string, unknown>) => { emitted.push(rec); } } as unknown as TelemetryRuntime["logger"];
    rt.flush = async () => {};
    const { commands } = captureRegisterCommands(() => rt);
    await captureLog(() => commands["otel-test"]!.handler([], { hasUI: false } as unknown as ExtensionContext));
    assert.equal(emitted.length, 1, "self-test log emitted despite selfLogs=false");
    assert.match(String((emitted[0] as { attributes?: Record<string, unknown> } | undefined)?.attributes?.["event.name"]), /pi\.otel\.self_test/);
  });
});

describe("otel-status active trace id", () => {
  test("renders the tracker's active trace id", async () => {
    const { runStatus } = captureRegisterCommands(
      () => minimalRuntime({}, {}),
      () => ({ activeTraceId: () => "abc123def45789" }),
    );
    const out = await runStatus();
    assert.match(out, /active trace id\s+abc123def45789/);
  });

  test("renders (none) without a tracker", async () => {
    const { runStatus } = captureRegisterCommands(() => minimalRuntime({}, {}), () => null);
    const out = await runStatus();
    assert.match(out, /active trace id\s+\(none\)/);
  });
});

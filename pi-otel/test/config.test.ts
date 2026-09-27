import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  resolveConfig,
  resolveSignalEndpoint,
  parseExporters,
  parseExporterTokensFromArray,
  clampExportIntervalMs,
  clampShutdownTimeoutMs,
  MIN_EXPORT_INTERVAL_MS,
} from "../src/config.ts";

/**
 * Config resolution tests.
 *
 * Precedence under test: env > project settings > global settings > defaults.
 * Each test saves/restores the full set of env vars it touches to avoid
 * cross-test contamination.
 */

const ENV_KEYS = [
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_EXPORTER_OTLP_PROTOCOL",
  "OTEL_RESOURCE_ATTRIBUTES",
  "OTEL_SERVICE_NAME",
  "OTEL_TRACES_SAMPLER_ARG",
  "OTEL_METRIC_EXPORT_INTERVAL",
  "OTEL_TRACES_EXPORTER",
  "OTEL_METRICS_EXPORTER",
  "OTEL_LOGS_EXPORTER",
  "OTEL_TRACES_EXPORT_INTERVAL",
  "OTEL_LOGS_EXPORT_INTERVAL",
  "OTEL_LOG_LEVEL",
  "PI_OTEL_ENABLED",
  "PI_OTEL_DISABLED",
  "PI_OTEL_CAPTURE_CONTENT",
  "PI_OTEL_SAMPLE_RATIO",
  "PI_OTEL_TRACES",
  "PI_OTEL_METRICS",
  "PI_OTEL_LOGS",
  "PI_OTEL_SERVICE_NAME",
  "PI_OTEL_SHUTDOWN_TIMEOUT_MS",
  "PI_OTEL_METRIC_EXPORT_INTERVAL",
  "OTEL_SDK_DISABLED",
  "OTEL_TRACES_SAMPLER",
  "OTEL_EXPORTER_OTLP_TIMEOUT",
  "OTEL_EXPORTER_OTLP_TRACES_TIMEOUT",
  "OTEL_EXPORTER_OTLP_METRICS_TIMEOUT",
  "OTEL_EXPORTER_OTLP_LOGS_TIMEOUT",
  "OTEL_BSP_SCHEDULE_DELAY",
  "OTEL_BSP_MAX_QUEUE_SIZE",
  "OTEL_BSP_MAX_EXPORT_BATCH_SIZE",
  "OTEL_BSP_EXPORT_TIMEOUT",
  "OTEL_BLP_SCHEDULE_DELAY",
  "OTEL_BLP_MAX_QUEUE_SIZE",
  "OTEL_BLP_MAX_EXPORT_BATCH_SIZE",
  "OTEL_BLP_EXPORT_TIMEOUT",
  "PI_OTEL_SEMCONV",
] as const;

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

// --- resolveSignalEndpoint --------------------------------------------------

describe("resolveSignalEndpoint", () => {
  test("appends /v1/<signal> for http/protobuf", () => {
    assert.equal(resolveSignalEndpoint("http://localhost:4318", "traces", "http/protobuf"), "http://localhost:4318/v1/traces");
    assert.equal(resolveSignalEndpoint("http://x:4318", "metrics", "http/protobuf"), "http://x:4318/v1/metrics");
    assert.equal(resolveSignalEndpoint("http://x:4318", "logs", "http/json"), "http://x:4318/v1/logs");
  });

  test("returns base unchanged for grpc", () => {
    assert.equal(resolveSignalEndpoint("http://localhost:4317", "traces", "grpc"), "http://localhost:4317");
    assert.equal(resolveSignalEndpoint("http://localhost:4317/", "metrics", "grpc"), "http://localhost:4317");
  });

  test("explicit endpoint wins over base for any protocol", () => {
    assert.equal(
      resolveSignalEndpoint("http://base:4318", "traces", "grpc", "https://explicit/traces"),
      "https://explicit/traces",
    );
  });

  test("does not double-append when base already has a /v1/<signal> path", () => {
    assert.equal(
      resolveSignalEndpoint("http://x:4318/v1/traces", "traces", "http/protobuf"),
      "http://x:4318/v1/traces",
    );
  });

  test("trims trailing slashes before appending", () => {
    assert.equal(resolveSignalEndpoint("http://x:4318///", "traces", "http/protobuf"), "http://x:4318/v1/traces");
  });
});

// --- defaults ---------------------------------------------------------------

describe("defaults", () => {
  test("all three signals enabled by default", () => {
    const c = resolveConfig("/nonexistent");
    assert.equal(c.traces.enabled, true);
    assert.equal(c.metrics.enabled, true);
    assert.equal(c.logs.enabled, true);
  });

  test("default protocol is http/protobuf per OTel spec", () => {
    const c = resolveConfig("/nonexistent");
    assert.equal(c.protocol, "http/protobuf");
  });

  test("default endpoint is localhost:4318", () => {
    const c = resolveConfig("/nonexistent");
    assert.equal(c.endpoint, "http://localhost:4318");
    assert.equal(c.tracesEndpoint, "http://localhost:4318/v1/traces");
  });

  test("default service.name is pi", () => {
    assert.equal(resolveConfig("/nonexistent").serviceName, "pi");
  });

  test("default captureContent is full", () => {
    assert.equal(resolveConfig("/nonexistent").captureContent, "full");
  });

  test("default sampleRatio is 1.0 (no sampling)", () => {
    assert.equal(resolveConfig("/nonexistent").sampleRatio, 1);
  });

  test("enabled is true by default", () => {
    assert.equal(resolveConfig("/nonexistent").enabled, true);
  });

  test("default exporter tokens and export intervals", () => {
    const c = resolveConfig("/nonexistent");
    assert.deepEqual(c.tracesExporters, ["otlp"]);
    assert.deepEqual(c.metricsExporters, ["otlp"]);
    assert.deepEqual(c.logsExporters, ["otlp"]);
    assert.equal(c.tracesExportInterval, 5000);
    assert.equal(c.metricExportInterval, 10000);
    assert.equal(c.logsExportInterval, 5000);
  });
});

// --- precedence -------------------------------------------------------------

describe("precedence", () => {
  test("OTEL_SERVICE_NAME overrides settings serviceName", () => {
    process.env.OTEL_SERVICE_NAME = "from-env";
    assert.equal(resolveConfig("/nonexistent").serviceName, "from-env");
  });

  test("PI_OTEL_SERVICE_NAME overrides settings serviceName", () => {
    process.env.PI_OTEL_SERVICE_NAME = "from-pi-env";
    assert.equal(resolveConfig("/nonexistent").serviceName, "from-pi-env");
  });

  test("OTEL_EXPORTER_OTLP_ENDPOINT overrides default endpoint", () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "https://ingest.example.com";
    const c = resolveConfig("/nonexistent");
    assert.equal(c.tracesEndpoint, "https://ingest.example.com/v1/traces");
    assert.equal(c.metricsEndpoint, "https://ingest.example.com/v1/metrics");
    assert.equal(c.logsEndpoint, "https://ingest.example.com/v1/logs");
  });

  test("per-signal endpoint overrides beat base endpoint", () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://base:4318";
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = "https://traces-only:4318/v1/traces";
    const c = resolveConfig("/nonexistent");
    assert.equal(c.tracesEndpoint, "https://traces-only:4318/v1/traces");
    assert.equal(c.metricsEndpoint, "http://base:4318/v1/metrics");
  });

  test("OTEL_EXPORTER_OTLP_HEADERS merge into headers map", () => {
    process.env.OTEL_EXPORTER_OTLP_HEADERS = "x-api-key=secret,region=us";
    const c = resolveConfig("/nonexistent");
    assert.equal(c.headers["x-api-key"], "secret");
    assert.equal(c.headers["region"], "us");
  });

  test("OTEL_RESOURCE_ATTRIBUTES parsed (URL-decoded) into resourceAttributes", () => {
    process.env.OTEL_RESOURCE_ATTRIBUTES = "deployment.env=prod,team=platform%20eng";
    const c = resolveConfig("/nonexistent");
    assert.equal(c.resourceAttributes["deployment.env"], "prod");
    assert.equal(c.resourceAttributes["team"], "platform eng");
  });

  test("malformed OTEL_RESOURCE_ATTRIBUTES percent-escape keeps raw value", () => {
    process.env.OTEL_RESOURCE_ATTRIBUTES = "bad=%%%";
    const c = resolveConfig("/nonexistent");
    assert.equal(c.resourceAttributes["bad"], "%%%");
  });
});

// --- protocol normalization -------------------------------------------------

describe("protocol normalization", () => {
  for (const [raw, expected] of [
    ["grpc", "grpc"],
    ["gRPC", "grpc"],
    ["http/protobuf", "http/protobuf"],
    ["http", "http/protobuf"],
    ["http-protobuf", "http/protobuf"],
    ["http/json", "http/json"],
    ["", "http/protobuf"],
    ["garbage", "http/protobuf"],
  ] as const) {
    test(`protocol "${raw}" -> ${expected}`, () => {
      process.env.OTEL_EXPORTER_OTLP_PROTOCOL = raw;
      assert.equal(resolveConfig("/nonexistent").protocol, expected);
    });
  }
});

// --- capture normalization --------------------------------------------------

describe("capture normalization", () => {
  for (const [raw, expected] of [
    ["full", "full"],
    ["metadata_only", "metadata_only"],
    ["no_tool_content", "no_tool_content"],
    ["1", "full"],
    ["true", "full"],
    ["0", "metadata_only"],
    ["false", "metadata_only"],
    ["", "full"],
    ["garbage", "metadata_only"],
    ["FULL", "full"],
    ["Metadata_Only", "metadata_only"],
    // Fail closed: a typo must not resolve to full capture.
    ["metadata-only", "metadata_only"],
    ["no_tool", "metadata_only"],
  ] as const) {
    test(`capture "${raw}" -> ${expected}`, () => {
      process.env.PI_OTEL_CAPTURE_CONTENT = raw;
      assert.equal(resolveConfig("/nonexistent").captureContent, expected);
    });
  }
});

// --- enable/disable ---------------------------------------------------------

describe("enable/disable", () => {
  test("PI_OTEL_ENABLED=false disables", () => {
    process.env.PI_OTEL_ENABLED = "false";
    assert.equal(resolveConfig("/nonexistent").enabled, false);
  });

  test("PI_OTEL_ENABLED=0 disables", () => {
    process.env.PI_OTEL_ENABLED = "0";
    assert.equal(resolveConfig("/nonexistent").enabled, false);
  });

  test("PI_OTEL_DISABLED=1 wins over PI_OTEL_ENABLED=true", () => {
    process.env.PI_OTEL_ENABLED = "true";
    process.env.PI_OTEL_DISABLED = "1";
    assert.equal(resolveConfig("/nonexistent").enabled, false);
  });

  test("PI_OTEL_DISABLED=true also works", () => {
    process.env.PI_OTEL_DISABLED = "true";
    assert.equal(resolveConfig("/nonexistent").enabled, false);
  });
});

// --- per-signal toggles -----------------------------------------------------

describe("per-signal toggles", () => {
  test("PI_OTEL_TRACES=0 disables traces only", () => {
    process.env.PI_OTEL_TRACES = "0";
    const c = resolveConfig("/nonexistent");
    assert.equal(c.traces.enabled, false);
    assert.equal(c.metrics.enabled, true);
    assert.equal(c.logs.enabled, true);
  });

  test("PI_OTEL_LOGS=false disables logs only", () => {
    process.env.PI_OTEL_LOGS = "false";
    const c = resolveConfig("/nonexistent");
    assert.equal(c.logs.enabled, false);
    assert.equal(c.traces.enabled, true);
  });
});

// --- sampling ---------------------------------------------------------------

describe("sampling", () => {
  test("sampleRatio is clamped to [0,1]", () => {
    process.env.PI_OTEL_SAMPLE_RATIO = "5";
    assert.equal(resolveConfig("/nonexistent").sampleRatio, 1);
    process.env.PI_OTEL_SAMPLE_RATIO = "-0.5";
    assert.equal(resolveConfig("/nonexistent").sampleRatio, 0);
  });

  test("a non-numeric sampleRatio from settings falls back to 1, not NaN", () => {
    // Settings values are unvalidated JSON; Math.min/max would propagate
    // NaN straight into the sampler without this guard.
    const fs = require("node:fs");
    const os = require("node:os");
    const pathMod = require("node:path");
    const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), "pi-otel-cfg-"));
    fs.mkdirSync(pathMod.join(dir, ".pi"), { recursive: true });
    fs.writeFileSync(pathMod.join(dir, ".pi", "settings.json"), JSON.stringify({ otel: { sampleRatio: { nested: true } } }));
    try {
      const resolved = resolveConfig(dir);
      assert.equal(resolved.sampleRatio, 1, "object sampleRatio resolves to 1");
      assert.ok(Number.isFinite(resolved.sampleRatio), "never NaN");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("OTEL_TRACES_SAMPLER_ARG is honored", () => {
    process.env.OTEL_TRACES_SAMPLER_ARG = "0.25";
    assert.equal(resolveConfig("/nonexistent").sampleRatio, 0.25);
  });

  test("non-numeric sampleRatio falls back to default", () => {
    process.env.PI_OTEL_SAMPLE_RATIO = "abc";
    assert.equal(resolveConfig("/nonexistent").sampleRatio, 1);
  });
});

// --- exporter tokens --------------------------------------------------------

describe("parseExporters", () => {
  const defaultFallback: ["otlp"] = ["otlp"];

  test("single token console", () => {
    assert.deepEqual(parseExporters("console", defaultFallback), ["console"]);
  });

  test("comma list with mixed case and whitespace", () => {
    assert.deepEqual(parseExporters(" Console , OTLP ", defaultFallback), ["console", "otlp"]);
  });

  test("dedupe preserves order", () => {
    assert.deepEqual(parseExporters("otlp,otlp", defaultFallback), ["otlp"]);
  });

  test("none token preserved", () => {
    assert.deepEqual(parseExporters("none", defaultFallback), ["none"]);
  });

  test("all unknown tokens fall back", () => {
    assert.deepEqual(parseExporters("foo,bar,baz", defaultFallback), ["otlp"]);
  });

  test("empty string falls back", () => {
    assert.deepEqual(parseExporters("", defaultFallback), ["otlp"]);
    assert.deepEqual(parseExporters("   ", defaultFallback), ["otlp"]);
  });

  test("unknown mixed with known keeps known", () => {
    assert.deepEqual(parseExporters("otlp,garbage,console", defaultFallback), ["otlp", "console"]);
  });

  test("undefined falls back", () => {
    assert.deepEqual(parseExporters(undefined, defaultFallback), ["otlp"]);
  });
});

describe("parseExporterTokensFromArray", () => {
  const defaultFallback: ["otlp"] = ["otlp"];

  test("validates settings array entries", () => {
    assert.deepEqual(parseExporterTokensFromArray(["otlp", "bogus", "console"], defaultFallback), [
      "otlp",
      "console",
    ]);
  });

  test("empty array falls back", () => {
    assert.deepEqual(parseExporterTokensFromArray([], defaultFallback), ["otlp"]);
    assert.deepEqual(parseExporterTokensFromArray(undefined, defaultFallback), ["otlp"]);
  });
});

describe("exporter env precedence", () => {
  test("OTEL_TRACES_EXPORTER single console", () => {
    process.env.OTEL_TRACES_EXPORTER = "console";
    assert.deepEqual(resolveConfig("/nonexistent").tracesExporters, ["console"]);
  });

  test("OTEL_METRICS_EXPORTER mixed case list", () => {
    process.env.OTEL_METRICS_EXPORTER = " Console , OTLP ";
    assert.deepEqual(resolveConfig("/nonexistent").metricsExporters, ["console", "otlp"]);
  });

  test("OTEL_LOGS_EXPORTER dedupes", () => {
    process.env.OTEL_LOGS_EXPORTER = "otlp,otlp";
    assert.deepEqual(resolveConfig("/nonexistent").logsExporters, ["otlp"]);
  });
});

describe("export intervals", () => {
  test("OTEL_TRACES_EXPORT_INTERVAL numeric", () => {
    process.env.OTEL_TRACES_EXPORT_INTERVAL = "1500";
    assert.equal(resolveConfig("/nonexistent").tracesExportInterval, 1500);
  });

  test("OTEL_LOGS_EXPORT_INTERVAL non-numeric falls back", () => {
    process.env.OTEL_LOGS_EXPORT_INTERVAL = "abc";
    assert.equal(resolveConfig("/nonexistent").logsExportInterval, 5000);
  });

  test("zero and negative export intervals clamp to the minimum", () => {
    process.env.OTEL_METRIC_EXPORT_INTERVAL = "0";
    process.env.OTEL_TRACES_EXPORT_INTERVAL = "-50";
    process.env.OTEL_LOGS_EXPORT_INTERVAL = "1";
    const c = resolveConfig("/nonexistent");
    assert.equal(c.metricExportInterval, MIN_EXPORT_INTERVAL_MS);
    assert.equal(c.tracesExportInterval, MIN_EXPORT_INTERVAL_MS);
    assert.equal(c.logsExportInterval, MIN_EXPORT_INTERVAL_MS);
  });

  test("fractional export intervals truncate toward the floor after clamp", () => {
    process.env.OTEL_TRACES_EXPORT_INTERVAL = "1500.9";
    assert.equal(resolveConfig("/nonexistent").tracesExportInterval, 1500);
  });

  test("shutdown timeout allows 0 and clamps negatives to 0", () => {
    process.env.PI_OTEL_SHUTDOWN_TIMEOUT_MS = "0";
    assert.equal(resolveConfig("/nonexistent").shutdownTimeoutMs, 0);
    process.env.PI_OTEL_SHUTDOWN_TIMEOUT_MS = "-10";
    assert.equal(resolveConfig("/nonexistent").shutdownTimeoutMs, 0);
  });

  test("shutdown timeout non-numeric falls back to default", () => {
    process.env.PI_OTEL_SHUTDOWN_TIMEOUT_MS = "nope";
    assert.equal(resolveConfig("/nonexistent").shutdownTimeoutMs, 2000);
  });
});

describe("clamp helpers", () => {
  test("clampExportIntervalMs floors and rejects non-finite", () => {
    assert.equal(clampExportIntervalMs(0, 5000), MIN_EXPORT_INTERVAL_MS);
    assert.equal(clampExportIntervalMs(-1, 5000), MIN_EXPORT_INTERVAL_MS);
    assert.equal(clampExportIntervalMs(250, 5000), 250);
    assert.equal(clampExportIntervalMs(Number.NaN, 5000), 5000);
    assert.equal(clampExportIntervalMs(Number.POSITIVE_INFINITY, 5000), 5000);
  });

  test("clampShutdownTimeoutMs allows zero", () => {
    assert.equal(clampShutdownTimeoutMs(0, 2000), 0);
    assert.equal(clampShutdownTimeoutMs(-5, 2000), 0);
    assert.equal(clampShutdownTimeoutMs(1500, 2000), 1500);
    assert.equal(clampShutdownTimeoutMs(Number.NaN, 2000), 2000);
  });
});

// --- settings.json files ----------------------------------------------------

describe("settings.json", () => {
  test("project .pi/settings.json otel block is read", () => {
    const tmp = mkProjectSettings({ otel: { serviceName: "from-project", sampleRatio: 0.5 } });
    try {
      const c = resolveConfig(tmp);
      assert.equal(c.serviceName, "from-project");
      assert.equal(c.sampleRatio, 0.5);
    } finally {
      rmrf(tmp);
    }
  });

  test("env overrides project settings", () => {
    const tmp = mkProjectSettings({ otel: { serviceName: "from-project" } });
    try {
      process.env.OTEL_SERVICE_NAME = "from-env";
      assert.equal(resolveConfig(tmp).serviceName, "from-env");
    } finally {
      rmrf(tmp);
    }
  });

  test("malformed settings.json is tolerated (defaults used)", () => {
    const tmp = makeTmpDir();
    fs.mkdirSync(node_path.join(tmp, ".pi"), { recursive: true });
    fs.writeFileSync(node_path.join(tmp, ".pi", "settings.json"), "{ not valid json");
    try {
      const c = resolveConfig(tmp);
      assert.equal(c.serviceName, "pi"); // default
      assert.equal(c.enabled, true);
    } finally {
      rmrf(tmp);
    }
  });

  test("settings.json without otel key is tolerated", () => {
    const tmp = mkProjectSettings({ other: { foo: "bar" } });
    try {
      const c = resolveConfig(tmp);
      assert.equal(c.serviceName, "pi");
    } finally {
      rmrf(tmp);
    }
  });

  test("settings resourceAttributes merge under env OTEL_RESOURCE_ATTRIBUTES", () => {
    const tmp = mkProjectSettings({
      otel: {
        resourceAttributes: { "deployment.env": "from-settings", team: "settings-team" },
      },
    });
    try {
      process.env.OTEL_RESOURCE_ATTRIBUTES = "deployment.env=from-env,region=us";
      const c = resolveConfig(tmp);
      assert.equal(c.resourceAttributes["deployment.env"], "from-env", "env overrides settings");
      assert.equal(c.resourceAttributes.team, "settings-team", "settings-only key kept");
      assert.equal(c.resourceAttributes.region, "us", "env-only key present");
    } finally {
      rmrf(tmp);
    }
  });
});

// --- helpers ----------------------------------------------------------------

import fs from "node:fs";
import node_path from "node:path";
import os from "node:os";

function makeTmpDir(): string {
  return fs.mkdtempSync(node_path.join(os.tmpdir(), "pi-otel-cfg-"));
}
function rmrf(p: string): void {
  fs.rmSync(p, { recursive: true, force: true });
}
function mkProjectSettings(contents: Record<string, unknown>): string {
  const dir = makeTmpDir();
  fs.mkdirSync(node_path.join(dir, ".pi"), { recursive: true });
  fs.writeFileSync(node_path.join(dir, ".pi", "settings.json"), JSON.stringify(contents));
  return dir;
}

// --- standard OTel SDK env vars ---------------------------------------------

describe("OTEL_SDK_DISABLED", () => {
  test("true disables even with PI_OTEL_ENABLED=true", () => {
    process.env.OTEL_SDK_DISABLED = "true";
    process.env.PI_OTEL_ENABLED = "true";
    assert.equal(resolveConfig("/nonexistent").enabled, false);
  });

  test("false does not disable", () => {
    process.env.OTEL_SDK_DISABLED = "false";
    assert.equal(resolveConfig("/nonexistent").enabled, true);
  });

  test("PI_OTEL_DISABLED still wins over enable flags", () => {
    process.env.PI_OTEL_DISABLED = "1";
    process.env.PI_OTEL_ENABLED = "true";
    assert.equal(resolveConfig("/nonexistent").enabled, false);
  });
});

describe("exporter request timeout", () => {
  test("defaults to the spec 10000ms", () => {
    const c = resolveConfig("/nonexistent");
    assert.equal(c.tracesExportTimeoutMs, 10000);
    assert.equal(c.metricsExportTimeoutMs, 10000);
    assert.equal(c.logsExportTimeoutMs, 10000);
  });

  test("base env applies to all signals, per-signal env wins", () => {
    process.env.OTEL_EXPORTER_OTLP_TIMEOUT = "2500";
    let c = resolveConfig("/nonexistent");
    assert.equal(c.tracesExportTimeoutMs, 2500);
    assert.equal(c.metricsExportTimeoutMs, 2500);
    assert.equal(c.logsExportTimeoutMs, 2500);
    process.env.OTEL_EXPORTER_OTLP_TRACES_TIMEOUT = "8000";
    c = resolveConfig("/nonexistent");
    assert.equal(c.tracesExportTimeoutMs, 8000, "per-signal wins over base");
    assert.equal(c.metricsExportTimeoutMs, 2500, "base still applies elsewhere");
  });

  test("invalid values fall back so the exporter constructor never throws", () => {
    for (const bad of ["0", "-5", "abc", ""]) {
      process.env.OTEL_EXPORTER_OTLP_TIMEOUT = bad;
      const c = resolveConfig("/nonexistent");
      assert.equal(c.tracesExportTimeoutMs, 10000, `fallback for "${bad}"`);
    }
  });
});

describe("batch processor env vars", () => {
  test("OTEL_BSP_* map to trace batch options", () => {
    process.env.OTEL_BSP_SCHEDULE_DELAY = "1500";
    process.env.OTEL_BSP_MAX_QUEUE_SIZE = "4096";
    process.env.OTEL_BSP_MAX_EXPORT_BATCH_SIZE = "256";
    process.env.OTEL_BSP_EXPORT_TIMEOUT = "9000";
    const c = resolveConfig("/nonexistent");
    assert.equal(c.tracesExportInterval, 1500);
    assert.equal(c.tracesMaxQueueSize, 4096);
    assert.equal(c.tracesMaxExportBatchSize, 256);
    assert.equal(c.tracesBatchExportTimeoutMs, 9000);
  });

  test("OTEL_BLP_* map to log batch options", () => {
    process.env.OTEL_BLP_SCHEDULE_DELAY = "1200";
    process.env.OTEL_BLP_MAX_QUEUE_SIZE = "1024";
    const c = resolveConfig("/nonexistent");
    assert.equal(c.logsExportInterval, 1200);
    assert.equal(c.logsMaxQueueSize, 1024);
    assert.equal(c.logsMaxExportBatchSize, 512, "unset keeps default");
  });

  test("invalid queue values fall back to defaults", () => {
    process.env.OTEL_BSP_MAX_QUEUE_SIZE = "0";
    const c = resolveConfig("/nonexistent");
    assert.equal(c.tracesMaxQueueSize, 2048);
  });

  test("spec schedule delay wins over the extension var when both set", () => {
    process.env.OTEL_BSP_SCHEDULE_DELAY = "1111";
    process.env.OTEL_TRACES_EXPORT_INTERVAL = "2222";
    assert.equal(resolveConfig("/nonexistent").tracesExportInterval, 1111);
  });
});

describe("sampler selection", () => {
  test("defaults to parentbased_traceidratio", () => {
    assert.equal(resolveConfig("/nonexistent").sampler, "parentbased_traceidratio");
  });

  test("accepts the four spec names, case-insensitively", () => {
    for (const [raw, expected] of [
      ["ALWAYS_ON", "always_on"],
      ["always_off", "always_off"],
      ["TraceIdRatio", "traceidratio"],
      ["parentbased_traceidratio", "parentbased_traceidratio"],
    ] as const) {
      process.env.OTEL_TRACES_SAMPLER = raw;
      assert.equal(resolveConfig("/nonexistent").sampler, expected, raw);
    }
  });

  test("unknown values fall back to the default", () => {
    process.env.OTEL_TRACES_SAMPLER = "some_custom_sampler";
    assert.equal(resolveConfig("/nonexistent").sampler, "parentbased_traceidratio");
  });
});

describe("semconv dialect", () => {
  test("defaults to 1.43", () => {
    assert.equal(resolveConfig("/nonexistent").semconv, "1.43");
  });

  test("PI_OTEL_SEMCONV selects each dialect; unknown values fall back to 1.43", () => {
    process.env.PI_OTEL_SEMCONV = "1.36";
    assert.equal(resolveConfig("/nonexistent").semconv, "1.36");
    process.env.PI_OTEL_SEMCONV = "1.37";
    assert.equal(resolveConfig("/nonexistent").semconv, "1.37");
    process.env.PI_OTEL_SEMCONV = "latest";
    assert.equal(resolveConfig("/nonexistent").semconv, "1.43", "unknown names fall back to the default");
    process.env.PI_OTEL_SEMCONV = "1.44";
    assert.equal(resolveConfig("/nonexistent").semconv, "1.43", "future versions fall back until supported");
  });
});

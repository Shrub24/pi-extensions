/**
 * Configuration resolution.
 *
 * Precedence (highest wins):
 *   1. `OTEL_*` / `PI_OTEL_*` environment variables
 *   2. project `.pi/settings.json` -> `otel`
 *   3. global `~/.pi/agent/settings.json` -> `otel`
 *
 * Standard OTel SDK env vars are honored verbatim so existing instrumentation
 * config keeps working. `PI_OTEL_*` covers extension-specific concerns.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DiagLogLevel } from "@opentelemetry/api";
import type { ContentCapture } from "./attrs.js";

export type Protocol = "grpc" | "http/protobuf" | "http/json";

export type ExporterToken = "otlp" | "console" | "none";

/** Sampler names accepted by OTEL_TRACES_SAMPLER. */
export type SamplerSpec =
  | "always_on"
  | "always_off"
  | "traceidratio"
  | "parentbased_traceidratio";

/** GenAI attribute dialect, versioned by the opentelemetry/semantic-conventions
 * release that defined the attribute set. `1.36` is the pre-2025-10 set
 * (`gen_ai.system`, message span events). `1.37` is the 2025-10 rework
 * (`gen_ai.provider.name`, no message events). `1.43` additionally adopts the
 * registry usage-attribute names (`gen_ai.usage.cache_read.input_tokens`,
 * `cache_creation`, `reasoning.output_tokens`), `gen_ai.request.stream`, and
 * the `gen_ai.client.operation.time_to_first_chunk` metric. */
export type SemconvDialect = "1.36" | "1.37" | "1.43";

export const DEFAULT_SEMCONV: SemconvDialect = "1.43";

export interface SignalConfig {
  enabled: boolean;
}

export interface ResolvedConfig {
  /** Master kill switch. When false the extension is inert. */
  enabled: boolean;
  /** Base OTLP endpoint, e.g. http://localhost:4318 or https://ingest.host.com. */
  endpoint: string;
  /** Per-signal endpoint overrides (already resolved, or derived from base). */
  tracesEndpoint: string;
  metricsEndpoint: string;
  logsEndpoint: string;
  /** Wire protocol for all signals. */
  protocol: Protocol;
  /** Headers sent on every export (auth, etc.). */
  headers: Record<string, string>;
  /** `service.name` resource attribute (required by spec). */
  serviceName: string;
  /** Additional resource attributes from OTEL_RESOURCE_ATTRIBUTES. */
  resourceAttributes: Record<string, string>;
  /** Raw content capture level. Default `full`. */
  captureContent: ContentCapture;
  /** Head-sampling ratio in [0,1]. Default 1.0 (no sampling). */
  sampleRatio: number;
  /** Metric export interval, ms. */
  metricExportInterval: number;
  /** Per-signal exporter token lists (order preserved, deduped). */
  tracesExporters: ExporterToken[];
  metricsExporters: ExporterToken[];
  logsExporters: ExporterToken[];
  /** Traces periodic export interval, ms. */
  tracesExportInterval: number;
  /** Logs periodic export interval, ms. */
  logsExportInterval: number;
  /** Per-signal toggles. */
  traces: SignalConfig;
  metrics: SignalConfig;
  logs: SignalConfig;
  /** Sampler selection per OTEL_TRACES_SAMPLER. Default parentbased_traceidratio. */
  sampler: SamplerSpec;
  /** GenAI convention version. Default 1.43. */
  semconv: SemconvDialect;
  /** Exporter request timeout per signal, ms. Spec default 10000. */
  tracesExportTimeoutMs: number;
  metricsExportTimeoutMs: number;
  logsExportTimeoutMs: number;
  /** Trace batch queue bounds (OTEL_BSP_*). Defaults: 2048 / 512 / 30000. */
  tracesMaxQueueSize: number;
  tracesMaxExportBatchSize: number;
  tracesBatchExportTimeoutMs: number;
  /** Log batch queue bounds (OTEL_BLP_*). Defaults: 2048 / 512 / 30000. */
  logsMaxQueueSize: number;
  logsMaxExportBatchSize: number;
  logsBatchExportTimeoutMs: number;
  /** OTel diag log level (internal SDK diagnostics). Default NONE. */
  diagLogLevel: DiagLogLevel;
  /** Emit telemetry from the extension itself (lifecycle events as logs). */
  selfLogs: boolean;
  /** Shutdown timeout in ms. forceFlush+shutdown race against this. Default 2000. */
  shutdownTimeoutMs: number;
  /** Working directory, for the pi.cwd resource attribute. */
  cwd: string;
}

interface SettingsFile {
  otel?: Partial<SettingsOtel>;
}
interface SettingsOtel {
  enabled: boolean;
  endpoint: string;
  tracesEndpoint: string;
  metricsEndpoint: string;
  logsEndpoint: string;
  protocol: Protocol;
  headers: Record<string, string>;
  serviceName: string;
  resourceAttributes: Record<string, string>;
  captureContent: ContentCapture;
  sampleRatio: number;
  metricExportInterval: number;
  tracesExporters?: string[];
  metricsExporters?: string[];
  logsExporters?: string[];
  tracesExportInterval?: number;
  logsExportInterval?: number;
  traces: boolean;
  metrics: boolean;
  logs: boolean;
  sampler?: SamplerSpec;
  semconv?: SemconvDialect;
  tracesExportTimeoutMs?: number;
  metricsExportTimeoutMs?: number;
  logsExportTimeoutMs?: number;
  tracesMaxQueueSize?: number;
  tracesMaxExportBatchSize?: number;
  tracesBatchExportTimeoutMs?: number;
  logsMaxQueueSize?: number;
  logsMaxExportBatchSize?: number;
  logsBatchExportTimeoutMs?: number;
  diagLogLevel: string;
  selfLogs: boolean;
  shutdownTimeoutMs: number;
}

function readJson(path: string): SettingsFile | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as SettingsFile;
  } catch {
    return null;
  }
}

/** Parse `k=v,k=v` lists per the W3C OTel env var spec (URL-decoded). */
function parseKv(raw: string | undefined, decode = false): Record<string, string> {
  if (!raw) return {};
  const out: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const k = pair.slice(0, eq).trim();
    if (!k) continue;
    const rawV = pair.slice(eq + 1).trim();
    let v = rawV;
    if (decode) {
      try {
        v = decodeURIComponent(rawV);
      } catch {
        v = rawV; // malformed %-escape — keep raw per W3C guidance
      }
    }
    out[k] = v;
  }
  return out;
}

function envStr(...names: string[]): string | undefined {
  for (const n of names) {
    const v = process.env[n];
    if (v !== undefined && v.trim() !== "") return v.trim();
  }
  return undefined;
}

function envBool(names: string[], fallback: boolean): boolean {
  const v = envStr(...names);
  if (v === undefined) return fallback;
  return v === "1" || v.toLowerCase() === "true" || v.toLowerCase() === "yes";
}

function envNum(names: string[], fallback: number): number {
  const v = envStr(...names);
  if (v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Minimum batch/metric export interval (ms). Blocks 0/negative tight-loop configs. */
export const MIN_EXPORT_INTERVAL_MS = 100;

/**
 * Clamp a resolved export-interval value. Non-finite values fall back to
 * `defaultMs`. Values below MIN_EXPORT_INTERVAL_MS are raised to that floor.
 */
export function clampExportIntervalMs(n: number, defaultMs: number): number {
  if (!Number.isFinite(n)) return defaultMs;
  return Math.max(MIN_EXPORT_INTERVAL_MS, Math.trunc(n));
}

/**
 * Clamp shutdown timeout. Non-finite falls back to `defaultMs`. Negatives
 * become 0 (immediate timeout); 0 is allowed so operators can skip waiting.
 */
export function clampShutdownTimeoutMs(n: number, defaultMs: number): number {
  if (!Number.isFinite(n)) return defaultMs;
  return Math.max(0, Math.trunc(n));
}

/**
 * Clamp an exporter request timeout. The OTLP exporter constructor throws on
 * a non-positive or non-finite timeoutMillis, so invalid values must resolve
 * to the default here, never reach the exporter. Floor is 100ms.
 */
export function clampExportTimeoutMs(n: number, defaultMs: number): number {
  if (!Number.isFinite(n) || n < MIN_EXPORT_INTERVAL_MS) return defaultMs;
  return Math.trunc(n);
}

/**
 * Clamp a batch queue bound (queue size, batch size, batch export timeout).
 * Per the OTel env var spec, invalid values fall back to the default.
 */
export function clampPositiveInt(n: number, defaultVal: number): number {
  if (!Number.isFinite(n) || n < 1) return defaultVal;
  return Math.trunc(n);
}

const EXPORTER_TOKENS: ReadonlySet<string> = new Set(["otlp", "console", "none"]);

function dedupeValidExporterParts(parts: string[]): ExporterToken[] {
  const out: ExporterToken[] = [];
  const seen = new Set<ExporterToken>();
  for (const part of parts) {
    const token = part.trim().toLowerCase();
    if (!EXPORTER_TOKENS.has(token)) continue;
    const typed = token as ExporterToken;
    if (seen.has(typed)) continue;
    seen.add(typed);
    out.push(typed);
  }
  return out;
}

/** Parse comma-separated exporter env values; unknown tokens are dropped. */
export function parseExporters(raw: string | undefined, fallback: ExporterToken[]): ExporterToken[] {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = dedupeValidExporterParts(raw.split(","));
  return parsed.length > 0 ? parsed : fallback;
}

/** Validate exporter token arrays from settings JSON. */
export function parseExporterTokensFromArray(
  tokens: string[] | undefined,
  fallback: ExporterToken[],
): ExporterToken[] {
  if (!tokens || tokens.length === 0) return fallback;
  const parsed = dedupeValidExporterParts(tokens);
  return parsed.length > 0 ? parsed : fallback;
}

const SAMPLER_SPECS: ReadonlySet<string> = new Set([
  "always_on",
  "always_off",
  "traceidratio",
  "parentbased_traceidratio",
]);

/** Validate a sampler name; unknown values fall back to the spec default. */
export function normalizeSampler(v: string | undefined): SamplerSpec {
  const p = (v ?? "").trim().toLowerCase();
  return SAMPLER_SPECS.has(p) ? (p as SamplerSpec) : "parentbased_traceidratio";
}

/** Validate the semconv version; unknown values fall back to the default. */
export function normalizeSemconv(v: string | undefined): SemconvDialect {
  const p = (v ?? "").trim().toLowerCase();
  if (p === "1.36") return "1.36";
  if (p === "1.37") return "1.37";
  if (p === "1.43") return "1.43";
  return DEFAULT_SEMCONV;
}

function normalizeProtocol(v: string | undefined): Protocol {
  const p = (v ?? "").trim().toLowerCase();
  if (p === "grpc") return "grpc";
  if (p === "http/json") return "http/json";
  // default and explicit "http" / "http/protobuf" -> http/protobuf
  return "http/protobuf";
}

function normalizeCapture(v: string | undefined): ContentCapture {
  if (v === undefined || v.trim() === "") return "full"; // project requirement: capture everything by default
  const p = v.trim().toLowerCase();
  if (p === "metadata_only") return "metadata_only";
  if (p === "no_tool_content") return "no_tool_content";
  if (p === "true" || p === "1" || p === "full") return "full";
  if (p === "false" || p === "0") return "metadata_only";
  // Unrecognized explicit values fail closed: a typo must not turn on full
  // prompt capture. /otel-status shows the resolved value so this is
  // discoverable.
  return "metadata_only";
}

function normalizeDiag(v: string | undefined): DiagLogLevel {
  switch ((v ?? "").trim().toLowerCase()) {
    case "none": return DiagLogLevel.NONE;
    case "error": return DiagLogLevel.ERROR;
    case "warn":
    case "warning": return DiagLogLevel.WARN;
    case "info": return DiagLogLevel.INFO;
    case "debug": return DiagLogLevel.DEBUG;
    case "verbose":
    case "trace": return DiagLogLevel.VERBOSE;
    case "all": return DiagLogLevel.ALL;
    default: return DiagLogLevel.NONE;
  }
}

/** Derive a per-signal endpoint from a base. For HTTP, append /v1/<signal>;
 * for gRPC the base is a bare host:port and is returned unchanged. */
export function resolveSignalEndpoint(
  base: string,
  signal: "traces" | "metrics" | "logs",
  protocol: Protocol,
  explicit?: string,
): string {
  if (explicit) return explicit;
  const trimmed = base.replace(/\/+$/, "");
  if (protocol === "grpc") return trimmed;
  if (/\/v1\/(traces|metrics|logs)$/.test(trimmed)) return trimmed;
  return `${trimmed}/v1/${signal}`;
}

export function resolveConfig(cwd: string): ResolvedConfig {
  const project = readJson(join(cwd, ".pi", "settings.json"))?.otel ?? {};
  const global = readJson(join(homedir(), ".pi", "agent", "settings.json"))?.otel ?? {};
  // Project overrides global.
  const s: SettingsOtel = { ...global, ...project } as SettingsOtel;

  const baseEndpoint =
    envStr("OTEL_EXPORTER_OTLP_ENDPOINT") ?? s.endpoint ?? "http://localhost:4318";

  const protocol = normalizeProtocol(
    envStr(
      "OTEL_EXPORTER_OTLP_PROTOCOL",
      // Some setups use per-signal protocol vars; the traces one is a fine hint.
      "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL",
    ) ?? s.protocol,
  );

  const headers = {
    ...(s.headers ?? {}),
    ...parseKv(process.env.OTEL_EXPORTER_OTLP_HEADERS),
  };

  // Master enable: PI_OTEL_DISABLED and the spec's OTEL_SDK_DISABLED are
  // kill switches and win over any enable flag. Then env enable, then settings.
  const disabled =
    envBool(["PI_OTEL_DISABLED"], false) || envBool(["OTEL_SDK_DISABLED"], false);
  const enabled = disabled
    ? false
    : envBool(["PI_OTEL_ENABLED"], s.enabled ?? true);

  // Exporter request timeout: per-signal env > OTEL_EXPORTER_OTLP_TIMEOUT >
  // settings > spec default (10000). Invalid values fall back per signal.
  const otlpTimeoutEnv = envNum(["OTEL_EXPORTER_OTLP_TIMEOUT"], Number.NaN);
  const signalTimeout = (envName: string, settingsVal: number | undefined): number =>
    clampExportTimeoutMs(
      envNum(
        [envName],
        Number.isFinite(otlpTimeoutEnv) ? otlpTimeoutEnv : settingsVal ?? 10000,
      ),
      10000,
    );

  // Settings values arrive unvalidated JSON, so a non-numeric sampleRatio
  // must fall back to 1 rather than propagate NaN into the sampler.
  const rawRatio = envNum(["OTEL_TRACES_SAMPLER_ARG", "PI_OTEL_SAMPLE_RATIO"], s.sampleRatio ?? 1);
  const sampleRatio = Number.isFinite(rawRatio) ? Math.min(1, Math.max(0, rawRatio)) : 1;

  return {
    enabled,
    endpoint: baseEndpoint,
    tracesEndpoint: resolveSignalEndpoint(
      baseEndpoint,
      "traces",
      protocol,
      envStr("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT") ?? s.tracesEndpoint,
    ),
    metricsEndpoint: resolveSignalEndpoint(
      baseEndpoint,
      "metrics",
      protocol,
      envStr("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT") ?? s.metricsEndpoint,
    ),
    logsEndpoint: resolveSignalEndpoint(
      baseEndpoint,
      "logs",
      protocol,
      envStr("OTEL_EXPORTER_OTLP_LOGS_ENDPOINT") ?? s.logsEndpoint,
    ),
    protocol,
    headers,
    serviceName: envStr("OTEL_SERVICE_NAME", "PI_OTEL_SERVICE_NAME") ?? s.serviceName ?? "pi",
    // Settings first; OTEL_RESOURCE_ATTRIBUTES overrides and extends.
    resourceAttributes: {
      ...(s.resourceAttributes ?? {}),
      ...parseKv(process.env.OTEL_RESOURCE_ATTRIBUTES, true),
    },
    captureContent: normalizeCapture(envStr("PI_OTEL_CAPTURE_CONTENT") ?? s.captureContent),
    sampleRatio,
    metricExportInterval: clampExportIntervalMs(
      envNum(["OTEL_METRIC_EXPORT_INTERVAL", "PI_OTEL_METRIC_EXPORT_INTERVAL"], s.metricExportInterval ?? 10000),
      10000,
    ),
    tracesExporters: parseExporters(
      process.env.OTEL_TRACES_EXPORTER,
      parseExporterTokensFromArray(s.tracesExporters, ["otlp"]),
    ),
    metricsExporters: parseExporters(
      process.env.OTEL_METRICS_EXPORTER,
      parseExporterTokensFromArray(s.metricsExporters, ["otlp"]),
    ),
    logsExporters: parseExporters(
      process.env.OTEL_LOGS_EXPORTER,
      parseExporterTokensFromArray(s.logsExporters, ["otlp"]),
    ),
    tracesExportInterval: clampExportIntervalMs(
      envNum(
        ["OTEL_BSP_SCHEDULE_DELAY", "OTEL_TRACES_EXPORT_INTERVAL"],
        s.tracesExportInterval ?? 5000,
      ),
      5000,
    ),
    logsExportInterval: clampExportIntervalMs(
      envNum(
        ["OTEL_BLP_SCHEDULE_DELAY", "OTEL_LOGS_EXPORT_INTERVAL"],
        s.logsExportInterval ?? 5000,
      ),
      5000,
    ),
    traces: { enabled: envBool(["PI_OTEL_TRACES"], s.traces ?? true) },
    metrics: { enabled: envBool(["PI_OTEL_METRICS"], s.metrics ?? true) },
    logs: { enabled: envBool(["PI_OTEL_LOGS"], s.logs ?? true) },
    sampler: normalizeSampler(envStr("OTEL_TRACES_SAMPLER") ?? s.sampler),
    semconv: normalizeSemconv(envStr("PI_OTEL_SEMCONV") ?? s.semconv),
    tracesExportTimeoutMs: signalTimeout("OTEL_EXPORTER_OTLP_TRACES_TIMEOUT", s.tracesExportTimeoutMs),
    metricsExportTimeoutMs: signalTimeout("OTEL_EXPORTER_OTLP_METRICS_TIMEOUT", s.metricsExportTimeoutMs),
    logsExportTimeoutMs: signalTimeout("OTEL_EXPORTER_OTLP_LOGS_TIMEOUT", s.logsExportTimeoutMs),
    tracesMaxQueueSize: clampPositiveInt(envNum(["OTEL_BSP_MAX_QUEUE_SIZE"], s.tracesMaxQueueSize ?? 2048), 2048),
    tracesMaxExportBatchSize: clampPositiveInt(envNum(["OTEL_BSP_MAX_EXPORT_BATCH_SIZE"], s.tracesMaxExportBatchSize ?? 512), 512),
    tracesBatchExportTimeoutMs: clampExportIntervalMs(envNum(["OTEL_BSP_EXPORT_TIMEOUT"], s.tracesBatchExportTimeoutMs ?? 30000), 30000),
    logsMaxQueueSize: clampPositiveInt(envNum(["OTEL_BLP_MAX_QUEUE_SIZE"], s.logsMaxQueueSize ?? 2048), 2048),
    logsMaxExportBatchSize: clampPositiveInt(envNum(["OTEL_BLP_MAX_EXPORT_BATCH_SIZE"], s.logsMaxExportBatchSize ?? 512), 512),
    logsBatchExportTimeoutMs: clampExportIntervalMs(envNum(["OTEL_BLP_EXPORT_TIMEOUT"], s.logsBatchExportTimeoutMs ?? 30000), 30000),
    diagLogLevel: normalizeDiag(envStr("OTEL_LOG_LEVEL", "PI_OTEL_DIAG_LOG_LEVEL") ?? s.diagLogLevel),
    selfLogs: envBool(["PI_OTEL_SELF_LOGS"], s.selfLogs ?? true),
    shutdownTimeoutMs: clampShutdownTimeoutMs(
      envNum(["PI_OTEL_SHUTDOWN_TIMEOUT_MS"], s.shutdownTimeoutMs ?? 2000),
      2000,
    ),
    cwd,
  };
}

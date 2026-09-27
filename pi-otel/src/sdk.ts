/**
 * OTel SDK bootstrap and teardown.
 *
 * One TelemetryRuntime per session. All SDK objects (providers, processors,
 * readers, exporters) are created here in `startRuntime` and torn down in
 * the runtime's `shutdown`. We deliberately never register globals
 * (`trace.setGlobalTracerProvider`, etc.) so that pi's `/reload` and session
 * replacement flows don't leak zombie providers that keep exporting after the
 * session that created them is gone.
 */

import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { hostname, userInfo, version as nodeVersion } from "node:os";
import type { Agent as HttpAgent } from "node:http";
import type { Agent as HttpsAgent } from "node:https";
// VERSION is the running pi's own version string: pi's extension loader
// aliases this specifier to the host package, so it reports the pi that is
// executing this extension, not a bundled copy (which import.meta.resolve
// or require.resolve could find instead — and under jiti, import.meta.resolve
// is rewritten to an undefined global, so it returned "unknown").
import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import { extensionVersion } from "./version.js";
import {
  diag,
  type DiagLogger,
  type Tracer,
  type Sampler,
} from "@opentelemetry/api";
import type { SpanExporter, SpanProcessor, ReadableSpan } from "@opentelemetry/sdk-trace-base";
import type { PushMetricExporter } from "@opentelemetry/sdk-metrics";
import type { LogRecordExporter, LogRecordProcessor } from "@opentelemetry/sdk-logs";
import { OTLPLogExporter as LogProtoExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import { AggregationTemporalityPreference } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPMetricExporter as MetricProtoExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPTraceExporter as TraceProtoExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import {
  detectResources,
  hostDetector,
  osDetector,
  processDetector,
  resourceFromAttributes,
  serviceInstanceIdDetector,
  type Resource,
} from "@opentelemetry/resources";
import {
  BatchLogRecordProcessor,
  ConsoleLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import {
  ConsoleMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  ConsoleSpanExporter,
  AlwaysOffSampler,
  ParentBasedSampler,
  SimpleSpanProcessor,
  TraceIdRatioBasedSampler,
} from "@opentelemetry/sdk-trace-base";
import {
  ATTR_SERVICE_INSTANCE_ID,
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";
import type { ExporterToken, Protocol, ResolvedConfig } from "./config.js";
import { createMetrics, type Metrics } from "./metrics.js";
import { createLogger } from "./logging.js";
import type { Logger } from "@opentelemetry/api-logs";

const TRACER_NAME = "pi-otel";
const TRACER_VERSION = extensionVersion();

/** Last error observed from any exporter, plus the last shutdown failure.
 * Surfaced via /otel-status. */
export interface ExportHealth {
  tracesError?: string;
  metricsError?: string;
  logsError?: string;
  lastShutdownError?: string;
  /** Total spans accepted by a batch processor (onEnd). */
  spansAccepted: number;
  /** Total spans accepted by a successful export (sum of batch sizes). */
  spansExported: number;
  /** Total log records accepted by a batch processor (onEmit). */
  logRecordsAccepted: number;
  /** Successful metric export calls (one ResourceMetrics payload each). */
  metricBatchesExported: number;
  /** Total log records accepted by a successful export (sum of batch sizes). */
  logRecordsExported: number;
}

export interface RuntimeOptions {
  /** When true, the process runs with a dialog-capable UI (pi's TUI and rpc
   *  modes). Console exporters would spam the display, so the console token
   *  is stripped from every signal. */
  hasUI?: boolean;
  /** pi's run mode ("tui" | "rpc" | "json" | "print"). `json` mode streams
   *  session events as JSON lines on stdout, so console exporters corrupt
   *  that channel just like the TUI; they are stripped there too. Print mode
   *  keeps console output as the documented debugging mirror. Undefined on
   *  pi versions without ctx.mode; stripping then falls back to hasUI. */
  mode?: string;
}

export interface TelemetryRuntime {
  config: ResolvedConfig;
  tracer: Tracer;
  /** Metric instruments bound to this runtime's meter provider (null if metrics off). */
  metrics: Metrics | null;
  /** Logger bound to this runtime's logger provider (null if logs off). */
  logger: Logger | null;
  loggerProvider?: LoggerProvider;
  meterProvider?: MeterProvider;
  traceProvider?: BasicTracerProvider;
  health: ExportHealth;
  /** Force-flush all active providers. Best-effort; never throws. */
  flush: () => Promise<void>;
  /** Shut down all active providers and release resources. Idempotent. */
  shutdown: () => Promise<void>;
  /** Detach the SIGTERM/SIGHUP handlers registered for this runtime. */
  removeProcessHooks: () => void;
}

export interface ExporterOpts {
  url: string;
  headers: Record<string, string>;
  /** Request timeout. The OTLP exporter constructor throws on <= 0 or NaN;
   * config resolution guarantees a positive finite value. */
  timeoutMillis: number;
  /** Agent options or factory for the HTTP exporters. Passing the reaper's
   * factory lets shutdown abort in-flight exports; ignored by the gRPC
   * exporters, which own their channels. */
  httpAgentOptions?: HttpAgentOptions;
}

export type HttpAgentOptions =
  | import("node:http").AgentOptions
  | import("node:https").AgentOptions
  | ((protocol: string) => HttpAgent | HttpsAgent | Promise<HttpAgent> | Promise<HttpsAgent>);

/**
 * Owns the HTTP agents this runtime's exporters create, so shutdown can
 * abort in-flight exports.
 *
 * A pending export keeps its socket referenced, and a referenced socket
 * keeps Node's event loop alive: a collector that accepts the connection and
 * never responds holds the process open until the exporter's own
 * (potentially much longer) timeout fires. agent.destroy() does not help —
 * it only reaps idle keep-alive sockets. Destroying the ACTIVE sockets
 * settles the pending exports with a network error so the loop can drain.
 */
export class ExportSocketReaper {
  private readonly agents = new Set<HttpAgent | HttpsAgent>();

  /** HttpAgentFactory-compatible. Dynamic import per the exporter docs so
   * @opentelemetry/instrumentation-http can instrument the module first;
   * keepAlive matches the exporter default. */
  readonly agentFactory = async (protocol: string): Promise<HttpAgent | HttpsAgent> => {
    const mod = protocol === "http:" ? await import("node:http") : await import("node:https");
    const agent = new mod.Agent({ keepAlive: true });
    this.agents.add(agent);
    return agent;
  };

  /** Destroy every in-flight socket across the agents this factory created.
   * No-op when nothing is in flight. */
  destroyActiveSockets(): void {
    for (const agent of this.agents) {
      const sockets = (agent as { sockets?: Record<string, Array<{ destroy(): void }>> }).sockets ?? {};
      for (const list of Object.values(sockets)) {
        for (const socket of list) {
          try { socket.destroy(); } catch { /* already gone */ }
        }
      }
    }
  }
}

/** Build grpc Metadata from plain headers. The grpc exporter config omits
 * `headers` (it takes `metadata` instead), so passing headers straight through
 * silently drops authentication on gRPC. */
export async function grpcMetadataFromHeaders(
  headers: Record<string, string>,
): Promise<import("@grpc/grpc-js").Metadata> {
  const { Metadata } = await import("@grpc/grpc-js");
  const metadata = new Metadata();
  for (const [k, v] of Object.entries(headers)) metadata.set(k, v);
  return metadata;
}

/**
 * Resolve metric aggregation temporality without mutating process.env.
 * Honors OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE when set; defaults
 * to DELTA for short-lived agent processes (cumulative counters reset per run).
 */
export function resolveMetricTemporalityPreference(
  env: NodeJS.ProcessEnv = process.env,
): AggregationTemporalityPreference {
  const raw = env.OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE?.trim().toLowerCase();
  if (raw === "cumulative") return AggregationTemporalityPreference.CUMULATIVE;
  if (raw === "lowmemory") return AggregationTemporalityPreference.LOWMEMORY;
  // unset, "delta", or unknown -> DELTA (agent-friendly default)
  return AggregationTemporalityPreference.DELTA;
}

async function newTraceExporter(p: Protocol, o: ExporterOpts): Promise<SpanExporter> {
  if (p === "grpc") {
    const [{ OTLPTraceExporter }, metadata] = await Promise.all([
      import("@opentelemetry/exporter-trace-otlp-grpc"),
      grpcMetadataFromHeaders(o.headers),
    ]);
    return new OTLPTraceExporter({ url: o.url, metadata, timeoutMillis: o.timeoutMillis });
  }
  if (p === "http/json") {
    const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-http");
    return new OTLPTraceExporter(o);
  }
  return new TraceProtoExporter(o);
}
async function newMetricExporter(p: Protocol, o: ExporterOpts): Promise<PushMetricExporter> {
  const opts = { ...o, temporalityPreference: resolveMetricTemporalityPreference() };
  if (p === "grpc") {
    const [{ OTLPMetricExporter }, metadata] = await Promise.all([
      import("@opentelemetry/exporter-metrics-otlp-grpc"),
      grpcMetadataFromHeaders(o.headers),
    ]);
    return new OTLPMetricExporter({
      url: o.url,
      metadata,
      timeoutMillis: o.timeoutMillis,
      temporalityPreference: opts.temporalityPreference,
    });
  }
  if (p === "http/json") {
    const { OTLPMetricExporter } = await import("@opentelemetry/exporter-metrics-otlp-http");
    return new OTLPMetricExporter(opts);
  }
  return new MetricProtoExporter(opts);
}
async function newLogExporter(p: Protocol, o: ExporterOpts): Promise<LogRecordExporter> {
  if (p === "grpc") {
    const [{ OTLPLogExporter }, metadata] = await Promise.all([
      import("@opentelemetry/exporter-logs-otlp-grpc"),
      grpcMetadataFromHeaders(o.headers),
    ]);
    return new OTLPLogExporter({ url: o.url, metadata, timeoutMillis: o.timeoutMillis });
  }
  if (p === "http/json") {
    const { OTLPLogExporter } = await import("@opentelemetry/exporter-logs-otlp-http");
    return new OTLPLogExporter(o);
  }
  return new LogProtoExporter(o);
}

/** Build the sampler for the resolved config. Undefined means the SDK default
 * (parent-based always-on), which is what always_on and an unsampled
 * parentbased_traceidratio resolve to. */
export function buildSampler(cfg: ResolvedConfig): Sampler | undefined {
  if (cfg.sampler === "always_on") return undefined;
  if (cfg.sampler === "always_off") return new AlwaysOffSampler();
  const ratio = Math.min(1, Math.max(0, cfg.sampleRatio));
  if (cfg.sampler === "traceidratio") return new TraceIdRatioBasedSampler(ratio);
  if (ratio >= 1) return undefined;
  return new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(ratio) });
}

type SdkSpan = Parameters<SpanProcessor["onStart"]>[0];
type SpanParentContext = Parameters<SpanProcessor["onStart"]>[1];

/**
 * Delegating SpanProcessor that counts spans handed to the inner batch
 * processor (onEnd = queued for export). Accepted minus exported, read after
 * a flush, surfaces queue drops and failed exports in /otel-status.
 */
export class CountingSpanProcessor implements SpanProcessor {
  constructor(
    readonly inner: SpanProcessor,
    private readonly onAccept: () => void,
  ) {}
  onStart(span: SdkSpan, parentContext: SpanParentContext): void {
    this.inner.onStart(span, parentContext);
  }
  onEnd(span: ReadableSpan): void {
    this.onAccept();
    this.inner.onEnd(span);
  }
  forceFlush(): Promise<void> {
    return this.inner.forceFlush();
  }
  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }
}

type LogRecordLike = Parameters<LogRecordProcessor["onEmit"]>[0];
type LogEmitContext = Parameters<LogRecordProcessor["onEmit"]>[1];

/** Delegating LogRecordProcessor that counts records handed to the inner
 * batch processor. Same accepted-vs-exported visibility as spans. */
export class CountingLogRecordProcessor implements LogRecordProcessor {
  constructor(
    readonly inner: LogRecordProcessor,
    private readonly onAccept: () => void,
  ) {}
  onEmit(logRecord: LogRecordLike, context?: LogEmitContext): void {
    this.onAccept();
    this.inner.onEmit(logRecord, context);
  }
  forceFlush(): Promise<void> {
    return this.inner.forceFlush();
  }
  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }
}

/** Generic export-result shape used by all three exporter families. */
interface ExportResult {
  code: number;
  error?: Error;
}
type ExportFn = (items: unknown, cb: (r: ExportResult) => void) => void;

/** Count items in a trace/log export payload. Metric payloads are not arrays. */
function exportItemCount(items: unknown): number {
  return Array.isArray(items) ? items.length : 0;
}

/**
 * Wrap an exporter's export() so the last failure is captured for /otel-status
 * without propagating the error (exporters already retry internally).
 * onResult receives the number of items in the batch on success (0 for metrics).
 */
function trackHealth<T>(
  exporter: T,
  onResult: (ok: boolean, itemCount: number, errMsg?: string) => void,
): T {
  const orig = (exporter as unknown as { export: ExportFn }).export.bind(exporter) as ExportFn;
  (exporter as unknown as { export: ExportFn }).export = ((items: unknown, cb: (r: ExportResult) => void) => {
    const count = exportItemCount(items);
    orig(items, (result) => {
      if (result.code === 0) onResult(true, count);
      else onResult(false, count, result.error?.message ?? "export failed");
      cb(result);
    });
  }) as ExportFn;
  return exporter;
}

/** Bound an exporter request timeout by the shutdown budget.
 *
 * An export that cannot finish within the shutdown budget can never be
 * flushed at exit, and its pending request keeps the process's event loop
 * open until its own — possibly much longer — timeout fires; the exporter's
 * retry logic would then keep the chain alive for up to five further
 * attempts. Bounding the request timeout at the budget makes the export
 * deadline and the shutdown deadline expire together, so pending exports
 * settle and the process exits on schedule. The floor keeps the exporter
 * constructor's positive-timeout requirement satisfied when the budget is 0
 * (skip-wait). Users with slow collectors raise PI_OTEL_SHUTDOWN_TIMEOUT_MS,
 * which raises this bound with it. */
export function boundedExportTimeout(timeoutMs: number, shutdownTimeoutMs: number): number {
  return Math.max(100, Math.min(timeoutMs, shutdownTimeoutMs));
}

/** True when the OS reports a username; "unknown" when userInfo() throws
 * (containers running an arbitrary UID with no passwd entry). Injectable for
 * tests. */
export function processOwner(
  userInfoFn: () => { username?: string } = userInfo,
): string {
  try {
    return userInfoFn().username ?? "unknown";
  } catch {
    return "unknown";
  }
}
/**
 * Detect a stable host.id. Falls back to hostname when no platform id exists.
 */
export function detectHostId(): string {
  if (process.platform === "linux") {
    for (const candidate of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
      try {
        const id = readFileSync(candidate, "utf8").trim();
        if (id) return id;
      } catch {
        // missing or unreadable — try the next candidate
      }
    }
  }
  return hostname();
}

/** The running pi coding agent's version string ("0.0.0" if unreadable). */
export function piVersion(): string {
  return typeof PI_VERSION === "string" && PI_VERSION.length > 0 ? PI_VERSION : "0.0.0";
}

/** True when the running pi is at least `min` (semver major.minor.patch).
 * Unresolvable or malformed versions compare as older than everything, so
 * feature detection falls back to the conservative path. */
export function piAtLeast(min: string, version: string = piVersion()): boolean {
  const parse = (v: string): [number, number, number] | null => {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
    if (!m) return null;
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  };
  const got = parse(version);
  const want = parse(min);
  if (!got || !want) return false;
  const [g0, g1, g2] = got;
  const [w0, w1, w2] = want;
  if (g0 !== w0) return g0 > w0;
  if (g1 !== w1) return g1 > w1;
  if (g2 !== w2) return g2 > w2;
  return true;
}

export async function buildResource(cfg: ResolvedConfig): Promise<Resource> {
  // Auto-detect host/process/os/service-instance via SDK detectors.
  const detected = await detectResources({
    detectors: [hostDetector, processDetector, osDetector, serviceInstanceIdDetector],
  });

  const piAttrs: Record<string, string> = {
    [ATTR_SERVICE_NAME]: cfg.serviceName,
    [ATTR_SERVICE_VERSION]: piVersion(),
    [ATTR_SERVICE_INSTANCE_ID]: `${process.pid}-${randomBytes(4).toString("hex")}`,
    "host.name": hostname(),
    "host.id": detectHostId(),
    "process.runtime.name": "node",
    "process.runtime.version": nodeVersion(),
    "process.owner": processOwner(),
    "pi.cwd": cfg.cwd,
    "pi.extension.name": TRACER_NAME,
    "pi.extension.version": TRACER_VERSION,
  };

  // Merge: detected (lowest) < pi attrs < user OTEL_RESOURCE_ATTRIBUTES (highest).
  return detected
    .merge(resourceFromAttributes(piAttrs))
    .merge(resourceFromAttributes(cfg.resourceAttributes));
}

/**
 * Resolve the exporter token list for one signal. Console exporters are
 * stripped whenever stdout is a protocol channel — the TUI renderer, the rpc
 * JSON-RPC stream, or the json-mode event stream — because span/log JSON on
 * stdout corrupts all three. Print mode's stdout carries only the final
 * answer, so console stays as the documented debugging mirror. If stripping
 * leaves nothing (e.g. only console was configured), fall back to otlp so
 * telemetry is not silently dropped.
 */
export function effectiveExporterTokens(
  tokens: ExporterToken[],
  hasUI: boolean,
  mode: string | undefined = undefined,
): ExporterToken[] {
  const consoleCorruptsChannel = hasUI || mode === "json";
  let effective = consoleCorruptsChannel ? tokens.filter((t) => t !== "console") : [...tokens];
  if (effective.length === 0) effective = ["otlp"];
  return effective;
}

/** True when the signal should get a provider (not disabled and not only "none"). */
function signalExportersActive(tokens: ExporterToken[]): boolean {
  return tokens.length > 0 && !(tokens.length === 1 && tokens[0] === "none");
}

/** Process surface needed by installSignalShutdown. Injectable for tests. */
export interface SignalCapableProcess {
  pid: number;
  on(signal: string, listener: () => void): unknown;
  removeListener(signal: string, listener: () => void): unknown;
  listenerCount(signal: string): number;
  kill(pid: number, signal?: string): unknown;
}

const SIGNALS = ["SIGTERM", "SIGHUP"] as const;

/**
 * Best-effort flush on SIGTERM/SIGHUP.
 *
 * Crash insurance: pi fires session_shutdown on normal exit, but a host that
 * does not forward signals to extensions (or an older pi) can skip it, so we
 * register on SIGTERM/SIGHUP to flush+shutdown. Registering a listener
 * replaces the signal's default termination, so once the flush finishes, if
 * no other handler is left (current pi versions install their own), the
 * signal is re-raised to restore default exit semantics. We deliberately do
 * NOT register on 'exit' or 'beforeExit': 'beforeExit' re-arms the event loop
 * when its async work schedules, looping indefinitely; 'exit' runs
 * synchronously and cannot await the flush.
 *
 * Returns a detach function so callers can remove the handlers when the
 * runtime is replaced (reload) without stacking a fresh pair of listeners.
 */
export function installSignalShutdown(
  shutdown: () => Promise<void>,
  proc: SignalCapableProcess = process,
): () => void {
  const listeners = SIGNALS.map((signal) => {
    const listener = () => {
      // Swallow a failed flush (e.g. hung collector) so the re-raise below
      // still runs and no unhandled rejection surfaces.
      void shutdown()
        .catch(() => {})
        .finally(() => {
          proc.removeListener(signal, listener);
          // If we were the last handler, the process would otherwise stay
          // alive with termination replaced. Re-raise so the default action
          // runs (exit code 143 on SIGTERM).
          if (proc.listenerCount(signal) === 0) proc.kill(proc.pid, signal);
        });
    };
    proc.on(signal, listener);
    return { signal, listener } as const;
  });
  return () => {
    for (const { signal, listener } of listeners) proc.removeListener(signal, listener);
  };
}

export async function startRuntime(
  cfg: ResolvedConfig,
  opts: RuntimeOptions = {},
): Promise<TelemetryRuntime> {
  const hasUI = opts.hasUI ?? false;
  const mode = opts.mode;
  const health: ExportHealth = {
    spansAccepted: 0,
    spansExported: 0,
    logRecordsAccepted: 0,
    metricBatchesExported: 0,
    logRecordsExported: 0,
  };

  // diag is the only global we touch. Default NONE. Diagnostics go to
  // stderr: stdout belongs to the TUI renderer in interactive mode, and a
  // diag line on it would corrupt the display.
  diag.setLogger(stderrDiagLogger(), {
    logLevel: cfg.diagLogLevel,
    suppressOverrideMessage: true,
  });

  const resource = await buildResource(cfg);

  // --- Traces ---
  const socketReaper = new ExportSocketReaper();
  const agentOpts = { httpAgentOptions: socketReaper.agentFactory };
  let traceProvider: BasicTracerProvider | undefined;
  if (cfg.enabled && cfg.traces.enabled) {
    const traceTokens = effectiveExporterTokens(cfg.tracesExporters, hasUI, mode);
    if (signalExportersActive(traceTokens)) {
      const spanProcessors = [];
      for (const token of traceTokens) {
        if (token === "none") continue;
        if (token === "otlp") {
          // A malformed endpoint URL throws in the exporter constructor. Fail
          // this signal alone and keep the others: one typo'd endpoint must
          // not take down the whole runtime, and /otel-status shows the error.
          let exporter: SpanExporter;
          try {
            exporter = trackHealth(
              await newTraceExporter(cfg.protocol, { url: cfg.tracesEndpoint, headers: cfg.headers, timeoutMillis: boundedExportTimeout(cfg.tracesExportTimeoutMs, cfg.shutdownTimeoutMs), ...agentOpts }),
              (ok, count, err) => {
                if (ok) { health.spansExported += count; health.tracesError = undefined; }
                else { health.tracesError = err; }
              },
            );
          } catch (err) {
            health.tracesError = `exporter construction failed: ${err instanceof Error ? err.message : String(err)}`;
            continue;
          }
          spanProcessors.push(
            new CountingSpanProcessor(
              new BatchSpanProcessor(exporter, {
                scheduledDelayMillis: cfg.tracesExportInterval,
                maxQueueSize: cfg.tracesMaxQueueSize,
                maxExportBatchSize: cfg.tracesMaxExportBatchSize,
                exportTimeoutMillis: cfg.tracesBatchExportTimeoutMs,
              }),
              () => { health.spansAccepted++; },
            ),
          );
        } else if (token === "console") {
          spanProcessors.push(new SimpleSpanProcessor(new ConsoleSpanExporter()));
        }
      }
      if (spanProcessors.length > 0) {
        traceProvider = new BasicTracerProvider({
          resource,
          sampler: buildSampler(cfg),
          spanProcessors,
        });
      }
    }
  }

  // --- Metrics ---
  let meterProvider: MeterProvider | undefined;
  if (cfg.enabled && cfg.metrics.enabled) {
    const metricTokens = effectiveExporterTokens(cfg.metricsExporters, hasUI, mode);
    if (signalExportersActive(metricTokens)) {
      const readers = [];
      for (const token of metricTokens) {
        if (token === "none") continue;
        if (token === "otlp") {
          let exporter: PushMetricExporter;
          try {
            exporter = trackHealth(
              await newMetricExporter(cfg.protocol, { url: cfg.metricsEndpoint, headers: cfg.headers, timeoutMillis: boundedExportTimeout(cfg.metricsExportTimeoutMs, cfg.shutdownTimeoutMs), ...agentOpts }),
              (ok, _count, err) => {
                if (ok) { health.metricBatchesExported++; health.metricsError = undefined; }
                else { health.metricsError = err; }
              },
            );
          } catch (err) {
            health.metricsError = `exporter construction failed: ${err instanceof Error ? err.message : String(err)}`;
            continue;
          }
          readers.push(
            new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: cfg.metricExportInterval }),
          );
        } else if (token === "console") {
          readers.push(
            new PeriodicExportingMetricReader({
              exporter: new ConsoleMetricExporter(),
              exportIntervalMillis: cfg.metricExportInterval,
            }),
          );
        }
      }
      if (readers.length > 0) {
        meterProvider = new MeterProvider({ resource, readers });
      }
    }
  }

  // --- Logs ---
  let loggerProvider: LoggerProvider | undefined;
  if (cfg.enabled && cfg.logs.enabled) {
    const logTokens = effectiveExporterTokens(cfg.logsExporters, hasUI, mode);
    if (signalExportersActive(logTokens)) {
      const processors = [];
      for (const token of logTokens) {
        if (token === "none") continue;
        if (token === "otlp") {
          let exporter: LogRecordExporter;
          try {
            exporter = trackHealth(
              await newLogExporter(cfg.protocol, { url: cfg.logsEndpoint, headers: cfg.headers, timeoutMillis: boundedExportTimeout(cfg.logsExportTimeoutMs, cfg.shutdownTimeoutMs), ...agentOpts }),
              (ok, count, err) => {
                if (ok) { health.logRecordsExported += count; health.logsError = undefined; }
                else { health.logsError = err; }
              },
            );
          } catch (err) {
            health.logsError = `exporter construction failed: ${err instanceof Error ? err.message : String(err)}`;
            continue;
          }
          processors.push(
            new CountingLogRecordProcessor(
              // sdk-logs 0.220 moved the exporter into a single options object.
              new BatchLogRecordProcessor({
                exporter,
                scheduledDelayMillis: cfg.logsExportInterval,
                maxQueueSize: cfg.logsMaxQueueSize,
                maxExportBatchSize: cfg.logsMaxExportBatchSize,
                exportTimeoutMillis: cfg.logsBatchExportTimeoutMs,
              }),
              () => { health.logRecordsAccepted++; },
            ),
          );
        } else if (token === "console") {
          processors.push(new SimpleLogRecordProcessor({ exporter: new ConsoleLogRecordExporter() }));
        }
      }
      if (processors.length > 0) {
        loggerProvider = new LoggerProvider({ resource, processors });
      }
    }
  }

  const tracer = traceProvider?.getTracer(TRACER_NAME, TRACER_VERSION) ?? noopTracer();
  // Bind instruments/logger to this runtime so a reload cannot keep writing
  // into a provider that has already been shut down.
  const metrics = createMetrics(meterProvider, cfg.semconv);
  const logger = createLogger(loggerProvider);

  let shutdownStarted = false;

  const flush = async (): Promise<void> => {
    if (shutdownStarted) return;
    await Promise.allSettled([
      traceProvider?.forceFlush(),
      meterProvider?.forceFlush(),
      loggerProvider?.forceFlush(),
    ]);
  };

  // Run forceFlush then shutdown for each provider in parallel, then race the
  // whole thing against a timeout. A slow or dead collector endpoint would
  // otherwise hang pi's exit. Each provider chains flush->shutdown so a slow
  // logger flush does not delay the meter or tracer shutdown.
  const shutdown = async (): Promise<void> => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    removeProcessHooks();
    // When the deadline wins, destroy in-flight export sockets so pending
    // requests settle and the event loop can drain (see ExportSocketReaper).
    await shutdownProviders(traceProvider, meterProvider, loggerProvider, cfg.shutdownTimeoutMs, health, () => socketReaper.destroyActiveSockets());
  };

  // Registered after `shutdown` exists; the listeners only fire long after
  // this function returns. See installSignalShutdown for the re-raise logic.
  const removeProcessHooks = installSignalShutdown(shutdown);

  return {
    config: cfg,
    tracer,
    metrics,
    logger,
    traceProvider,
    meterProvider,
    loggerProvider,
    health,
    flush,
    shutdown,
    removeProcessHooks,
  };
}

/** Minimal provider surface that shutdown needs: forceFlush + shutdown. */
interface ShutdownableProvider {
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

/**
 * Run forceFlush then shutdown for each provider in parallel, racing the whole
 * thing against `timeoutMs`. On timeout, record the failure on `health`, call
 * `onTimeout` (used to abort in-flight export sockets so the process can
 * actually exit), and swallow the error: a broken collector must never block
 * pi's exit. Each provider chains flush->shutdown so a slow logger flush does
 * not delay the meter or tracer shutdown. Extracted from `startRuntime` so
 * the timeout behavior is unit-testable without spinning up a real collector
 * socket.
 */
export async function shutdownProviders(
  traceProvider: ShutdownableProvider | undefined,
  meterProvider: ShutdownableProvider | undefined,
  loggerProvider: ShutdownableProvider | undefined,
  timeoutMs: number,
  health: ExportHealth,
  onTimeout?: () => void,
): Promise<void> {
  const chains: Promise<void>[] = [];
  if (traceProvider) chains.push(traceProvider.forceFlush().then(() => traceProvider.shutdown()));
  if (meterProvider) chains.push(meterProvider.forceFlush().then(() => meterProvider.shutdown()));
  if (loggerProvider) chains.push(loggerProvider.forceFlush().then(() => loggerProvider.shutdown()));
  if (chains.length === 0) return;
  // Attach a no-op catch so that, if the timeout wins the race, any later
  // rejection from the still-in-flight provider work does not surface as an
  // unhandled rejection. We already record the timeout on `health` below.
  const all = Promise.all(chains).catch(() => {});
  try {
    await Promise.race([
      all,
      timeoutAfter(timeoutMs, "OpenTelemetry shutdown timeout"),
    ]);
  } catch (err) {
    health.lastShutdownError = err instanceof Error ? err.message : String(err);
    // Abort in-flight export sockets so their pending requests settle; the
    // provider chains still complete (or already have) and the event loop can
    // drain. Swallow errors from the hook itself: teardown must not throw.
    try { onTimeout?.(); } catch { /* best-effort */ }
  }
}

/** Reject after `ms`. Used to bound shutdown against a dead collector. */
function timeoutAfter(ms: number, message: string): Promise<never> {
  return new Promise((_resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    t.unref?.();
  });
}

/** A diag logger that writes every accepted message to stderr. diag's own
 * level filter (set at setLogger time) decides what reaches it. */
function stderrDiagLogger(): DiagLogger {
  const write = (message: string) => console.error(message);
  return { verbose: write, debug: write, info: write, warn: write, error: write };
}

function noopTracer(): Tracer {
  // Full Span surface so a traces-disabled path never throws on a missing
  // method if a caller or future OTel API path exercises more of the type.
  // We build this locally rather than using the global no-op tracer so this
  // module never registers or reads global providers.
  const noopSpan = {
    spanContext: () => ({ traceId: "", spanId: "", traceFlags: 0, isRemote: false }),
    setAttribute() { return this; },
    setAttributes() { return this; },
    addEvent() { return this; },
    addLink() { return this; },
    addLinks() { return this; },
    setStatus() { return this; },
    updateName() { return this; },
    end() {},
    isRecording() { return false; },
    recordException() {},
  };
  return {
    startSpan: () => noopSpan,
    startActiveSpan: (_name: string, ...args: unknown[]) => {
      // OTel overloads: (name, fn) | (name, options, fn) | (name, options, context, fn)
      const fn = args[args.length - 1];
      if (typeof fn === "function") return (fn as (span: typeof noopSpan) => unknown)(noopSpan);
      return noopSpan;
    },
  } as Tracer;
}

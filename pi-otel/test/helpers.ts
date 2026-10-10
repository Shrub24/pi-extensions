/**
 * Test helpers: build a SpanTracker wired to in-memory exporters so tests can
 * inspect the spans/metrics/logs that would otherwise be shipped over OTLP.
 */

import { BasicTracerProvider, BatchSpanProcessor, InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { SpanKind, type Attributes, type Tracer } from "@opentelemetry/api";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { SpanTracker, type MessageShapes } from "../src/tracker.ts";
import type { Metrics } from "../src/metrics.ts";
import type { ResolvedConfig } from "../src/config.ts";
import { ATTR_PI_INTERACTION_ID, SPAN_INTERACTION } from "../src/attrs.ts";

export interface Harness {
  tracer: Tracer;
  spanExporter: InMemorySpanExporter;
  tracker: SpanTracker;
  metrics: RecordingMetrics;
  /** Force-flush the batch processor so ended spans land in the exporter. */
  flush: () => Promise<void>;
  /** All finished spans keyed by name, with title-named roots indexed as SPAN_INTERACTION. */
  spansByName: () => Record<string, ReturnType<InMemorySpanExporter["getFinishedSpans"]>[number]>;
  /** Finished span by name or interaction identity; throws when absent so a
   * missing span fails the test instead of tripping strict-index checks. */
  span: (name: string) => ReturnType<InMemorySpanExporter["getFinishedSpans"]>[number];
  reset: () => void;
}

/** A Metrics implementation that records add()/record() calls for assertions. */
export class RecordingMetrics {
  counters: Record<string, Array<{ value: number; attrs: Record<string, unknown> }>> = {};
  histograms: Record<string, Array<{ value: number; attrs: Record<string, unknown> }>> = {};

  private rec(map: Record<string, Array<{ value: number; attrs: Record<string, unknown> }>>, name: string, value: number, attrs: Record<string, unknown>) {
    (map[name] ??= []).push({ value, attrs });
  }
  counter(name: string) {
    return {
      add: (value: number, attrs: Record<string, unknown> = {}) => this.rec(this.counters, name, value, attrs),
    };
  }
  histogram(name: string) {
    return {
      record: (value: number, attrs: Record<string, unknown> = {}) => this.rec(this.histograms, name, value, attrs),
    };
  }
}

/** A minimal Metrics-shaped object built from a RecordingMetrics instance. */
export function recordingMetricsOf(r: RecordingMetrics): Metrics {
  return {
    opDuration: r.histogram("op"),
    timeToFirstToken: r.histogram("ttft"),
    timeToCompletion: r.histogram("completion"),
    tokenUsage: r.histogram("tokens"),
    toolCalls: r.counter("toolcalls"),
    sessionDuration: r.histogram("sdur"),
    promptCount: r.counter("prompts"),
    turnCount: r.counter("turns"),
    providerRetries: r.counter("retries"),
    turnCancellations: r.counter("cancels"),
    compactionCount: r.counter("compactions"),
  };
}

/** Build a config that matches the harness defaults. */
export function harnessConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    enabled: true,
    endpoint: "http://localhost:4318",
    tracesEndpoint: "http://localhost:4318/v1/traces",
    metricsEndpoint: "http://localhost:4318/v1/metrics",
    logsEndpoint: "http://localhost:4318/v1/logs",
    protocol: "http/protobuf",
    headers: {},
    serviceName: "pi-test",
    resourceAttributes: {},
    captureContent: "full",
    sampleRatio: 1,
    metricExportInterval: 10000,
    traces: { enabled: true },
    metrics: { enabled: true },
    logs: { enabled: true },
    sampler: "parentbased_traceidratio",
    semconv: "1.43",
    tracesExportTimeoutMs: 10000,
    metricsExportTimeoutMs: 10000,
    logsExportTimeoutMs: 10000,
    tracesMaxQueueSize: 2048,
    tracesMaxExportBatchSize: 512,
    tracesBatchExportTimeoutMs: 30000,
    logsMaxQueueSize: 2048,
    logsMaxExportBatchSize: 512,
    logsBatchExportTimeoutMs: 30000,
    diagLogLevel: 0,
    selfLogs: true,
    shutdownTimeoutMs: 2000,
    tracesExporters: ["otlp"],
    metricsExporters: ["otlp"],
    logsExporters: ["otlp"],
    tracesExportInterval: 5000,
    logsExportInterval: 5000,
    cwd: "/test",
    ...overrides,
  };
}

export function makeHarness(
  opts: {
    captureContent?: "metadata_only" | "no_tool_content" | "full";
    semconv?: "1.36" | "1.37" | "1.43";
    contextUsage?: () => { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
    runAttributes?: Attributes;
    sessionName?: () => string | undefined;
  } = {},
): Harness {
  const captureContent = opts.captureContent ?? "full";

  const spanExporter = new InMemorySpanExporter();
  const resource = resourceFromAttributes({ [ATTR_SERVICE_NAME]: "pi-test" });
  const provider = new BasicTracerProvider({
    resource,
    spanProcessors: [new BatchSpanProcessor(spanExporter)],
  });
  const tracer = provider.getTracer("pi-otel-test", "0.0.0");
  const metrics = new RecordingMetrics();

  const tracker = new SpanTracker({
    tracer,
    captureContent,
    semconv: opts.semconv ?? "1.43",
    sessionId: () => "test-session",
    sessionFile: () => "/tmp/test.jsonl",
    cwd: "/test",
    metrics: () => recordingMetricsOf(metrics),
    contextUsage: opts.contextUsage,
    runAttributes: opts.runAttributes,
    sessionName: opts.sessionName,
  });

  return {
    tracer,
    spanExporter,
    tracker,
    metrics,
    async flush() {
      await provider.forceFlush();
    },
    spansByName() {
      const out: Record<string, ReturnType<InMemorySpanExporter["getFinishedSpans"]>[number]> = {};
      for (const s of spanExporter.getFinishedSpans()) {
        const name = typeof s.attributes[ATTR_PI_INTERACTION_ID] === "number" ? SPAN_INTERACTION : s.name;
        out[name] = s;
      }
      return out;
    },
    span(name: string) {
      const spans = spanExporter.getFinishedSpans().filter((s) =>
        name === SPAN_INTERACTION
          ? typeof s.attributes[ATTR_PI_INTERACTION_ID] === "number"
          : s.name === name,
      );
      const last = spans[spans.length - 1];
      if (!last) throw new Error(`span not found: ${name}`);
      return last;
    },
    reset() {
      spanExporter.reset();
      metrics.counters = {};
      metrics.histograms = {};
    },
  };
}

/** Build a minimal AssistantMessage-shaped object for tests. */
export function asstMsg(opts: {
  text?: string;
  toolCalls?: Array<{ id: string; name: string; arguments?: Record<string, unknown> }>;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheWrite1h?: number;
  reasoning?: number;
  totalTokens?: number;
  cost?: number;
  stopReason?: string;
  responseModel?: string;
  responseId?: string;
  errorMessage?: string;
}): MessageShapes.AssistantMessage {
  const content: MessageShapes.ContentPart[] = [];
  if (opts.text !== undefined) content.push({ type: "text", text: opts.text });
  for (const tc of opts.toolCalls ?? []) {
    content.push({ type: "toolCall", id: tc.id, name: tc.name, arguments: tc.arguments ?? {} });
  }
  return {
    role: "assistant",
    content,
    model: "test-model",
    responseModel: opts.responseModel,
    responseId: opts.responseId,
    usage: {
      input: opts.input ?? 0,
      output: opts.output ?? 0,
      cacheRead: opts.cacheRead ?? 0,
      cacheWrite: opts.cacheWrite ?? 0,
      cacheWrite1h: opts.cacheWrite1h,
      reasoning: opts.reasoning,
      totalTokens: opts.totalTokens,
      cost: { total: opts.cost },
    },
    stopReason: opts.stopReason ?? "stop",
    errorMessage: opts.errorMessage,
  };
}

export { SpanKind };

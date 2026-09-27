/**
 * W3C Trace Context (`traceparent`) propagation for Pi processes.
 *
 * Pi spawns other Pi processes: `pi-subagents` children, and any instrumented
 * program a tool starts. Pi's own children inherit `process.env`, so a run can
 * hand its trace context to whatever it spawns by publishing `TRACEPARENT`,
 * and a spawned Pi can adopt the context it inherited for its own runs.
 *
 * Two process-scoped concerns live here rather than in the tracker:
 *  - the inherited parent is read from the environment **once per process**,
 *    so a context this process published for its own children can never be
 *    mistaken for a context it inherited;
 *  - publishing and withdrawing mutate the shared environment, so withdrawal
 *    restores the previous value instead of deleting a value this process did
 *    not install.
 */

import type { SpanContext } from "@opentelemetry/api";

/** version(2)-traceid(32)-spanid(16)-flags(2), with optional trailing fields. */
const TRACEPARENT_RE = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(?:-.*)?$/i;

/**
 * Format a span context as a W3C `traceparent`. Returns undefined when the
 * context carries no ids (the no-op tracer used when traces are disabled).
 */
export function formatTraceparent(ctx: SpanContext): string | undefined {
  if (!ctx.traceId || !ctx.spanId) return undefined;
  const flags = (ctx.traceFlags & 0xff).toString(16).padStart(2, "0");
  return `00-${ctx.traceId}-${ctx.spanId}-${flags}`;
}

/**
 * Parse a W3C `traceparent` into a remote span context. Returns undefined for
 * an absent, malformed, or all-zero-id value: a bad header must not fabricate
 * a parent that makes unrelated traces look related.
 */
export function parseTraceparent(value: string | undefined): SpanContext | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const m = TRACEPARENT_RE.exec(trimmed);
  if (!m) return undefined;
  const version = m[1]!;
  const traceId = m[2]!.toLowerCase();
  const spanId = m[3]!.toLowerCase();
  const flags = Number.parseInt(m[4]!, 16);
  // Version ff is forbidden, and zero ids are invalid per the spec.
  if (version.toLowerCase() === "ff") return undefined;
  if (/^0+$/.test(traceId) || /^0+$/.test(spanId)) return undefined;
  return { traceId, spanId, traceFlags: flags, isRemote: true };
}

/** null = not read yet; undefined = read, nothing inherited. */
let inherited: SpanContext | undefined | null = null;

/**
 * The trace context this process inherited from its spawner, read once per
 * process. Nothing is inherited when the value is absent or unusable.
 */
export function inheritedTraceparent(
  env: NodeJS.ProcessEnv = process.env,
): SpanContext | undefined {
  if (inherited === null) inherited = parseTraceparent(env.TRACEPARENT);
  return inherited;
}

/** Test hook: forget the process-lifetime memoized value. */
export function resetInheritedTraceparent(): void {
  inherited = null;
}

/**
 * Publish a trace context for child processes. Returns an idempotent withdraw
 * function that restores the previous value; a value some other writer
 * installed after us is left alone.
 */
export function publishTraceparent(
  value: string,
  env: NodeJS.ProcessEnv = process.env,
): () => void {
  const prior = env.TRACEPARENT;
  env.TRACEPARENT = value;
  let withdrawn = false;
  return () => {
    if (withdrawn) return;
    withdrawn = true;
    if (env.TRACEPARENT !== value) return;
    if (prior === undefined) delete env.TRACEPARENT;
    else env.TRACEPARENT = prior;
  };
}

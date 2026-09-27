/**
 * Log record emission.
 *
 * The extension's own lifecycle events are emitted as OTLP log records with an
 * `event.name` attribute, following the OTel "event" semantic convention.
 * The `pi-otel:log` event bus channel lets OTHER pi extensions route their
 * structured logs through this exporter too.
 *
 * The OTel SDK's internal `diag` is never routed back through OTLP — that
 * would recurse. diag stays at NONE unless explicitly raised via OTEL_LOG_LEVEL.
 *
 * Callers pass a Logger bound to the active TelemetryRuntime. There is no
 * process-wide logger cache, so a reload cannot emit into a shut-down provider.
 */

import type { Logger } from "@opentelemetry/api-logs";
import { SeverityNumber, type LogAttributes } from "@opentelemetry/api-logs";
import type { LoggerProvider } from "@opentelemetry/sdk-logs";
import { extensionVersion } from "./version.js";

const LOGGER_NAME = "pi-otel";
const LOGGER_VERSION = extensionVersion();

/** Create a Logger bound to this provider, or null when logs are off. */
export function createLogger(provider: LoggerProvider | null | undefined): Logger | null {
  if (!provider) return null;
  return provider.getLogger(LOGGER_NAME, LOGGER_VERSION);
}

const SEVERITY_MAP: Record<string, SeverityNumber> = {
  trace: SeverityNumber.TRACE,
  debug: SeverityNumber.DEBUG,
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  warning: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
  fatal: SeverityNumber.FATAL,
};

/**
 * Emit a lifecycle log record. Best-effort: never throws.
 * `eventName` lands as the `event.name` attribute so backends can group
 * discrete events (pi.session.start, pi.tool.error, ...).
 */
export function emitLog(
  logger: Logger | null | undefined,
  eventName: string,
  severity: SeverityNumber | keyof typeof SEVERITY_MAP,
  body: string,
  attrs: LogAttributes = {},
): void {
  if (!logger) return;
  try {
    const sev = typeof severity === "string"
      ? (SEVERITY_MAP[severity] ?? SeverityNumber.INFO)
      : severity;
    logger.emit({
      severityNumber: sev,
      severityText: SeverityNumber[sev],
      body,
      attributes: { "event.name": eventName, ...attrs },
    });
  } catch {
    // best-effort
  }
}

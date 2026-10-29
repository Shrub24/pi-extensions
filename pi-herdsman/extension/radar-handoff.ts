import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { RadarMailboxPort, RadarMessageConsumer } from "pi-radar/communication";

export type CompletionMessage = Parameters<RadarMessageConsumer["capture"]>[0];
import type { ResultRecord } from "./mailbox.ts";
import { HANDOFF_REQUIRED_SECTIONS } from "./response-contracts.ts";

/** Title prefix reserved for Herdsman's failure records; worker titles may not use it. */
export const FAILURE_TITLE_PREFIX = "Failed: ";

const MAX_SUMMARY_CHARS = 600;

export interface SealedCompletion {
  readonly requestId: string;
  readonly runId: string;
  readonly status: "completed" | "failed";
  readonly title: string;
  readonly summary: string;
  /** The exact Markdown Radar stores: the worker's sealed handoff or Herdsman's failure record. */
  readonly content: string;
}

const bounded = (text: string): string =>
  [...text.replace(/\s+/gu, " ").trim()].slice(0, MAX_SUMMARY_CHARS).join("");

/**
 * Herdsman's own handoff for a worker that sealed none. It says plainly that the
 * worker failed, and it is never presented as the worker's report.
 */
function failureRecord(
  agentLabel: string,
  error: { code: string; message: string },
): { title: string; summary: string; content: string } {
  const title = `${FAILURE_TITLE_PREFIX}${agentLabel}`;
  const summary = bounded(`${error.code}: ${error.message}`);
  const sections = HANDOFF_REQUIRED_SECTIONS.map((section) => {
    const body =
      section === "Outcome"
        ? `Failed: ${error.code}: ${error.message}`
        : "No sealed handoff was produced; the worker failed before it could write one.";
    return `## ${section}\n\n${body}`;
  });
  const content = [
    "---",
    "schema: handoff/v1",
    `title: ${JSON.stringify(title)}`,
    `summary: ${JSON.stringify(summary)}`,
    "---",
    "",
    ...sections,
    "",
  ].join("\n");
  return { title, summary, content };
}

/** The sealed report for one completed or failed result. A completed result must carry its handoff. */
export function sealedCompletionFor(result: ResultRecord): SealedCompletion {
  if (result.status === "completed") {
    if (!result.handoff) throw new Error("Completed result has no sealed handoff");
    return {
      requestId: result.requestId,
      runId: result.runId,
      status: "completed",
      title: result.handoff.title,
      summary: result.handoff.summary,
      content: result.handoff.content,
    };
  }
  const failure = failureRecord(
    result.agentLabel,
    result.error ?? { code: "empty_result", message: "Agent failed" },
  );
  return {
    requestId: result.requestId,
    runId: result.runId,
    status: "failed",
    ...failure,
  };
}

/** Read a Radar-stored report back into its status and summary, or refuse it. */
export function decodeSealedReport(content: string): {
  status: "completed" | "failed";
  title: string;
  summary: string;
} {
  let frontmatter: Record<string, unknown>;
  try {
    frontmatter = parseFrontmatter<Record<string, unknown>>(content).frontmatter;
  } catch {
    throw new Error("Radar handoff has no readable frontmatter");
  }
  if (
    frontmatter.schema !== "handoff/v1" ||
    typeof frontmatter.title !== "string" ||
    typeof frontmatter.summary !== "string"
  )
    throw new Error("Radar handoff is not a handoff/v1 report");
  return {
    status: frontmatter.title.startsWith(FAILURE_TITLE_PREFIX) ? "failed" : "completed",
    title: frontmatter.title,
    summary: frontmatter.summary,
  };
}

export async function publishCompletionHandoff(
  port: Pick<RadarMailboxPort, "publish">,
  result: ResultRecord,
): Promise<void> {
  const sealed = sealedCompletionFor(result);
  const published = await port.publish({
    request_id: sealed.requestId,
    correlation_id: sealed.runId,
    summary: sealed.summary,
    content: sealed.content,
  });
  if (published.ok === false) throw new Error(`${published.code}: ${published.message}`);
  if (published.value.message.id !== sealed.requestId)
    throw new Error("Radar published a different completion ID");
}

/** Decode only the report belonging to the recorded worker; capture never acknowledges. */
export function decodeCompletionMessage(
  message: CompletionMessage,
  expected: { runId: string; subjectId: string },
): { requestId: string; status: "completed" | "failed"; summary: string; content: string } {
  if (message.body.kind !== "handoff" || message.body.correlation_id !== expected.runId ||
      message.producer.subject_id !== expected.subjectId)
    throw new Error("Radar message does not match the recorded worker launch");
  const decoded = decodeSealedReport(message.body.content);
  return { requestId: message.id, status: decoded.status, summary: decoded.summary, content: message.body.content };
}

import { appendFileSync, chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

/**
 * Append-only JSONL record of routing decisions, for debugging. One line per physical selection.
 * Holds identities and reasons only: never keys, accounts' secrets, prompts or responses.
 */
export type DecisionReason = "initial" | "direct" | "sticky" | "failover" | "recovery" | "cache-expiry" | "probe";

export interface DecisionEntry {
  at: string;
  session: string;
  logical: string;
  previous?: string;
  physical: string;
  account?: string;
  reason: DecisionReason;
  contextTokens?: number;
  floor?: number;
}

export function defaultDecisionLogPath(): string {
  return join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "pi-native-router", "decisions.jsonl");
}

/** Best-effort: a logging failure must never affect dispatch. */
export function recordDecision(path: string, entry: DecisionEntry, onError: (error: unknown) => void = () => {}): void {
  try {
    if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const fresh = !existsSync(path);
    appendFileSync(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    if (fresh) chmodSync(path, 0o600);
  } catch (error) {
    onError(error);
  }
}

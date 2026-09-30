// @ts-nocheck — vendored from pi-vcc (see README.md in this directory).
// Upstream is plain JS-targeted TypeScript without this repo's strict flags
// (`strict`, `noUncheckedIndexedAccess`) and uses extensionless relative
// imports; this line is the only local modification to the copied files, so
// they stay diffable against upstream.
import type { Message } from "@earendil-works/pi-ai";

export type CompactionReason = "manual" | "threshold" | "overflow";

export interface FileOps {
  readFiles?: string[];
  modifiedFiles?: string[];
  createdFiles?: string[];
}

export type NormalizedBlock =
  | { kind: "user"; text: string; sourceIndex?: number }
  | { kind: "assistant"; text: string; sourceIndex?: number }
  | { kind: "tool_call"; name: string; args: Record<string, unknown>; sourceIndex?: number }
  | { kind: "tool_result"; name: string; text: string; sourceIndex?: number }
  | { kind: "bash"; command: string; output: string; exitCode: number | undefined; sourceIndex?: number };

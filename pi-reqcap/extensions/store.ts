// Where pi-reqcap puts what it records.

import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { Fingerprint } from "./diff.js";

export const DIR = process.env.PI_REQCAP_DIR ?? `${process.env.HOME}/.local/share/pi-reqcap/out`;

let session = (process.env.PI_SESSION_FILE ?? "unknown-session").split("/").pop() ?? "unknown-session";

/** The session this process serves. Pi does not export the session file, so index.ts
 *  sets this from the event context on the first event; the env var is only a fallback. */
export function sessionId(): string {
  return session;
}

export function setSession(id: string | undefined): boolean {
  if (!id || id === session) return false;
  session = id;
  return true;
}

// Bodies are full prompts on disk. On by default because a divergence without the
// payload is hard to act on, but they are written only for a request that paid, and
// PI_REQCAP_BODIES=0 turns them off entirely.
export const CAPTURE_BODIES = process.env.PI_REQCAP_BODIES !== "0";
const MAX_BODIES = Number(process.env.PI_REQCAP_MAX_BODIES ?? 200);
const MAX_LOG_BYTES = Number(process.env.PI_REQCAP_MAX_LOG_BYTES ?? 16 * 1024 * 1024);

export function ensureDir(): void {
  try {
    mkdirSync(`${DIR}/bodies`, { recursive: true });
    mkdirSync(`${DIR}/state`, { recursive: true });
  } catch {
    /* ignore */
  }
}

/** Caches are per model, and a process is not a session lifetime: resume must continue the chain. */
export function keyFor(model: string | undefined): string {
  return createHash("sha1").update(`${session}|${model ?? "?"}`).digest("hex").slice(0, 12);
}

export function loadState(key: string, chain: Map<string, Fingerprint>, predecessorBody: Map<string, unknown>): void {
  if (chain.has(key)) return;
  try {
    const raw = JSON.parse(readFileSync(`${DIR}/state/${key}.json`, "utf8"));
    if (raw?.fp) chain.set(key, raw.fp);
    if (raw?.body) predecessorBody.set(key, raw.body);
  } catch {
    /* first request of this session and model */
  }
}

export function saveState(key: string, fp: Fingerprint, body: unknown): void {
  try {
    writeFileSync(`${DIR}/state/${key}.json`, JSON.stringify({ fp, body }));
  } catch {
    /* ignore */
  }
}

function rotateLog(): void {
  try {
    if (statSync(`${DIR}/requests.jsonl`).size < MAX_LOG_BYTES) return;
    rmSync(`${DIR}/requests.jsonl.1`, { force: true });
    writeFileSync(`${DIR}/requests.jsonl.1`, readFileSync(`${DIR}/requests.jsonl`));
    writeFileSync(`${DIR}/requests.jsonl`, "");
  } catch {
    /* ignore */
  }
}

export function record(line: unknown): void {
  try {
    rotateLog();
    appendFileSync(`${DIR}/requests.jsonl`, `${JSON.stringify(line)}\n`);
  } catch {
    /* ignore */
  }
}

/** Human-readable log. Only cost-bearing divergences, causes and start/stop lines. */
export function log(lines: string[]): void {
  try {
    appendFileSync(`${DIR}/rewrites.log`, `${lines.filter(Boolean).join("\n")}\n`);
  } catch {
    /* ignore */
  }
}

function rotateBodies(): void {
  try {
    const files = readdirSync(`${DIR}/bodies`).filter((f) => f.endsWith(".json")).sort();
    for (const f of files.slice(0, Math.max(0, files.length - MAX_BODIES))) rmSync(`${DIR}/bodies/${f}`, { force: true });
  } catch {
    /* ignore */
  }
}

export function writeBody(name: string, body: unknown): void {
  if (!CAPTURE_BODIES || body === undefined) return;
  try {
    writeFileSync(`${DIR}/bodies/${name}.json`, JSON.stringify(body, null, 1));
    rotateBodies();
  } catch {
    /* ignore */
  }
}

/** Tail of requests.jsonl, oldest first, so a long session's log stays cheap to read. */
export function readRecords(maxLines: number = 4000): any[] {
  const limit = Number.isFinite(maxLines) && maxLines > 0 ? maxLines : 4000;
  try {
    const lines = readFileSync(`${DIR}/requests.jsonl`, "utf8").split("\n").filter(Boolean);
    const out: any[] = [];
    for (const line of lines.slice(Math.max(0, lines.length - limit))) {
      try {
        out.push(JSON.parse(line));
      } catch {
        /* a torn last line */
      }
    }
    return out;
  } catch {
    return [];
  }
}

export function writeTrace(name: string, lines: string[]): string {
  try {
    mkdirSync(`${DIR}/traces`, { recursive: true });
    const path = `${DIR}/traces/${name}.txt`;
    writeFileSync(path, `${lines.join("\n")}\n`);
    return path;
  } catch {
    return "";
  }
}


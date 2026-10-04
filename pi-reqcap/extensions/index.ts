// pi-reqcap — record and diff every provider payload Pi sends, and say what paid.
//
// Answers the question a cache re-bill raises: what changed in the prompt between
// request N and N+1, and which part of it did the provider re-bill? Classification
// lives in ./diff.ts; this file only wires Pi's events to it.
//
// Output, in $PI_REQCAP_DIR (default ~/.local/share/pi-reqcap/out):
//   requests.jsonl  one line per request, response and cause, joined by seq
//   rewrites.log    the cost-bearing divergences and causes, human readable
//   bodies/*.json   the wire body of a request that paid, and the one it diverged from
//   state/*.json    the last fingerprint and body per session and model, so a resume
//                   continues the chain instead of restarting it
//
// No extra model calls and no extra tokens. Every handler is wrapped: a diagnostics
// failure must never break a request.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { diff, fingerprint, usageFlags, type Divergence, type Fingerprint } from "./diff.js";
import {
  CAPTURE_BODIES,
  DIR,
  SESSION,
  ensureDir,
  keyFor,
  loadState,
  log,
  record,
  saveState,
  writeBody,
} from "./store.js";

const CAUSE_EVENTS = ["session_compact", "mcp_servers_change", "model_select", "thinking_level_select", "cache_warming_decision"] as const;

type Inflight = {
  seq: number;
  key: string;
  fp: Fingerprint;
  divergence: Divergence;
  body: unknown;
  status?: number;
  headers?: Record<string, string>;
  usage?: Record<string, any>;
  transformations?: unknown;
  api?: string;
  provider?: string;
};

export default function piReqcap(pi: ExtensionAPI): void {
  ensureDir();
  log([
    `[${new Date().toISOString()}] pi-reqcap start session=${SESSION} pid=${process.pid} dir=${DIR} bodies=${CAPTURE_BODIES ? "on" : "off"}`,
  ]);

  const chain = new Map<string, Fingerprint>();
  const lastBody = new Map<string, unknown>();
  const predecessorBody = new Map<string, unknown>();
  const lastPromptTokens = new Map<string, number>();
  let seq = 0;
  let inflight: Inflight | null = null;

  /** Write the response side of a request and, when it paid, its payload. */
  const flush = (): void => {
    const req = inflight;
    inflight = null;
    if (!req) return;
    const prevPrompt = lastPromptTokens.get(req.key) ?? 0;
    const u = usageFlags(req.usage, prevPrompt);
    lastPromptTokens.set(req.key, u.promptTokens);
    record({
      kind: "response",
      session: SESSION,
      pid: process.pid,
      seq: req.seq,
      at: new Date().toISOString(),
      api: req.api ?? null,
      provider: req.provider ?? null,
      usageSource: u.seen ? "stream_event" : "none",
      status: req.status ?? null,
      headers: req.headers ?? {},
      usage: { input: u.input, read: u.read, write: u.write, write1h: u.write1h, output: u.output, promptTokens: u.promptTokens },
      inputTransformations: req.transformations ?? null,
      cold: u.cold,
      reBilled: u.reBilled,
      divergence: req.divergence,
    });
    // The first request of a session and model is cold by definition: there is
    // nothing to have re-billed, so it is not news.
    const d = req.divergence;
    if (d.kind === "first") return;
    if (!u.cold && !u.reBilled) return;
    const stamp = `${new Date().toISOString().replace(/[:.]/g, "-")}-${String(req.seq).padStart(4, "0")}-${req.key}`;
    writeBody(`${stamp}-${d.kind}`, req.body);
    writeBody(`${stamp}-PREVIOUS`, predecessorBody.get(req.key));
    log([
      `[${new Date().toISOString()}] session=${SESSION} pid=${process.pid} seq=${req.seq} model=${req.fp.model} ${u.cold ? "COLD read=0" : "RE-BILL"} read=${u.read} write=${u.write} (1h=${u.write1h}) input=${u.input} prompt=${u.promptTokens} prevPrompt=${prevPrompt}`,
      `    divergence vs previous request: ${d.kind}${d.at ? ` ${d.at}` : ""}${d.detail ? ` — ${d.detail}` : ""}`,
      d.kind === "append" ? "    (append only: the prompt changed without an edit — a section or a send-time transform)" : "",
      d.was ? `    was: ${d.was}` : "",
      d.now ? `    now: ${d.now}` : "",
    ]);
  };

  pi.on("before_provider_request", (event: any) => {
    try {
      flush();
      const payload = event?.payload;
      const body = payload as any;
      const chat = Array.isArray(body?.messages) && Array.isArray(body?.tools) && body.tools.length > 0;
      seq += 1;
      const fp = fingerprint(body, { pid: process.pid, session: SESSION, at: new Date().toISOString() });
      const key = keyFor(fp.model);
      if (!chat) {
        record({ kind: "request", session: SESSION, pid: process.pid, seq, at: fp.at, model: fp.model ?? null, utility: true, divergence: { kind: "utility" } });
        return;
      }
      loadState(key, chain, predecessorBody);
      const divergence = diff(chain.get(key) ?? null, fp);
      inflight = { seq, key, fp, divergence, body };
      record({
        kind: "request",
        session: SESSION,
        pid: process.pid,
        seq,
        at: fp.at,
        model: fp.model ?? null,
        utility: false,
        bodyChars: fp.bodyChars,
        bodyHash: fp.bodyHash,
        tools: fp.tools,
        params: fp.params,
        breakpoints: fp.breakpoints,
        system: fp.system,
        messages: fp.messages.map((m) => ({ i: m.i, role: m.role, hash: m.hash, chars: m.chars })),
        divergence,
      });
      const previous = lastBody.get(key);
      if (previous !== undefined) predecessorBody.set(key, previous);
      lastBody.set(key, body);
      chain.set(key, fp);
      saveState(key, fp, body);
    } catch {
      /* diagnostics must never break a request */
    }
  });

  pi.on("before_provider_headers", (event: any) => {
    try {
      if (!inflight) return;
      const headers = event?.headers;
      if (!headers || typeof headers !== "object") return;
      const kept: Record<string, string> = {};
      for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
        if (/x-anthropic-billing-header|^x-request-id$/i.test(k)) kept[k] = String(v);
      }
      if (Object.keys(kept).length) inflight.headers = { ...(inflight.headers ?? {}), ...kept };
    } catch {
      /* ignore */
    }
  });

  pi.on("after_provider_response", (event: any) => {
    try {
      if (!inflight) return;
      inflight.status = Number(event?.status ?? 0) || undefined;
      const headers = event?.headers;
      if (headers && typeof headers === "object") {
        const kept: Record<string, string> = {};
        for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
          if (/^anthropic-ratelimit|^request-id$/i.test(k)) kept[k] = String(v);
        }
        if (Object.keys(kept).length) inflight.headers = { ...(inflight.headers ?? {}), ...kept };
      }
    } catch {
      /* ignore */
    }
  });

  pi.on("provider_stream_event", (event: any) => {
    try {
      if (!inflight) return;
      inflight.provider = typeof event?.provider === "string" ? event.provider : inflight.provider;
      inflight.api = typeof event?.api === "string" ? event.api : inflight.api;
      const data = event?.data as any;
      const usage = data?.usage ?? data?.message?.usage ?? data?.response?.usage;
      if (usage && typeof usage === "object") inflight.usage = { ...(inflight.usage ?? {}), ...usage };
      const transformations = data?.input_transformations ?? data?.delta?.input_transformations;
      if (transformations !== undefined) inflight.transformations = transformations;
    } catch {
      /* ignore */
    }
  });

  // A cause is what a divergence is attributed to. Pi raises these when the session
  // itself changed the prompt's inputs, so recording them removes the archaeology.
  for (const name of CAUSE_EVENTS) {
    pi.on(name as any, (event: any) => {
      try {
        const detail = event?.reason ?? event?.name ?? event?.model ?? event?.level ?? event?.value ?? null;
        record({ kind: "cause", event: name, session: SESSION, pid: process.pid, seq, at: new Date().toISOString(), detail });
        log([`[${new Date().toISOString()}] cause session=${SESSION} event=${name}${detail ? ` detail=${JSON.stringify(detail)}` : ""}`]);
      } catch {
        /* ignore */
      }
    });
  }

  for (const name of ["agent_settled", "agent_end", "session_shutdown"] as const) {
    pi.on(name as any, () => {
      try {
        flush();
      } catch {
        /* ignore */
      }
    });
  }
}

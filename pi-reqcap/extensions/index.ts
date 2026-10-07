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
//   traces/*.txt    the prefix comparison for every re-bill worth warning about
//
// A re-bill worth warning about raises a toast and updates the footer status; the
// report surface is `/reqcap` (overview), `/reqcap trace [n]` (one line per request),
// `/reqcap diff [seq]` (full prefix comparison) and `/reqcap where` (paths, knobs).
//
// No extra model calls and no extra tokens. Every handler is wrapped: a diagnostics
// failure must never break a request.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { diff, fingerprint, prefixTrace, usageFlags, type Divergence, type Fingerprint } from "./diff.js";
import { bustLine, diffReport, overview, short, traceLines } from "./report.js";
import {
  CAPTURE_BODIES,
  DIR,
  ensureDir,
  keyFor,
  loadState,
  log,
  readRecords,
  record,
  saveState,
  sessionId,
  setSession,
  writeBody,
  writeTrace,
} from "./store.js";

const CAUSE_EVENTS = ["session_compact", "mcp_servers_change", "model_select", "thinking_level_select", "cache_warming_decision"] as const;
// A re-bill below this is not worth interrupting a session for. Zero warns on every one.
const NOTICE_MIN_TOKENS = Number(process.env.PI_REQCAP_NOTICE_MIN_TOKENS ?? 20_000);
const STATUS_KEY = "reqcap";
const MAX_SCAN_LINES = 4000;

type Inflight = {
  seq: number;
  key: string;
  fp: Fingerprint;
  divergence: Divergence;
  prevFp: Fingerprint | null;
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
    `[${new Date().toISOString()}] pi-reqcap start session=${sessionId()} pid=${process.pid} dir=${DIR} bodies=${CAPTURE_BODIES ? "on" : "off"}`,
  ]);

  const chain = new Map<string, Fingerprint>();
  const lastBody = new Map<string, unknown>();
  const predecessorBody = new Map<string, unknown>();
  const lastPromptTokens = new Map<string, number>();
  const lastReadTokens = new Map<string, number>();
  let seq = 0;
  let inflight: Inflight | null = null;
  // The last event context is enough for a toast and the footer: both are
  // fire-and-forget, and a session without UI simply ignores them.
  let lastCtx: any = null;
  const totals = { busts: 0, tokens: 0 };

  // The session id comes from Pi's own context: the env var is not set for the
  // process itself, so records would otherwise all read "unknown-session".
  const remember = (ctx: any): void => {
    lastCtx = ctx ?? lastCtx;
    if (setSession(ctx?.sessionManager?.getSessionId?.())) {
      log([`[${new Date().toISOString()}] pi-reqcap session resolved id=${sessionId()}`]);
    }
  };

  const setStatus = (): void => {
    try {
      const text = totals.busts ? `reqcap: ${totals.busts} busts · ${short(totals.tokens)} tok` : "reqcap: watching";
      lastCtx?.ui?.setStatus(STATUS_KEY, text);
    } catch {
      /* ignore */
    }
  };

  /** Write the response side of a request and, when it paid, its payload. */
  const flush = (): void => {
    const req = inflight;
    inflight = null;
    if (!req) return;
    const prevPrompt = lastPromptTokens.get(req.key) ?? 0;
    const prevRead = lastReadTokens.get(req.key) ?? 0;
    const u = usageFlags(req.usage, prevPrompt, prevRead);
    lastPromptTokens.set(req.key, u.promptTokens);
    lastReadTokens.set(req.key, u.read);
    record({
      kind: "response",
      session: sessionId(),
      pid: process.pid,
      key: req.key,
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
      `[${new Date().toISOString()}] session=${sessionId()} pid=${process.pid} seq=${req.seq} model=${req.fp.model} ${u.cold ? "COLD read=0" : "RE-BILL"} read=${u.read} write=${u.write} (1h=${u.write1h}) input=${u.input} prompt=${u.promptTokens} prevPrompt=${prevPrompt}`,
      `    divergence vs previous request: ${d.kind}${d.at ? ` ${d.at}` : ""}${d.detail ? ` — ${d.detail}` : ""}`,
      d.kind === "append" ? "    (append only: the prompt changed without an edit — a section or a send-time transform)" : "",
      d.was ? `    was: ${d.was}` : "",
      d.now ? `    now: ${d.now}` : "",
    ]);

    const lost = Math.max(0, u.promptTokens - u.read);
    totals.busts += 1;
    totals.tokens += lost;
    setStatus();
    if (lost < NOTICE_MIN_TOKENS) return;
    const lines = prefixTrace(req.prevFp, req.fp);
    const path = writeTrace(`bust-${stamp}`, [
      ...lines,
      "",
      bustLine(
        {
          kind: "response",
          seq: req.seq,
          at: new Date().toISOString(),
          usage: { input: u.input, read: u.read, write: u.write, write1h: u.write1h, output: u.output, promptTokens: u.promptTokens },
          cold: u.cold,
          reBilled: u.reBilled,
          divergence: d,
        },
        undefined,
      ),
    ]);
    try {
      const what = `${d.kind}${d.at ? ` ${d.at}` : ""}${d.detail ? ` — ${d.detail}` : ""}`;
      lastCtx?.ui?.notify(`reqcap: ${u.cold ? "cold cache" : "cache re-bill"} ${short(lost)} tok · ${what}  (/reqcap diff ${req.seq})`, "warning");
    } catch {
      /* ignore */
    }
    log([path ? `    prefix trace: ${path}` : ""]);
  };

  pi.on("before_provider_request", (event: any, ctx: any) => {
    try {
      remember(ctx);
      flush();
      const payload = event?.payload;
      const body = payload as any;
      const chat = Array.isArray(body?.messages) && Array.isArray(body?.tools) && body.tools.length > 0;
      seq += 1;
      const fp = fingerprint(body, { pid: process.pid, session: sessionId(), at: new Date().toISOString() });
      const key = keyFor(fp.model);
      if (!chat) {
        record({ kind: "request", session: sessionId(), pid: process.pid, seq, at: fp.at, model: fp.model ?? null, utility: true, divergence: { kind: "utility" } });
        return;
      }
      loadState(key, chain, predecessorBody);
      const prevFp = chain.get(key) ?? null;
      const divergence = diff(prevFp, fp);
      inflight = { seq, key, fp, divergence, prevFp, body };
      record({
        kind: "request",
        session: sessionId(),
        pid: process.pid,
        key,
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

  pi.on("before_provider_headers", (event: any, ctx: any) => {
    try {
      remember(ctx);
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

  pi.on("after_provider_response", (event: any, ctx: any) => {
    try {
      remember(ctx);
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

  pi.on("provider_stream_event", (event: any, ctx: any) => {
    try {
      remember(ctx);
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
    pi.on(name as any, (event: any, ctx: any) => {
      try {
        remember(ctx);
        const detail = event?.reason ?? event?.name ?? event?.model ?? event?.level ?? event?.value ?? null;
        record({ kind: "cause", event: name, session: sessionId(), pid: process.pid, seq, at: new Date().toISOString(), detail });
        log([`[${new Date().toISOString()}] cause session=${sessionId()} event=${name}${detail ? ` detail=${JSON.stringify(detail)}` : ""}`]);
      } catch {
        /* ignore */
      }
    });
  }

  for (const name of ["agent_settled", "agent_end", "session_shutdown"] as const) {
    pi.on(name as any, (_event: any, ctx: any) => {
      try {
        remember(ctx);
        flush();
        setStatus();
      } catch {
        /* ignore */
      }
    });
  }

  const recordsFor = (all: boolean): any[] => {
    const records = readRecords(MAX_SCAN_LINES);
    return all ? records : records.filter((r) => r.session === sessionId());
  };

  const emit = (ctx: any, lines: string[], type: "info" | "warning" = "info"): void => {
    try {
      ctx?.ui?.notify(lines.filter(Boolean).join("\n"), type);
    } catch {
      /* ignore */
    }
  };

  pi.registerCommand("reqcap", {
    description: "Cache diagnostics: overview, trace, diff, where",
    handler: async (args: string, ctx: any) => {
      const [sub, rest] = String(args ?? "").trim().split(/\s+/);
      try {
        if (sub === "trace") {
          const n = Math.min(200, Math.max(1, Number(rest) || 20));
          emit(ctx, [`reqcap trace — last ${n} requests (${sessionId()})`, ...traceLines(recordsFor(false), n)]);
          return;
        }
        if (sub === "diff") {
          const seq = Number(rest) || undefined;
          const lines = diffReport(recordsFor(false), seq);
          const path = writeTrace(`diff-${seq ?? "last"}-${Date.now()}`, lines);
          const head = lines.slice(0, 18);
          emit(ctx, [...head, lines.length > head.length ? `… ${lines.length - head.length} more lines` : "", path ? `full trace: ${path}` : ""]);
          return;
        }
        if (sub === "where") {
          emit(ctx, [
            `dir       ${DIR}`,
            `records   ${DIR}/requests.jsonl`,
            `log       ${DIR}/rewrites.log`,
            `bodies    ${DIR}/bodies (${CAPTURE_BODIES ? "on" : "off"})`,
            `traces    ${DIR}/traces`,
            "knobs     PI_REQCAP_DIR, PI_REQCAP_BODIES=0, PI_REQCAP_MAX_BODIES, PI_REQCAP_MAX_LOG_BYTES, PI_REQCAP_NOTICE_MIN_TOKENS",
          ]);
          return;
        }
        if (sub === "help") {
          emit(ctx, [
            "/reqcap               session overview: totals, busts, causes, breakpoints",
            "/reqcap all           the same over every session in records.jsonl",
            "/reqcap trace [n]     one line per request: prompt movement and what it cost",
            "/reqcap diff [seq]    full prefix comparison, request vs its predecessor",
            "/reqcap where         output paths and environment knobs",
            `busts warn above ${NOTICE_MIN_TOKENS.toLocaleString("en-US")} re-billed tokens (PI_REQCAP_NOTICE_MIN_TOKENS) — ${totals.busts} this process, ${short(totals.tokens)} tok`,
          ]);
          return;
        }
        const all = sub === "all";
        emit(ctx, overview(recordsFor(all), { scope: all ? `all sessions in ${DIR}` : `session ${sessionId()}` }));
      } catch (error) {
        emit(ctx, [`reqcap: ${error instanceof Error ? error.message : String(error)}`], "warning");
      }
    },
  });
}

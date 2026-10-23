import { randomUUID } from "node:crypto";
import { estimateTokens, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Candidate, Config, RouteConfig } from "./config";
import type { CauseRecord, HealthStore, ResumeRecord } from "./health-store";
import { admissionKeys, classify, fitsRequest, identity, partialOutput, type Health, type Resolved } from "./policy";
import { QUOTA_FRESH_MS, quotaScopeKey } from "./quota";
import { projectQuotaObservation } from "./strategy-projection";
import { completeArguments } from "./completions";

export const RESUME_MESSAGE = "native-router-resume";
export const RESUME_POINTER = "@vanillagreen/pi-native-router/resumption";
export const RESUME_STATUS = "native-router-resume";
const ACTIVE = new Set(["armed", "waiting", "waking", "running"]);
const CHECK_MS = 5 * 60_000;
export type Scope = { kind: "route" } | { kind: "provider"; provider: string; account?: string } | { kind: "target"; target: string };
export const inScope = (scope: Scope, c: Candidate): boolean => scope.kind === "route" || (scope.kind === "target" ? identity(c, c.account) === scope.target : c.provider === scope.provider && (scope.account === undefined || c.account === scope.account));
export const scopeText = (scope: Scope): string => scope.kind === "route" ? "route" : scope.kind === "target" ? `target:${scope.target}` : `provider:${scope.provider}${scope.account === undefined ? "" : `#${scope.account}`}`;

export function parseResume(args: string, route: RouteConfig, pin: string | null | undefined, now: number) {
  const [mode, ...rest] = args.trim().split(/\s+/);
  if (!["once", "on", "off", "status"].includes(mode)) throw new Error("usage: /route-resume once|on|off|status [--scope route|pin|provider:<id>[#account]|target:<provider>/<model>[#account]] [--until ISO]");
  let selector = "route", deadline = now + 86_400_000;
  const seen = new Set<string>();
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i], value = rest[i + 1];
    if ((mode !== "once" && mode !== "on") || !["--scope", "--until"].includes(flag) || !value || seen.has(flag)) throw new Error("Invalid or duplicate resumption arguments");
    seen.add(flag);
    if (flag === "--scope") selector = value;
    else {
      if (!/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value)) throw new Error("--until requires an ISO timestamp with timezone");
      deadline = Date.parse(value);
      if (!Number.isFinite(deadline) || deadline <= now) throw new Error("--until must be in the future");
    }
  }
  let scope: Scope;
  if (selector === "route") scope = { kind: "route" };
  else if (selector === "pin") {
    if (!pin) throw new Error("No physical pin to snapshot");
    scope = { kind: "target", target: pin };
  } else if (/^provider:[^/#\s]+(?:#[^/#\s]+)?$/.test(selector)) {
    const [provider, account] = selector.slice(9).split("#");
    scope = { kind: "provider", provider, ...(account === undefined ? {} : { account }) };
  } else if (/^target:[^/#\s]+\/[^#\s]+(?:#[^/#\s]+)?$/.test(selector)) scope = { kind: "target", target: selector.slice(7) };
  else throw new Error("Invalid resumption scope");
  if (!route.candidates.some(c => inScope(scope, c))) throw new Error("Resumption scope is outside the selected route");
  return { mode: mode as "once" | "on" | "off" | "status", scope, deadline };
}

interface Intent {
  row: ResumeRecord; role: string; scope: Scope; mode: "once" | "on";
  phase: string; head: string | null; task?: string; attempts: number; failedAt: number;
  blockers: string[]; next?: number; outcome: string; estimate: number;
  // A tracker block needs an affirmative later reading even after manual clearing.
  trackerRequired: Set<string>; resumed: boolean; progressed: boolean;
  failureLimits: Map<string, CauseRecord>;
}
export type Schedule = (run: () => void, delay: number) => () => void;
export const nativeSchedule: Schedule = (run, delay) => { const timer = setTimeout(run, delay); timer.unref?.(); return () => clearTimeout(timer); };
interface Dependencies {
  config: Config; store?: HealthStore; health: Health; now: () => number; schedule?: Schedule;
  candidates: (route: RouteConfig, ctx: ExtensionContext) => Resolved[];
  pin: (ctx: ExtensionContext, role: string) => string | null | undefined;
  refresh: () => Promise<unknown>;
}

/** Session-local authorization. The shared store owns claims; it never owns an execution loop. */
export function installResumption(pi: ExtensionAPI, deps: Dependencies) {
  const owner = randomUUID();
  let intent: Intent | undefined, context: ExtensionContext | undefined;
  let cancelTimer: (() => void) | undefined, unlisten: (() => void) | undefined;
  let checking: Intent | undefined;
  let run: { generation: string; denied: boolean; fresh: boolean } | undefined;
  let terminal: { safe: boolean; capacity: boolean; estimate: number } | undefined;
  const now = deps.now, schedule = deps.schedule ?? nativeSchedule;
  const cleanup = () => { cancelTimer?.(); cancelTimer = undefined; };
  const status = () => !intent ? "off" : `${intent.phase} ${intent.mode} ${scopeText(intent.scope)}; blockers: ${intent.blockers.join(", ") || "none"}; next: ${intent.next === undefined ? "none" : new Date(intent.next).toISOString()}; until: ${new Date(intent.row.deadline).toISOString()}; wakes: ${intent.attempts}/3; ${intent.outcome}`;
  const display = () => { if (context?.hasUI) context.ui.setStatus(RESUME_STATUS, intent && ACTIVE.has(intent.phase) ? `resume ${intent.phase}` : undefined); };
  const notify = () => { display(); if (context?.hasUI) context.ui.notify(`native-router resume: ${status()}`, "info"); };
  function suspend() {
    cleanup();
    if (!intent || intent.phase === "suspended") return;
    if (intent) { intent.phase = "suspended"; intent.outcome = "intent store unavailable or ownership lost; explicitly re-arm"; }
    notify();
  }
  function persist(phase: string, outcome: string): boolean {
    if (!intent) return false;
    const previous = intent.phase;
    intent.phase = phase; intent.outcome = outcome;
    const row = { ...intent.row, status: phase, updated: now(), body: JSON.stringify({ role: intent.role, mode: intent.mode, scope: intent.scope, outcome }) };
    try {
      if (!deps.store?.updateResume(row, previous)) { suspend(); return false; }
      intent.row = row; display(); return true;
    } catch { suspend(); return false; }
  }
  function stop(reason: string) {
    cleanup();
    if (intent) intent.next = undefined;
    if (intent && ACTIVE.has(intent.phase)) { persist("stopped", reason); notify(); }
  }
  function owned(i: Intent): boolean {
    const row = deps.store?.getResume(i.row.id);
    return row?.generation === i.row.generation && row.owner === owner && row.status === i.phase && ACTIVE.has(row.status) && (row.status !== "waking" || deps.store!.resumeClaimValid(row));
  }
  const sameSelection = (i: Intent, ctx: ExtensionContext) => ctx.sessionManager.getSessionId() === i.row.session && ctx.model?.provider === "route" && ctx.model.id === i.role;
  // Pin/thinking/status entries can change while waiting. Fence the conversation head, not those preferences.
  const headOf = (ctx: ExtensionContext) => ctx.sessionManager.getBranch().findLast(e => e.type !== "custom")?.id ?? null;
  function valid(i: Intent, ctx: ExtensionContext, head = false): boolean {
    return intent === i && ACTIVE.has(i.phase) && sameSelection(i, ctx) && (!head || headOf(ctx) === i.head) && owned(i);
  }
  function scoped(route: RouteConfig, ctx: ExtensionContext): Resolved[] {
    const i = intent;
    if (!i || !i.resumed || !ACTIVE.has(i.phase)) return deps.candidates(route, ctx);
    const ready = readiness(i, ctx).targets;
    return deps.candidates(route, ctx).filter(c => inScope(i.scope, c.candidate) && ready.has(identity(c.model, c.candidate.account)));
  }
  function readiness(i: Intent, ctx: ExtensionContext) {
    const store = deps.store!;
    const candidates = deps.candidates(deps.config.routes[i.role], ctx).filter(c => inScope(i.scope, c.candidate) && fitsRequest(deps.config.routes[i.role], c, i.estimate));
    let ready = false, allCapacity = candidates.length > 0;
    const targets = new Set<string>();
    const blockers: string[] = [], resets: number[] = [];
    for (const c of candidates) {
      const keys = admissionKeys(c.model, c.candidate.account);
      const meter = quotaScopeKey(c.candidate.provider, c.candidate.account);
      const provider = deps.config.providers[c.candidate.provider];
      const configured = c.candidate.account === undefined ? provider?.quota !== undefined : provider?.accounts[c.candidate.account]?.quota !== undefined;
      const row = store.getSnapshot(meter);
      const q = projectQuotaObservation(row, configured, now(), QUOTA_FRESH_MS);
      const causes = store.inspect().causes.filter(cause => keys.includes(cause.key));
      for (const cause of causes) if (cause.kind === "quota" || cause.kind === "rate") {
        const key = `${cause.key}:${cause.kind}`, saved = i.failureLimits.get(key);
        if (!saved || cause.revision >= saved.revision) i.failureLimits.set(key, cause);
      }
      if (causes.some(cause => cause.kind === "tracker-quota")) i.trackerRequired.add(meter);
      const exhausted = q.windows.filter(w => w.usedPercent >= 100);
      if (q.authoritative && exhausted.length > 0) i.trackerRequired.add(meter);
      const freshHealthy = q.status === "fresh" && q.authoritative && q.windows.length > 0 && exhausted.length === 0;
      const restored = freshHealthy && q.observedAt! >= i.failedAt;
      if (restored) {
        const revision = (row?.body as { healthRevision?: number })?.healthRevision;
        if (revision !== undefined && Number.isSafeInteger(revision)) {
          store.restoreQuota(keys, revision);
          for (const [key, cause] of i.failureLimits) if (keys.includes(cause.key) && cause.kind === "quota" && cause.revision <= revision) i.failureLimits.delete(key);
          if (!store.inspect().causes.some(cause => keys.includes(cause.key) && cause.kind === "quota")) deps.health.recoveredQuota(keys);
        }
      }
      const live = [...store.inspect().causes, ...i.failureLimits.values()].filter(cause => keys.includes(cause.key) && cause.until > now());
      const blocked = deps.health.blockedReason(c.model, c.candidate.account);
      const unknownTracker = i.trackerRequired.has(meter) && !restored;
      const quotaBlocked = q.authoritative && exhausted.length > 0;
      if (blocked || live.length || unknownTracker || quotaBlocked) {
        const capacity = !live.some(cause => !["quota", "rate", "tracker-quota"].includes(cause.kind) || (cause.kind === "rate" && cause.reason !== "reset-bound rate")) && (!blocked || ["quota", "rate", "tracker-quota"].includes(blocked.kind));
        if (!capacity) allCapacity = false;
        blockers.push(`${identity(c.model, c.candidate.account)}: ${!capacity ? "non-capacity health" : exhausted.length ? exhausted.map(w => `${w.label} ${w.usedPercent}%${w.resetsAt ? ` resets ${new Date(w.resetsAt).toISOString()}` : ""}`).join(" + ") : unknownTracker ? "quota unknown" : blocked?.kind ?? live[0]?.kind}; tracker ${q.status}/${q.source ?? "unknown"}`);
        resets.push(...live.map(cause => cause.until), ...exhausted.flatMap(w => w.resetsAt === undefined ? [] : [w.resetsAt]));
      } else { ready = true; allCapacity = false; targets.add(identity(c.model, c.candidate.account)); }
    }
    i.blockers = blockers;
    return { ready, allCapacity, targets, next: Math.min(i.row.deadline, now() + CHECK_MS, ...resets.filter(t => t > now()).map(t => Math.max(now() + 1000, t))) };
  }
  function queueCheck(at: number) {
    cleanup();
    if (!intent) return;
    intent.next = at; display();
    const generation = intent.row.generation;
    cancelTimer = schedule(() => { cancelTimer = undefined; if (intent?.row.generation === generation) void check(true); }, Math.max(1, at - now()));
  }
  async function check(refresh = false) {
    const i = intent, ctx = context;
    if (!i || !ctx || i.phase !== "waiting" || checking === i) return;
    checking = i;
    try {
      if (now() >= i.row.deadline) { stop("deadline reached"); return; }
      if (!valid(i, ctx, true)) { stop("session, selection, branch or owner changed"); return; }
      if (refresh) await deps.refresh();
      if (!valid(i, ctx, true) || i.phase !== "waiting") {
        if (intent === i && i.phase === "waiting") stop("session, selection, branch or owner changed during refresh");
        return;
      }
      const r = readiness(i, ctx);
      if (!r.ready || !ctx.isIdle() || ctx.hasPendingMessages()) { queueCheck(r.next); return; }
      if (i.attempts >= 3) { stop("three unsuccessful wakes"); return; }
      // Persisted phase is the owner/generation claim. There is no await from this point through sendMessage.
      if (!persist("waking", "capacity ready; continuation claimed")) return;
      if (!valid(i, ctx, true) || !ctx.isIdle() || ctx.hasPendingMessages() || now() >= i.row.deadline) { stop("wake cancelled before enqueue"); return; }
      cleanup(); i.next = undefined; i.attempts++; i.resumed = true; i.progressed = false;
      pi.sendMessage({ customType: RESUME_MESSAGE, content: "Capacity restored. Continue the interrupted task from its existing state; do not repeat completed tools.", display: false,
        details: { intent: i.row.id, generation: i.row.generation } }, { triggerTurn: true });
      notify();
    } catch { if (intent === i) suspend(); }
    finally { if (checking === i) checking = undefined; }
  }
  function wait(ctx: ExtensionContext, estimate: number) {
    const i = intent;
    if (!i || !ACTIVE.has(i.phase)) return;
    context = ctx; cleanup();
    if (now() >= i.row.deadline) { stop("deadline reached"); return; }
    if (i.attempts >= 3 && !i.progressed) { stop("three unsuccessful wakes"); return; }
    if (i.progressed) i.attempts = 0;
    i.failedAt = now(); i.estimate = estimate;
    i.head = headOf(ctx);
    try {
      const r = readiness(i, ctx);
      // A race after an admitted wake may lose a probe lease even with capacity available.
      if (!r.allCapacity && !(i.resumed && r.ready)) { stop("terminal failure is not scoped capacity exhaustion"); return; }
      if (!persist("waiting", "waiting for scoped capacity")) return;
      queueCheck(r.next); notify();
    } catch { suspend(); }
  }
  pi.registerCommand("route-resume", {
    description: "Opt-in quota resumption: once|on|off|status [--scope route|pin|provider:<id>[#account]|target:<provider>/<model>[#account]] [--until ISO]",
    getArgumentCompletions: prefix => completeArguments(prefix, done => {
      if (!done.length) return ["once", "on", "off", "status"].map(value => ({ value }));
      if (!["once", "on"].includes(done[0])) return [];
      if (done.at(-1) === "--scope") return [...new Set(["route", "pin", ...Object.values(deps.config.routes).flatMap(route => route.candidates.flatMap(c => [
        `provider:${c.provider}`, ...(c.account === undefined ? [] : [`provider:${c.provider}#${c.account}`]), `target:${identity(c, c.account)}`]))])].map(value => ({ value }));
      if (done.at(-1) === "--until") return [];
      return ["--scope", "--until"].filter(flag => !done.includes(flag)).map(value => ({ value }));
    }),
    handler: async (args, ctx) => {
      context = ctx;
      if (args.trim() === "status") { ctx.ui.notify(`native-router resume: ${status()}`, "info"); return; }
      if (args.trim() === "off") {
        if (intent?.phase === "suspended") {
          try { deps.store?.cancelResume(intent.row); intent.phase = "stopped"; intent.outcome = "disabled by operator"; notify(); } catch { suspend(); }
        } else stop("disabled by operator");
        display(); return;
      }
      try {
        if (ctx.model?.provider !== "route" || !deps.config.routes[ctx.model.id]) throw new Error("Select a route first");
        if (!deps.store) throw new Error("Resumption requires the shared health store");
        const role = ctx.model.id;
        const parsed = parseResume(args, deps.config.routes[role], deps.pin(ctx, role), now());
        if (parsed.mode !== "once" && parsed.mode !== "on") throw new Error("Invalid resumption arguments");
        stop("replaced by explicit authorization");
        const row: ResumeRecord = { id: randomUUID(), session: ctx.sessionManager.getSessionId(), branch: ctx.sessionManager.getLeafId() ?? "root", owner, generation: randomUUID(), status: "armed", deadline: parsed.deadline, updated: now(), body: JSON.stringify({ role, mode: parsed.mode, scope: parsed.scope }) };
        deps.store.armResume(row);
        pi.appendEntry(RESUME_POINTER, { id: row.id });
        intent = { row, role, scope: parsed.scope, mode: parsed.mode, phase: "armed", head: ctx.sessionManager.getLeafId(), attempts: 0, failedAt: now(), estimate: 0, blockers: [], outcome: "authorized; three unsuccessful wakes per pause", trackerRequired: new Set(), failureLimits: new Map(), resumed: false, progressed: false };
        if (!ctx.isIdle()) intent.task = randomUUID();
        attach(ctx); notify();
        if (!terminal) {
          const messages = ctx.sessionManager.getBranch().flatMap(e => e.type === "message" ? [e.message] : []);
          const last = messages.at(-1);
          if (last?.role === "assistant") {
            const failure = last.provider === "route" ? undefined : classify(last, now());
            const pending = new Set<string>();
            for (const message of messages) {
              if (message.role === "assistant") for (const content of message.content) if (content.type === "toolCall") pending.add(content.id);
              if (message.role === "toolResult") pending.delete(message.toolCallId);
            }
            terminal = { safe: last.stopReason === "error" && !partialOutput(last) && pending.size === 0,
              capacity: failure?.kind === "quota" || (failure?.kind === "rate" && failure.resetBound === true), estimate: ctx.getContextUsage()?.tokens ?? 0 };
            if (last.provider === "route" && terminal.safe) {
              try { terminal.capacity = readiness(intent, ctx).allCapacity; } catch { suspend(); return; }
            }
          }
        }
        if (terminal?.safe && terminal.capacity && ctx.isIdle()) wait(ctx, terminal.estimate);
        else queueDeadline();
      } catch (error) { ctx.ui.notify(`native-router resume: ${error instanceof Error ? error.message : String(error)}`, "error"); }
    },
  });
  function queueDeadline() {
    if (!intent) return;
    cleanup();
    const i = intent;
    cancelTimer = schedule(() => { if (intent === i) { if (now() >= i.row.deadline) stop("deadline reached"); else queueDeadline(); } }, Math.min(2_147_483_647, Math.max(1, i.row.deadline - now())));
  }
  function attach(ctx: ExtensionContext) {
    unlisten?.(); unlisten = undefined;
    if (ctx.hasUI && ctx.ui.onTerminalInput) unlisten = ctx.ui.onTerminalInput(data => {
      if (data === "\x1b" || data === "\x03") stop("terminal abort");
      return undefined;
    });
  }
  pi.on("before_agent_start", (event, ctx) => {
    context = ctx; run = undefined; terminal = undefined;
    if (event.messageType === "custom" && event.message.customType === RESUME_MESSAGE) {
      const details = event.message.details as { intent?: string; generation?: string } | undefined;
      // Legacy/manual messages without an intent remain ordinary custom messages (host proof seam).
      if (details?.intent) {
        const i = intent;
        let allowed = false;
        try { allowed = !!i && i.row.id === details.intent && i.row.generation === details.generation && i.phase === "waking" && sameSelection(i, ctx) && owned(i) && now() < i.row.deadline; } catch { suspend(); }
        run = { generation: details.generation ?? "", denied: !allowed, fresh: allowed };
        if (allowed && !persist("running", "resuming interrupted task")) run.denied = true;
      }
    } else if (event.messageType === "user" && intent && ACTIVE.has(intent.phase)) {
      if (intent.phase === "armed" && intent.task === undefined) intent.task = randomUUID();
      else stop("new submitted user intent");
    }
  });
  pi.on("input", event => {
    if (event.source !== "extension" && intent && ACTIVE.has(intent.phase) && (intent.phase !== "armed" || intent.task !== undefined)) stop("new submitted user intent");
  });
  pi.on("message_end", event => {
    if (event.message.role === "assistant" && event.message.stopReason !== "error" && event.message.stopReason !== "aborted" && intent?.resumed && ACTIVE.has(intent.phase)) {
      intent.progressed = true;
      if (intent.mode === "once") { // Keep the execution scope until this native run settles.
        persist("running", "once permission consumed after successful progress");
      }
    }
  });
  pi.on("agent_before_settle", (event, ctx) => {
    context = ctx;
    const last = event.context.llmMessages.at(-1);
    if (!last || last.role !== "assistant") { terminal = { safe: false, capacity: false, estimate: 0 }; return; }
    const failure = last.provider === "route" ? undefined : classify(last, now());
    const structured = terminal;
    const pendingTools = new Set<string>();
    for (const message of event.context.llmMessages) {
      if (message.role === "assistant") for (const content of message.content) if (content.type === "toolCall") pendingTools.add(content.id);
      if (message.role === "toolResult") pendingTools.delete(message.toolCallId);
    }
    terminal = { safe: event.outcome === "error" && !partialOutput(last) && pendingTools.size === 0 && (last.provider !== "route" || structured?.safe === true),
      capacity: failure?.kind === "quota" || (failure?.kind === "rate" && failure.resetBound === true) || (last.provider === "route" && structured?.capacity === true),
      estimate: ctx.getContextUsage()?.tokens ?? event.context.llmMessages.reduce((sum, m) => sum + estimateTokens(m), 0) };
  });
  pi.on("agent_settled", (event, ctx) => {
    context = ctx;
    if (!intent || !ACTIVE.has(intent.phase)) { run = undefined; return; }
    if (event.aborted) stop("run aborted");
    else if (intent.mode === "once" && intent.progressed) stop("once permission consumed");
    else if (terminal?.safe && terminal.capacity) wait(ctx, terminal.estimate);
    else stop("task settled without a safe capacity pause");
    run = undefined;
  });
  const cancel = () => { stop("session lifecycle changed"); terminal = undefined; run = undefined; unlisten?.(); unlisten = undefined; };
  pi.on("model_select", () => { stop("selected model changed"); terminal = undefined; });
  pi.on("session_before_switch", cancel);
  pi.on("session_before_fork", cancel);
  pi.on("session_before_tree", cancel);
  pi.on("session_before_compact", cancel);
  pi.on("session_shutdown", cancel);
  pi.on("session_start", (_event, ctx) => {
    cleanup(); context = ctx; intent = undefined; run = undefined; terminal = undefined; attach(ctx);
    const pointer = ctx.sessionManager.getBranch().findLast(e => e.type === "custom" && e.customType === RESUME_POINTER);
    try {
      const id = pointer?.type === "custom" ? (pointer.data as { id?: string })?.id : undefined;
      const row = id ? deps.store?.getResume(id) : undefined;
      if (row && ACTIVE.has(row.status)) {
        const body = JSON.parse(row.body);
        intent = { row, role: body.role, mode: body.mode, scope: body.scope, phase: "suspended", head: ctx.sessionManager.getLeafId(), attempts: 0, failedAt: 0, blockers: [], outcome: "restored intent; explicitly re-arm", estimate: 0, trackerRequired: new Set(), failureLimits: new Map(), resumed: false, progressed: false };
        notify();
      } else display();
    } catch { suspend(); }
  });
  return {
    recheck: () => check(),
    candidates: scoped,
    automatic: () => !!intent?.resumed && ACTIVE.has(intent.phase),
    rejection: (safe: boolean, capacity: boolean, estimate: number) => {
      if (intent?.resumed && context && ACTIVE.has(intent.phase)) {
        const r = readiness(intent, context);
        capacity ||= r.allCapacity || r.ready; // No selected target despite readiness includes a refused probe lease.
      }
      terminal = { safe, capacity, estimate };
    },
    checkTarget: (candidate: Candidate, ctx: ExtensionContext) => {
      if (!intent?.resumed || !ACTIVE.has(intent.phase)) return;
      if (!inScope(intent.scope, candidate) || !readiness(intent, ctx).targets.has(identity(candidate, candidate.account))) {
        terminal = { safe: true, capacity: true, estimate: intent.estimate };
        throw new Error("Router resumption capacity changed before dispatch");
      }
    },
    beginAttempt: () => { const fresh = run?.fresh === true; if (run) run.fresh = false; return fresh; },
    fence: (ctx: ExtensionContext) => {
      const captured = run;
      return () => {
        if (!captured) return;
        try {
          if (captured.denied || !intent || captured.generation !== intent.row.generation || !valid(intent, ctx) || !["running", "waking"].includes(intent.phase)) throw new Error("Cancelled or stale router resumption");
        } catch (error) { stop("resumption dispatch fenced"); throw error; }
      };
    },
    storeFailed: suspend,
  };
}

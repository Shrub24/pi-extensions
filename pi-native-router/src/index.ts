import {
  estimateTokens, VIRTUAL_MODEL_STATE_ENTRY,
  type ExtensionAPI, type ExtensionContext, type ModelRouteRequest, type ModelRoute,
} from "@earendil-works/pi-coding-agent";
import type { Api, Message, Model } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { readConfig, type Config, type RouteConfig } from "./config";
import { accountActive, accountSecret, readAccountKey, useAccount } from "./accounts";
import { HealthStore } from "./health-store";
import { codexbarRunner, QUOTA_FRESH_MS, refreshQuota, type QuotaSnapshot } from "./quota";
import { codexbarConfigPath, generateCodexbarConfig, writeCodexbarConfig } from "./codexbar-config";
import { defaultPricingPath, loadSnapshot, refreshSnapshot, saveSnapshot } from "./pricing/cache";
import { lookup } from "./pricing/catalog";
import { accountOf, admissionKeys, cacheExpiry, choose, classify, Health, identity, observe, partialOutput, physicalOf, restore, type Resolved, type State } from "./policy";
import { beforeTransition, flushBridge, type FlushHook, type TransitionHook } from "./transition";

function tokens(messages: readonly Message[]): number {
  const canonical = messages.reduce((n, m) => n + estimateTokens(m), 0);
  const latest = messages.findLast(m => m.role === "assistant" && m.stopReason !== "error" && m.stopReason !== "aborted");
  if (!latest || latest.role !== "assistant") return canonical;
  const u = latest.usage;
  return Math.max(canonical, u.input + u.output + u.cacheRead + u.cacheWrite);
}
function turnKey(ctx: ExtensionContext): string {
  const user = ctx.sessionManager.getBranch().findLast(e => e.type === "message" && e.message.role === "user");
  return user?.id ?? "no-user";
}
function available(route: RouteConfig, ctx: ExtensionContext, accounts: Config["accounts"]): Resolved[] {
  return route.candidates.flatMap(candidate => {
    const model = ctx.modelRegistry.find(candidate.provider, candidate.id);
    if (!model || model.api === "pi-virtual") return [];
    if (candidate.account !== undefined) {
      const account = accounts[candidate.account];
      return account && accountSecret(account) !== undefined ? [{ candidate, model }] : [];
    }
    return ctx.modelRegistry.hasConfiguredAuth(model) ? [{ candidate, model }] : [];
  });
}
// Direct calls never change the runtime key; they may only use named accounts already active.
async function activeOnly(candidates: Resolved[], ctx: ExtensionContext, accounts: Config["accounts"]): Promise<Resolved[]> {
  const kept: Resolved[] = [];
  for (const c of candidates) {
    const account = c.candidate.account === undefined ? undefined : accounts[c.candidate.account];
    if (!account || (await accountActive(ctx, account, c.candidate.provider))) kept.push(c);
  }
  return kept;
}
const CACHE_ACTIVITY_ENTRY = "@vanillagreen/pi-native-router/cache-activity";
function branchState(ctx: ExtensionContext, role: string): State | undefined {
  const branch = ctx.sessionManager.getBranch();
  const entry = branch.findLast(e => e.type === "custom" && e.customType === VIRTUAL_MODEL_STATE_ENTRY && (e.data as { provider?: string; modelId?: string })?.provider === "route" && (e.data as { modelId?: string })?.modelId === role);
  const state = entry?.type === "custom" ? restore((entry.data as { state?: unknown }).state) : undefined;
  if (!state) return undefined;
  const activity = branch.findLast(e => e.type === "custom" && e.customType === CACHE_ACTIVITY_ENTRY && (e.data as { logical?: string })?.logical === `route/${role}`);
  if (activity?.type === "custom") {
    const fact = activity.data as State["cacheActivity"];
    if (fact && fact.physical === state.physical && Number.isSafeInteger(fact.at) && fact.at >= 0 && (fact.consumedAt === undefined || (Number.isSafeInteger(fact.consumedAt) && fact.consumedAt >= fact.at))) state.cacheActivity = fact;
  }
  return state;
}
/** Default store: user state under the Pi agent directory, never inside a project. */
export function defaultHealthPath(): string {
  return join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "pi-native-router", "health.sqlite");
}
/** Admission made before a physical dispatch; settled by its own success or failure. */
interface Admission { holder: string; keys: string[]; revision: number; physical: string }
export function installRouter(pi: ExtensionAPI, config: Config, options: { transition?: TransitionHook; now?: () => number; healthPath?: string } = {}) {
  let lastDegradation: string | undefined;
  const degrade = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (message === lastDegradation) return;
    lastDegradation = message;
    pi.events.emit("native-router:health-degraded", { message });
  };
  let store: HealthStore | undefined;
  if (config.sharedHealth) {
    try { store = new HealthStore(options.healthPath ?? defaultHealthPath(), options.now ?? Date.now); }
    catch (error) { degrade(error); }
  }
  const health = new Health(options.now, store, degrade);
  const admissions = new Map<string, Admission>();
  /** Settles this session's pending admission. Success clears only the causes it proved recovered. */
  const settleAdmission = (activityKey: string, outcome: { recovered: boolean }) => {
    const pending = admissions.get(activityKey);
    if (!pending || !store) return;
    admissions.delete(activityKey);
    try {
      store.settleProbe(pending.holder, outcome.recovered);
      if (outcome.recovered) store.recordSuccess(pending.keys, pending.revision);
    } catch (error) { degrade(error); }
  };
  const hook = options.transition ?? flushBridge(pi, config.flushTimeoutMs);
  const flush = flushBridge(pi, config.flushTimeoutMs);
  const queues = new Map<string, Promise<unknown>>();
  const activities = new Map<string, State["cacheActivity"]>();
  async function serialized<T>(sessionId: string, run: () => Promise<T>): Promise<T> {
    const previous = queues.get(sessionId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(run);
    queues.set(sessionId, current);
    try { return await current; }
    finally { if (queues.get(sessionId) === current) queues.delete(sessionId); }
  }
  for (const [role, route] of Object.entries(config.routes)) {
    const resolve = async (request: ModelRouteRequest<State>, ctx: ExtensionContext): Promise<ModelRoute<State>> => {
      request.signal?.throwIfAborted();
      const candidates = available(route, ctx, config.accounts);
      const estimate = Math.max(tokens(request.messages), request.reason === "direct" ? 0 : ctx.getContextUsage()?.tokens ?? 0);
      if (request.reason === "direct") {
        const selected = choose(route, await activeOnly(candidates, ctx, config.accounts), health, estimate, route.contextWindow);
        if (!selected) throw new Error(`Native route/${role} exhausted: no compatible authenticated candidate`);
        return { model: selected.model, thinkingLevel: selected.candidate.thinkingLevel };
      }
      const old = restore(request.state);
      const persisted = branchState(ctx, role);
      const activityKey = `${ctx.sessionManager.getSessionId()}:${role}`;
      const activity = activities.get(activityKey) ?? persisted?.cacheActivity ?? old?.cacheActivity;
      if (old && activity) old.cacheActivity = activity;
      const turn = turnKey(ctx);
      const state: State = old ? { ...old } : { version: 1, physical: "", floor: route.contextWindow, turn, retries: 0, transitions: 0, recoveries: 0 };
      if (activity) state.cacheActivity = activity;
      if (state.turn !== turn) Object.assign(state, { turn, retries: 0, transitions: 0, recoveries: 0, next: undefined });
      state.floor = Math.max(state.floor, request.previous?.model.contextWindow ?? 0);
      let exclude: string | undefined;
      if (admissions.has(activityKey)) settleAdmission(activityKey, { recovered: false });
      if (request.failed) {
        const failure = classify(request.failed.message, options.now?.());
        if (failure.kind === "unsafe") {
          // Partial output is never replayed, but provider quota/auth evidence still updates shared health.
          const observed = observe(request.failed.message, options.now?.());
          if (observed.kind !== "unsafe" && observed.kind !== "transient") {
            const observedAccount = old?.physical !== undefined && physicalOf(old.physical) === identity(request.failed.model) ? accountOf(old.physical) : undefined;
            health.mark(request.failed.model, observed, observedAccount);
          }
          throw new Error(`Native route/${role} refuses unsafe retry migration`);
        }
        state.retries++;
        const stay = failure.kind === "transient" && state.retries <= route.stayRetries;
        const failedAccount = old?.physical !== undefined && physicalOf(old.physical) === identity(request.failed.model) ? accountOf(old.physical) : undefined;
        if (!stay) { health.mark(request.failed.model, failure, failedAccount); exclude = identity(request.failed.model, failedAccount); }
      }
      // Admit one recovery probe per expired scope on the chosen target, or move to the next target.
      const skipped = new Set<string>(exclude ? [exclude] : []);
      let selected: Resolved | undefined;
      for (;;) {
        selected = choose(route, candidates, health, estimate, state.floor, state.next ?? state.physical, skipped);
        if (!selected) break;
        const target = identity(selected.model, selected.candidate.account);
        if (!store) break;
        const holder = randomUUID();
        const keys = admissionKeys(selected.model, selected.candidate.account);
        let granted: boolean;
        try {
          const revision = store.revision();
          granted = store.admitProbe(keys, holder) !== undefined;
          if (granted) admissions.set(activityKey, { holder, keys, revision, physical: target });
        } catch (error) { degrade(error); break; }
        if (granted) break;
        skipped.add(target);
      }
      if (!selected) throw new Error(`Native route/${role} exhausted: no compatible authenticated candidate outside cooldown`);
      const physical = identity(selected.model, selected.candidate.account);
      const account = selected.candidate.account === undefined ? undefined : config.accounts[selected.candidate.account];
      if (account) await useAccount(ctx, selected.candidate.provider, account);
      if (account) pi.events.emit("native-router:account-active", { provider: selected.candidate.provider, account: selected.candidate.account });
      const now = options.now?.() ?? Date.now();
      const logical = `route/${role}`;
      const ttl = route.candidates.find(c => identity(c, c.account) === state.physical)?.cacheTtlMs;
      const expired = cacheExpiry(state.cacheActivity, logical, state.physical, ttl, now);
      const switching = Boolean(state.physical && physical !== state.physical);
      if (switching) {
        if (state.transitions >= route.maxTransitions) throw new Error(`Native route/${role} transition budget exhausted`);
        const transition = { sessionId: ctx.sessionManager.getSessionId(), logical: `route/${role}`, from: state.physical, to: physical };
        await beforeTransition(pi, hook, transition, config.flushTimeoutMs, request.signal);
        state.transitions++;
        state.retries = 0;
        pi.events.emit("native-router:transition", transition);
        if (expired) {
          state.cacheActivity = { ...state.cacheActivity!, consumedAt: state.cacheActivity!.at };
          activities.set(activityKey, state.cacheActivity);
          pi.appendEntry(CACHE_ACTIVITY_ENTRY, state.cacheActivity);
          pi.events.emit("native-router:estimated-cache-invalidation", { ...transition, physical, reason: "estimated-expiry" });
        }
      } else if (expired) {
        const session = { sessionId: ctx.sessionManager.getSessionId() };
        await flush(session, request.signal);
        state.cacheActivity = { ...state.cacheActivity!, consumedAt: state.cacheActivity!.at };
        activities.set(activityKey, state.cacheActivity);
        pi.appendEntry(CACHE_ACTIVITY_ENTRY, state.cacheActivity);
        pi.events.emit("native-router:estimated-cache-invalidation", { ...session, logical, physical, reason: "estimated-expiry" });
      }
      state.physical = physical;
      state.floor = Math.max(state.floor, selected.model.contextWindow);
      delete state.next;
      const unchanged = old && JSON.stringify(old) === JSON.stringify(state);
      return { model: selected.model, thinkingLevel: selected.candidate.thinkingLevel, state: unchanged ? request.state : state };
    };
    pi.on("message_end", (event, ctx) => {
      if (event.message.role !== "assistant" || event.message.stopReason === "error" || event.message.stopReason === "aborted") return;
      const role = ctx.model?.provider === "route" ? ctx.model.id : undefined;
      if (!role || !config.routes[role]) return;
      const state = branchState(ctx, role);
      const physical = `${event.message.provider}/${event.message.model}`;
      const activityKey = `${ctx.sessionManager.getSessionId()}:${role}`;
      const pending = admissions.get(activityKey);
      if (pending && physicalOf(pending.physical) === physical) settleAdmission(activityKey, { recovered: true });
      if (!state || physicalOf(state.physical) !== physical) return;
      const activity = { logical: `route/${role}`, physical: state.physical, at: options.now?.() ?? Date.now() };
      activities.set(`${ctx.sessionManager.getSessionId()}:${role}`, activity);
      pi.appendEntry(CACHE_ACTIVITY_ENTRY, activity);
    });
    pi.registerVirtualModel<State>({
      provider: "route", id: role, name: `Route: ${role}`, contextWindow: route.contextWindow, maxTokens: route.outputReserve,
      route: (request, ctx) => request.reason === "direct" ? resolve(request, ctx) : serialized(ctx.sessionManager.getSessionId(), () => resolve(request, ctx)),
    });
  }
  // Tracker-sourced quota: snapshots are refreshed off the dispatch path and shown here.
  const quotaHolder = randomUUID();
  const quotaAccounts = Object.entries(config.accounts).filter(([, account]) => account.quota !== undefined);
  const refreshQuotas = async (): Promise<string[]> => {
    if (!store || quotaAccounts.length === 0) return [];
    const lines: string[] = [];
    for (const [id, account] of quotaAccounts) {
      const outcome = await refreshQuota(store, { id, provider: account.provider }, account.quota!, codexbarRunner, options.now ?? Date.now, quotaHolder);
      lines.push(outcome.status === "unavailable" ? `  ${id}: unknown (${outcome.reason})` : outcome.status === "leased" ? `  ${id}: refresh already in progress elsewhere` : `  ${id}: refreshed`);
    }
    return lines;
  };
  // Tracker quota refreshes on launch and periodically, never on the dispatch path. Leases keep
  // concurrent processes from refreshing the same account twice.
  let quotaTimer: ReturnType<typeof setInterval> | undefined;
  const refreshQuotaQuietly = () => { void refreshQuotas().catch(degrade); };
  pi.on("session_start", () => {
    if (quotaAccounts.length === 0 || !store) return;
    refreshQuotaQuietly();
    if (quotaTimer) clearInterval(quotaTimer);
    quotaTimer = setInterval(refreshQuotaQuietly, QUOTA_FRESH_MS);
    quotaTimer.unref?.();
  });
  pi.on("session_shutdown", () => {
    if (quotaTimer) clearInterval(quotaTimer);
    quotaTimer = undefined;
  });
  pi.registerCommand("pricing", {
    description: "Refresh catalog prices or show one physical model: /pricing refresh | /pricing show <provider>/<model>",
    handler: async (args, ctx) => {
      const [verb, target] = args.trim().split(/\s+/);
      const pricingPath = defaultPricingPath();
      if (verb === "refresh") {
        const result = await refreshSnapshot(options.now?.() ?? Date.now());
        if (!result.snapshot) { ctx.ui.notify(`native-router pricing: refresh failed (${result.failures.join("; ")}); keeping the last valid snapshot`, "warning"); return; }
        saveSnapshot(pricingPath, result.snapshot);
        const count = Object.keys(result.snapshot.records).length;
        ctx.ui.notify(`native-router pricing: ${count} physical-model records saved${result.failures.length ? `; skipped ${result.failures.join("; ")}` : ""}`, "info");
        return;
      }
      if (verb === "show" && target && target.includes("/")) {
        const slash = target.indexOf("/");
        const estimate = lookup(loadSnapshot(pricingPath), target.slice(0, slash), target.slice(slash + 1), config.pricingOverrides);
        if (estimate.status === "unpriced") { ctx.ui.notify(`native-router pricing: ${target} has no catalog entry (unpriced, never free)`, "info"); return; }
        const r = estimate.record;
        const rate = (v: number | undefined) => (v === undefined ? "unknown" : `$${v}`);
        const lines = [`${target}: ${estimate.status} list-price estimate (USD per 1M tokens, source ${r.provenance})`, `  input ${rate(r.input)}, output ${rate(r.output)}, cache read ${rate(r.cacheRead)}, cache write ${rate(r.cacheWrite)}`];
        if (estimate.status === "partial") lines.push(`  incomplete: missing ${estimate.missing.join(", ")}`);
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }
      ctx.ui.notify("usage: /pricing refresh | /pricing show <provider>/<model>", "error");
    },
  });
  pi.registerCommand("quotas-config", {
    description: "Generate CodexBar's config from quota-mapped router accounts: /quotas-config [--replace] [path]",
    handler: async (args, ctx) => {
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const replace = tokens.includes("--replace");
      const pathArg = tokens.filter(t => t !== "--replace");
      if (pathArg.length > 1) { ctx.ui.notify("usage: /quotas-config [--replace] [path]", "error"); return; }
      const path = pathArg[0] ?? codexbarConfigPath();
      const generated = generateCodexbarConfig(config.accounts, readAccountKey, Math.floor((options.now?.() ?? Date.now()) / 1000));
      if (generated.included.length === 0) { ctx.ui.notify(`native-router: no quota-mapped accounts with keys set (${generated.skipped.map(s => `${s.account}: ${s.reason}`).join("; ") || "none mapped"})`, "warning"); return; }
      try { writeCodexbarConfig(path, generated.document, replace); }
      catch (error) { ctx.ui.notify(`native-router: ${error instanceof Error ? error.message : String(error)}`, "error"); return; }
      const skipped = generated.skipped.length ? `; skipped ${generated.skipped.map(s => `${s.account} (${s.reason})`).join(", ")}` : "";
      ctx.ui.notify(`native-router: wrote CodexBar config to ${path} for ${generated.included.join(", ")} (keys written; file is 0600)${skipped}`, "info");
    },
  });
  pi.registerCommand("quotas", {
    description: "Show tracker quota windows per account and refresh them",
    handler: async (_args, ctx) => {
      if (quotaAccounts.length === 0) { ctx.ui.notify("native-router: no account has a quota mapping", "info"); return; }
      if (!store) { ctx.ui.notify("native-router: quotas need shared health; set sharedHealth to true", "warning"); return; }
      const refreshed = await refreshQuotas();
      const now = options.now?.() ?? Date.now();
      const lines = [`native-router quotas (${new Date(now).toISOString()})`, ...refreshed];
      for (const [id, account] of quotaAccounts) {
        const record = store.getSnapshot(id);
        if (!record?.body) { lines.push(`  ${id}: no snapshot${record?.error ? ` (${record.error})` : ""}`); continue; }
        const snapshot = record.body as QuotaSnapshot;
        const age = Math.round((now - snapshot.observedAt) / 1000);
        const blocked = store.blocked([`${account.provider}#${id}`]);
        lines.push(`  ${id} (${account.quota!.provider}${account.quota!.account ? `/${account.quota!.account}` : ""}) observed ${age}s ago${now - snapshot.observedAt > QUOTA_FRESH_MS ? " [stale]" : ""}, enforcement ${account.quota!.enforce ? "on" : "off"}`);
        for (const w of snapshot.windows) {
          const reset = w.resetsAt === undefined ? "reset unknown" : `resets ${new Date(w.resetsAt).toISOString()}`;
          lines.push(`    ${w.label}: ${w.usedPercent}% used, ${reset}`);
        }
        if (blocked?.kind === "tracker-quota") lines.push(`    blocking routing until ${new Date(blocked.until).toISOString()}`);
      }
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
  pi.registerCommand("native-router-health", {
    description: "Inspect shared native-router health, or reset one account: /native-router-health [reset <account>]",
    handler: async (args, ctx) => {
      if (!store) { ctx.ui.notify("native-router: shared health is disabled or unavailable; only process-local health applies", "warning"); return; }
      const reset = args.trim().match(/^reset\s+([a-z][a-z0-9_-]{0,31})$/);
      if (args.trim() && !reset) { ctx.ui.notify("usage: /native-router-health [reset <account>]", "error"); return; }
      if (reset) {
        const changed = store.resetAccount(reset[1]);
        ctx.ui.notify(`native-router: reset account ${reset[1]} (${changed} cause record${changed === 1 ? "" : "s"} cleared; other accounts and provider outages unchanged)`, "info");
        return;
      }
      const state = store.inspect();
      const now = options.now?.() ?? Date.now();
      const lines = [`native-router shared health (revision ${state.revision}, shared)`];
      for (const cause of state.causes) lines.push(`  ${cause.key}: ${cause.kind} until ${new Date(cause.until).toISOString()}${cause.until <= now ? " (expired, probe eligible)" : ""}`);
      for (const lease of state.leases) lines.push(`  probe ${lease.key}: held until ${new Date(lease.expires).toISOString()}`);
      if (state.causes.length === 0 && state.leases.length === 0) lines.push("  no active causes");
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
  pi.on("agent_before_settle", (event, ctx) => {
    if (event.outcome !== "error" || ctx.signal?.aborted || ctx.model?.provider !== "route" || ctx.hasPendingMessages()) return;
    const role = ctx.model.id;
    const route = config.routes[role];
    const state = branchState(ctx, role);
    if (!route || !state || state.next || state.recoveries >= route.maxRecoveries || state.transitions >= route.maxTransitions) return;
    const last = event.context.contextEntries.findLast(e => e.messages.length > 0);
    const message = last?.messages.at(-1);
    if (!message || message.role !== "assistant" || message.stopReason !== "error") return;
    const failed: Pick<Model<Api>, "provider" | "id"> = { provider: message.provider, id: message.model };
    if (physicalOf(state.physical) !== identity(failed)) return;
    const failure = classify(message, options.now?.());
    const observed = observe(message, options.now?.());
    settleAdmission(`${ctx.sessionManager.getSessionId()}:${role}`, { recovered: false });
    if (observed.kind !== "unsafe") health.mark(failed, observed, accountOf(state.physical));
    if (failure.kind === "unsafe") return;
    const selected = choose(route, available(route, ctx, config.accounts), health, Math.max(tokens(event.context.llmMessages), ctx.getContextUsage()?.tokens ?? 0), state.floor, undefined, state.physical);
    if (!selected) return;
    const before = event.context.contextMessages.slice(0, -1);
    if (!before.some(m => m.role !== "system") || before.at(-1)?.role === "assistant") return;
    return {
      entries: [
        { type: "context_edit", targetId: last!.sourceEntry.id, replacement: null },
        { type: "custom", customType: VIRTUAL_MODEL_STATE_ENTRY, data: { provider: "route", modelId: role, state: { ...state, next: identity(selected.model, selected.candidate.account), recoveries: state.recoveries + 1 } } },
      ],
      continue: true,
    };
  });
}
export default function nativeRouter(pi: ExtensionAPI) { installRouter(pi, readConfig()); }

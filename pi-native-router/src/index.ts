import {
  estimateTokens, VIRTUAL_MODEL_STATE_ENTRY,
  type ExtensionAPI, type ExtensionContext, type ModelRouteRequest, type ModelRoute,
} from "@earendil-works/pi-coding-agent";
import type { Api, Message, Model, ThinkingLevel as ModelThinkingLevel } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { readConfig, type Candidate, type Config, type KeySource, type RouteConfig } from "./config";
import { commandSlots, completeArguments } from "./completions";
import { keyActive, readKey, runtimeKeysAvailable, useKey } from "./accounts";
import { HealthStore } from "./health-store";
import { FOOTER_KEYS, peakText, physicalText, thinkingText } from "./footer";
import { DEFAULT_CYCLE_PIN } from "./config";
import { healthReport, type HealthMode } from "./health-report";
import { defaultDecisionLogPath, recordDecision, type DecisionReason } from "./decision-log";
import { codexbarRunner, formatRemaining, formatUsed, QUOTA_FRESH_MS, quotaScopeKey, refreshQuota, type QuotaSnapshot, type QuotaSource, usageBar } from "./quota";
import { codexbarConfigPath, generateCodexbarConfig, readCodexbarConfig, writeCodexbarConfig } from "./codexbar-config";
import { defaultPricingPath, loadSnapshot, refreshSnapshot, saveSnapshot } from "./pricing/cache";
import { lookup } from "./pricing/catalog";
import { applyPeak, backfillCost, labelRecordedPeak, type CostUsage } from "./pricing/reconcile";
import { accountOf, admissionKeys, cacheExpiry, choose, cycleTarget, classify, clampLevel, Health, identity, observe, partialOutput, physicalOf, requiredContext, restore, THINKING_ORDER, type Resolved, type State } from "./policy";
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
/** The key a candidate authenticates with: its named account, its provider's single key, or none (Pi's own login). */
function keyOf(candidate: Candidate, config: Config): KeySource | undefined {
  return candidate.account !== undefined ? config.accounts[candidate.account] : config.providerKeys[candidate.provider];
}
function available(route: RouteConfig, ctx: ExtensionContext, config: Config): Resolved[] {
  // A host without runtime key activation cannot serve keyed candidates; default-auth candidates stay usable.
  const keys = runtimeKeysAvailable(ctx);
  return route.candidates.flatMap(candidate => {
    const model = ctx.modelRegistry.find(candidate.provider, candidate.id);
    if (!model || model.api === "pi-virtual") return [];
    const source = keyOf(candidate, config);
    if (candidate.account !== undefined || source !== undefined) {
      return keys && source && readKey(source) !== undefined ? [{ candidate, model }] : [];
    }
    return ctx.modelRegistry.hasConfiguredAuth(model) ? [{ candidate, model }] : [];
  });
}
/** The error for a route with no dispatchable target; names the host gap when named accounts are the cause. */
function exhausted(role: string, route: RouteConfig, ctx: ExtensionContext, config: Config): Error {
  if (route.candidates.some(c => keyOf(c, config) !== undefined) && !runtimeKeysAvailable(ctx)) {
    return new Error(`Native route/${role} has keyed candidates (named accounts or a provider key), but this Pi host does not expose runtime key activation; use default-auth candidates or a Pi version that exposes it`);
  }
  return new Error(`Native route/${role} exhausted: no compatible authenticated candidate outside cooldown`);
}
// Direct calls never change the runtime key; they may only use named accounts already active.
async function activeOnly(candidates: Resolved[], ctx: ExtensionContext, config: Config): Promise<Resolved[]> {
  const kept: Resolved[] = [];
  for (const c of candidates) {
    const source = keyOf(c.candidate, config);
    if (!source || (await keyActive(ctx, source, c.candidate.provider))) kept.push(c);
  }
  return kept;
}
const CACHE_ACTIVITY_ENTRY = "@vanillagreen/pi-native-router/cache-activity";
/** The user's explicit thinking level while on a route, per role. Persisted so resumed branches keep it. */
const THINKING_CHOICE_ENTRY = "@vanillagreen/pi-native-router/thinking-choice";
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
/** The user's physical pin per route, persisted on the branch: a candidate identity, or null for auto. Last entry wins. */
const PIN_ENTRY = "@vanillagreen/pi-native-router/physical-pin";
type ShortcutKey = Parameters<ExtensionAPI["registerShortcut"]>[0];
function pinOf(ctx: ExtensionContext, role: string): string | null | undefined {
  const entry = ctx.sessionManager.getBranch().findLast(e => e.type === "custom" && e.customType === PIN_ENTRY && (e.data as { role?: string })?.role === role);
  if (entry?.type !== "custom") return undefined;
  const pinned = (entry.data as { identity?: unknown }).identity;
  return typeof pinned === "string" ? pinned : null;
}
function isPinned(ctx: ExtensionContext, role: string): boolean {
  return typeof pinOf(ctx, role) === "string";
}

/** The latest explicit route thinking choice on this branch, if the user made one. */
function userThinking(ctx: ExtensionContext, role: string): ModelThinkingLevel | undefined {
  const entry = ctx.sessionManager.getBranch().findLast(e => e.type === "custom" && e.customType === THINKING_CHOICE_ENTRY && (e.data as { role?: string })?.role === role);
  const level = entry?.type === "custom" ? (entry.data as { level?: unknown }).level : undefined;
  return typeof level === "string" && THINKING_LEVELS.has(level) ? (level as ModelThinkingLevel) : undefined;
}
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
export function installRouter(pi: ExtensionAPI, config: Config, options: { transition?: TransitionHook; now?: () => number; healthPath?: string; decisionLogPath?: string } = {}) {
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
  const decisionLogPath = options.decisionLogPath ?? defaultDecisionLogPath();
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
      const candidates = available(route, ctx, config);
      const estimate = Math.max(tokens(request.messages), request.reason === "direct" ? 0 : ctx.getContextUsage()?.tokens ?? 0);
      if (request.reason === "direct") {
        const selected = choose(route, await activeOnly(candidates, ctx, config), health, estimate);
        if (!selected) throw exhausted(role, route, ctx, config);
        publishRoute(ctx, selected.model, selected.candidate.account, selected.candidate.thinkingLevel, undefined, isPinned(ctx, role));
        return { model: selected.model, thinkingLevel: selected.candidate.thinkingLevel };
      }
      const old = restore(request.state);
      const persisted = branchState(ctx, role);
      const activityKey = `${ctx.sessionManager.getSessionId()}:${role}`;
      const activity = activities.get(activityKey) ?? persisted?.cacheActivity ?? old?.cacheActivity;
      if (old && activity) old.cacheActivity = activity;
      const turn = turnKey(ctx);
      const state: State = old ? { ...old } : { version: 1, physical: "", turn, retries: 0, transitions: 0, recoveries: 0 };
      if (activity) state.cacheActivity = activity;
      if (state.turn !== turn) Object.assign(state, { turn, retries: 0, transitions: 0, recoveries: 0, next: undefined });
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
        const failedTarget = identity(request.failed.model, failedAccount);
        if (!stay) {
          health.mark(request.failed.model, failure, failedAccount);
          exclude = failedTarget;
          const blocked = health.blockedReason(request.failed.model, failedAccount);
          if (ctx.hasUI) ctx.ui.notify(`native-router: ${failedTarget} ${failure.kind} failure${blocked ? `; cooling down until ${new Date(blocked.until).toISOString()}` : ""}`, "warning");
        } else if (ctx.hasUI) ctx.ui.notify(`native-router: ${failedTarget} transient failure; retrying (${state.retries}/${route.stayRetries})`, "info");
      }
      // Admit one recovery probe per expired scope on the chosen target, or move to the next target.
      const skipped = new Set<string>(exclude ? [exclude] : []);
      // A pin is preferred after recovery and ahead of the current physical model; a dormant pin falls back to route order.
      const pin = pinOf(ctx, role);
      const preferred = state.next ?? (typeof pin === "string" ? pin : state.physical);
      let selected: Resolved | undefined;
      for (;;) {
        selected = choose(route, candidates, health, estimate, preferred, skipped);
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
      if (!selected) {
        // Every rejection is secret-free and names the reason, so a live exhaustion is diagnosable from the error.
        const detail = route.candidates.map(candidate => {
          const target = `${candidate.provider}/${candidate.id}${candidate.account ? `#${candidate.account}` : ""}`;
          const model = ctx.modelRegistry.find(candidate.provider, candidate.id);
          if (!model || model.api === "pi-virtual") return `${target}: not registered`;
          const source = keyOf(candidate, config);
          if (candidate.account !== undefined && !source) return `${target}: unknown account`;
          if (source) {
            if (!runtimeKeysAvailable(ctx)) return `${target}: this Pi host does not expose runtime key activation`;
            if (readKey(source) === undefined) return `${target}: key source missing or empty`;
          } else if (!ctx.modelRegistry.hasConfiguredAuth(model)) return `${target}: no configured auth`;
          if (exclude === target) return `${target}: excluded after this request's failure`;
          if (skipped.has(target)) return `${target}: skipped after a refused probe lease or a failed activation`;
          const blocked = health.blockedReason(model, candidate.account);
          if (blocked) return `${target}: ${blocked.kind} cooldown until ${new Date(blocked.until).toISOString()}`;
          const needed = requiredContext(route, model, estimate);
          return `${target}: needs ${needed} context tokens (window ${model.contextWindow}, max output ${model.maxTokens})`;
        });
        throw new Error(`Native route/${role} exhausted: no dispatchable candidate. ${detail.join("; ")}`);
      }
      const physical = identity(selected.model, selected.candidate.account);
      const key = keyOf(selected.candidate, config);
      if (state.physical !== physical) {
        const reason: DecisionReason = !old || !state.physical ? "initial" : request.failed ? "failover" : "sticky";
        recordDecision(decisionLogPath, { at: new Date(options.now?.() ?? Date.now()).toISOString(), session: ctx.sessionManager.getSessionId(), logical: `route/${role}`, ...(state.physical ? { previous: state.physical } : {}), physical, ...(selected.candidate.account ? { account: selected.candidate.account } : {}), reason, contextTokens: estimate, requiredContext: requiredContext(route, selected.model, estimate) }, degrade);
      }
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
        if (request.failed && ctx.hasUI) ctx.ui.notify(`native-router: ${logical} failed over from ${transition.from} to ${physical}; the route's cache rebuilds on the next request`, "warning");
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
      // The account's key is activated after any pre-dispatch flush, so a blocked replacement leaves the runtime key alone.
      if (key) {
        try { await useKey(ctx, selected.candidate.provider, key); }
        catch (error) {
          settleAdmission(activityKey, { recovered: false });
          const reason = error instanceof Error ? error.message : String(error);
          pi.events.emit("native-router:account-unavailable", { provider: selected.candidate.provider, account: selected.candidate.account, reason });
          throw new Error(`Native route/${role} failed closed before dispatch: ${reason}`);
        }
        pi.events.emit("native-router:account-active", { provider: selected.candidate.provider, account: selected.candidate.account });
      }
      state.physical = physical;
      delete state.next;
      const unchanged = old && JSON.stringify(old) === JSON.stringify(state);
      // An explicit user choice on this route overrides the candidate default; reasoning-less models keep theirs.
      const explicit = userThinking(ctx, role);
      const thinkingLevel = (explicit === undefined ? selected.candidate.thinkingLevel : clampLevel(selected.model, explicit)) as ModelThinkingLevel;
      publishRoute(ctx, selected.model, selected.candidate.account, thinkingLevel, explicit, isPinned(ctx, role));
      return { model: selected.model, thinkingLevel, state: unchanged ? request.state : state };
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
      provider: "route", id: role, name: role, contextWindow: route.contextWindow, maxTokens: route.outputReserve,
      // Every level is offered so Shift+Tab can change it; each physical candidate clamps the choice to what it supports.
      thinkingLevels: [...THINKING_ORDER],
      route: (request, ctx) => request.reason === "direct" ? resolve(request, ctx) : serialized(ctx.sessionManager.getSessionId(), () => resolve(request, ctx)),
    });
  }
  // Tracker-sourced quota: snapshots are refreshed off the dispatch path and shown here.
  const quotaHolder = randomUUID();
  // Every tracker-quota scope: named accounts, plus default-auth providers (Pi's own login).
  const quotaScopes: Array<{ label: string; key: string; scope: { provider: string; account?: string }; quota: QuotaSource }> = [
    ...Object.entries(config.accounts).filter(([, account]) => account.quota !== undefined).map(([id, account]) => ({
      label: id, key: quotaScopeKey(account.provider, id), scope: { provider: account.provider, account: id }, quota: account.quota!,
    })),
    ...Object.entries(config.quotas).map(([provider, quota]) => ({ label: provider, key: quotaScopeKey(provider), scope: { provider }, quota })),
  ];
  const refreshQuotas = async (force = false): Promise<string[]> => {
    if (!store || quotaScopes.length === 0) return [];
    const lines: string[] = [];
    const now = options.now ?? Date.now;
    for (const { label, scope, quota } of quotaScopes) {
      const outcome = await refreshQuota(store, scope, quota, codexbarRunner, now, quotaHolder, { force });
      lines.push(outcome.status === "unavailable" ? `  ${label}: unknown (${outcome.reason})`
        : outcome.status === "leased" ? `  ${label}: refresh already in progress elsewhere`
        : outcome.status === "cached" ? `  ${label}: reused a fetch ${Math.round((now() - outcome.observedAt) / 1000)}s old`
        : `  ${label}: refreshed`);
    }
    return lines;
  };
  // Tracker quota refreshes on launch and periodically, never on the dispatch path. The shared store gates
  // CodexBar runs across processes; leases only stop overlapping runs.
  let quotaTimer: ReturnType<typeof setInterval> | undefined;
  const refreshQuotaQuietly = () => { void refreshQuotas().catch(degrade); };
  // The model that was active before the latest switch. Pi applies the thinking level for a switch before
  // it emits model_select, so a thinking change counts as a user choice only when the model did not just change.
  const activeModel = new Map<string, string>();
  pi.on("session_start", (_event, ctx) => {
    if (ctx.model) activeModel.set(ctx.sessionManager.getSessionId(), `${ctx.model.provider}/${ctx.model.id}`);
    publishSelection(ctx, ctx.model);
  });
  // Footer items for the selected model. A route's physical model and peak are only known when a request resolves,
  // so a route clears them until then; a direct model shows its session thinking level.
  // The candidate the next request will try: the pin, else the last served physical, else route order. Shown before any
  // request, so the footer and /route-pin cycling start from what the route will actually do.
  const displayed = (ctx: ExtensionContext, role: string): Resolved | undefined => {
    const route = config.routes[role];
    const pin = pinOf(ctx, role);
    const preferred = typeof pin === "string" ? pin : branchState(ctx, role)?.physical;
    return choose(route, available(route, ctx, config), health, ctx.getContextUsage()?.tokens ?? 0, preferred);
  };
  const previewRoute = (ctx: ExtensionContext, role: string) => {
    if (!ctx.hasUI) return;
    const shown = displayed(ctx, role);
    if (!shown) { ctx.ui.setStatus(FOOTER_KEYS.physical, undefined); ctx.ui.setStatus(FOOTER_KEYS.peak, undefined); return; }
    const { model, candidate } = shown;
    ctx.ui.setStatus(FOOTER_KEYS.physical, physicalText(model.provider, model.id, candidate.account, config.display, isPinned(ctx, role)));
    ctx.ui.setStatus(FOOTER_KEYS.peak, peakText(model.provider, model.id, options.now?.() ?? Date.now()));
  };
  const publishSelection = (ctx: ExtensionContext, model: Model<Api> | undefined) => {
    if (!ctx.hasUI) return;
    if (model?.provider === "route" && config.routes[model.id]) previewRoute(ctx, model.id);
    else { ctx.ui.setStatus(FOOTER_KEYS.physical, undefined); ctx.ui.setStatus(FOOTER_KEYS.peak, undefined); }
    ctx.ui.setStatus(FOOTER_KEYS.thinking, model !== undefined && model.provider !== "route" && model.reasoning && ctx.thinkingLevel ? thinkingText(ctx.thinkingLevel, undefined) : undefined);
  };
  // The physical model, peak and effective thinking level of a request this route has just resolved.
  const publishRoute = (ctx: ExtensionContext, model: Model<Api>, account: string | undefined, effective: string, requested: string | undefined, pinned: boolean) => {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus(FOOTER_KEYS.physical, physicalText(model.provider, model.id, account, config.display, pinned));
    ctx.ui.setStatus(FOOTER_KEYS.peak, peakText(model.provider, model.id, options.now?.() ?? Date.now()));
    ctx.ui.setStatus(FOOTER_KEYS.thinking, model.reasoning ? thinkingText(effective, requested) : undefined);
  };
  pi.on("model_select", (event, ctx) => {
    activeModel.set(ctx.sessionManager.getSessionId(), `${event.model.provider}/${event.model.id}`);
    publishSelection(ctx, event.model);
  });
  pi.on("thinking_level_select", (event, ctx) => {
    const model = ctx.model;
    if (!model || model.provider !== "route" || !config.routes[model.id]) {
      if (ctx.hasUI) ctx.ui.setStatus(FOOTER_KEYS.thinking, model?.reasoning ? thinkingText(event.level, undefined) : undefined);
      return;
    }
    // A switch emits model_select before its thinking change is applied to the new model, so the
    // current model is the route only when the last switch (or the session's initial model) was the route.
    const known = activeModel.get(ctx.sessionManager.getSessionId());
    if (known !== undefined && known !== `route/${model.id}`) return;
    pi.appendEntry(THINKING_CHOICE_ENTRY, { role: model.id, level: event.level });
    // The next request resolves the physical candidate and clamps this choice; until then it is shown as pending.
    if (ctx.hasUI) ctx.ui.setStatus(FOOTER_KEYS.thinking, thinkingText(event.level, event.level));
  });
  pi.on("session_start", () => {
    if (quotaScopes.length === 0 || !store) return;
    refreshQuotaQuietly();
    if (quotaTimer) clearInterval(quotaTimer);
    quotaTimer = setInterval(refreshQuotaQuietly, QUOTA_FRESH_MS);
    quotaTimer.unref?.();
  });
  pi.on("session_shutdown", () => {
    if (quotaTimer) clearInterval(quotaTimer);
    quotaTimer = undefined;
  });
  const slots = commandSlots(config);
  pi.registerCommand("pricing", {
    getArgumentCompletions: prefix => completeArguments(prefix, slots.pricing),
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
    getArgumentCompletions: prefix => completeArguments(prefix, slots["quotas-config"]),
    description: "Merge quota-mapped router accounts and providers into CodexBar's config: /quotas-config [--replace] [path]",
    handler: async (args, ctx) => {
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const replace = tokens.includes("--replace");
      const pathArg = tokens.filter(t => t !== "--replace");
      if (pathArg.length > 1) { ctx.ui.notify("usage: /quotas-config [--replace] [path]", "error"); return; }
      const path = pathArg[0] ?? codexbarConfigPath();
      let existing: ReturnType<typeof readCodexbarConfig>;
      try {
        existing = readCodexbarConfig(path);
        if (existing !== undefined && !replace) throw new Error(`${path} exists; rerun with --replace to merge router providers into it`);
      } catch (error) { ctx.ui.notify(`native-router: ${error instanceof Error ? error.message : String(error)}`, "error"); return; }
      const generated = generateCodexbarConfig(config.accounts, config.providerKeys, config.quotas, readKey, Math.floor((options.now?.() ?? Date.now()) / 1000), existing);
      if (generated.included.length === 0 && Object.keys(config.quotas).length === 0) { ctx.ui.notify(`native-router: no quota-mapped accounts with keys set (${generated.skipped.map(s => `${s.account}: ${s.reason}`).join("; ") || "none mapped"})`, "warning"); return; }
      try { writeCodexbarConfig(path, generated.document, true); }
      catch (error) { ctx.ui.notify(`native-router: ${error instanceof Error ? error.message : String(error)}`, "error"); return; }
      const providers = (generated.document.providers as Array<{ id: string }>).map(entry => entry.id).join(", ");
      const skipped = generated.skipped.length ? `; skipped ${generated.skipped.map(s => `${s.account} (${s.reason})`).join(", ")}` : "";
      ctx.ui.notify(`native-router: wrote CodexBar config to ${path}; router providers: ${providers} (accounts with keys: ${generated.included.join(", ") || "none"}; other providers kept; file is 0600)${skipped}`, "info");
    },
  });
  pi.registerCommand("quotas", {
    getArgumentCompletions: prefix => completeArguments(prefix, slots.quotas),
    description: "Show tracker quota windows per account; reuses recent fetches unless `refresh` is given",
    handler: async (args, ctx) => {
      if (quotaScopes.length === 0) { ctx.ui.notify("native-router: no account or provider has a quota mapping", "info"); return; }
      if (!store) { ctx.ui.notify("native-router: quotas need shared health; set sharedHealth to true", "warning"); return; }
      const refreshed = await refreshQuotas(args.trim() === "refresh");
      const now = options.now?.() ?? Date.now();
      const lines = [`native-router quotas (${new Date(now).toISOString()})`, ...refreshed];
      for (const { label, key, quota } of quotaScopes) {
        const record = store.getSnapshot(key);
        if (!record?.body) { lines.push(`  ${label}: no snapshot${record?.error ? ` (${record.error})` : ""}`); continue; }
        const snapshot = record.body as QuotaSnapshot;
        const age = Math.round((now - snapshot.observedAt) / 1000);
        const blocked = store.blocked([key]);
        lines.push(`  ${label} (${quota.provider}${quota.account ? `/${quota.account}` : ""}) observed ${age}s ago${now - snapshot.observedAt > QUOTA_FRESH_MS ? " [stale]" : ""}, enforcement ${quota.enforce ? "on" : "off"}`);
        for (const w of snapshot.windows) {
          const reset = w.resetsAt === undefined ? "reset unknown" : `resets in ${formatRemaining(w.resetsAt, now)}`;
          lines.push(`    ${w.label} ${usageBar(w.usedPercent)} ${formatUsed(w.usedPercent)} used, ${reset}`);
        }
        if (blocked?.kind === "tracker-quota") lines.push(`    blocking routing until ${new Date(blocked.until).toISOString()}`);
      }
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
  const pinRoute = (ctx: ExtensionContext, role: string, choice: string | null) => {
    pi.appendEntry(PIN_ENTRY, { role, identity: choice });
    recordDecision(decisionLogPath, { at: new Date(options.now?.() ?? Date.now()).toISOString(), session: ctx.sessionManager.getSessionId(), logical: `route/${role}`, physical: choice === null ? "auto" : physicalOf(choice), ...(choice && accountOf(choice) ? { account: accountOf(choice) } : {}), reason: "manual" }, degrade);
    previewRoute(ctx, role);
    const note = choice === null ? `native-router: ${role} follows route order` : `native-router: ${role} pinned to ${choice}`;
    ctx.ui.notify(`${note}; the route's cache rebuilds on the next request`, "info");
  };
  const cyclePin = (ctx: ExtensionContext) => {
    const model = ctx.model;
    if (!model || model.provider !== "route" || !config.routes[model.id]) { ctx.ui.notify("native-router: select a route first", "warning"); return; }
    const role = model.id;
    const shown = displayed(ctx, role);
    const target = cycleTarget(config.routes[role], available(config.routes[role], ctx, config), health, ctx.getContextUsage()?.tokens ?? 0, shown && identity(shown.model, shown.candidate.account));
    if (!target) { ctx.ui.notify(`native-router: no eligible candidate for ${role}; pin unchanged`, "warning"); return; }
    pinRoute(ctx, role, identity(target.model, target.candidate.account));
  };
  pi.registerCommand("route-pin", {
    description: "Pin this route to one candidate, or auto: /route-pin [candidate|auto]",
    getArgumentCompletions: prefix => completeArguments(prefix, slots["route-pin"]),
    handler: async (args, ctx) => {
      const model = ctx.model;
      if (!model || model.provider !== "route" || !config.routes[model.id]) { ctx.ui.notify("native-router: select a route first", "warning"); return; }
      const role = model.id;
      const labels = config.routes[role].candidates.map(c => identity(c, c.account));
      const requested = args.trim();
      let choice: string | null;
      if (requested === "") {
        if (!ctx.hasUI) { ctx.ui.notify(`native-router: ${role} candidates: ${labels.join(", ")}`, "info"); return; }
        const picked = await ctx.ui.select(`Pin ${role} to`, ["auto", ...labels]);
        if (picked === undefined) return;
        choice = picked === "auto" ? null : picked;
      } else if (requested === "auto") choice = null;
      else if (labels.includes(requested)) choice = requested;
      else { ctx.ui.notify(`native-router: ${requested} is not a candidate of ${role}; use auto or one of: ${labels.join(", ")}`, "error"); return; }
      pinRoute(ctx, role, choice);
    },
  });
  pi.registerShortcut((config.shortcuts?.cyclePin ?? DEFAULT_CYCLE_PIN) as ShortcutKey, {
    description: "Cycle this route's physical pin to the next eligible candidate",
    handler: ctx => cyclePin(ctx),
  });
  pi.registerCommand("route-thinking", {
    description: "Clear this route's thinking choice so candidate defaults apply again: /route-thinking default",
    getArgumentCompletions: prefix => completeArguments(prefix, slots["route-thinking"]),
    handler: async (args, ctx) => {
      if (args.trim() !== "default") { ctx.ui.notify("usage: /route-thinking default", "error"); return; }
      const model = ctx.model;
      if (!model || model.provider !== "route" || !config.routes[model.id]) { ctx.ui.notify("native-router: select a route first", "warning"); return; }
      pi.appendEntry(THINKING_CHOICE_ENTRY, { role: model.id, level: null });
      if (ctx.hasUI) ctx.ui.setStatus(FOOTER_KEYS.thinking, undefined);
      ctx.ui.notify(`native-router: ${model.id} thinking choice cleared; candidate defaults apply from the next request`, "info");
    },
  });
  pi.registerCommand("native-router-health", {
    getArgumentCompletions: prefix => completeArguments(prefix, slots["native-router-health"]),
    description: "Inspect native-router health, or reset one account: /native-router-health [reset <account>]",
    handler: async (args, ctx) => {
      const mode: HealthMode = store ? "shared" : config.sharedHealth ? "degraded-local" : "local-only";
      const reset = args.trim().match(/^reset\s+([a-z][a-z0-9_-]{0,31})$/);
      if (args.trim() && !reset) { ctx.ui.notify("usage: /native-router-health [reset <account>]", "error"); return; }
      if (!store) {
        const message = mode === "local-only"
          ? "native-router: sharedHealth is disabled; only process-local health applies, nothing is shared"
          : "native-router: shared health store is unavailable; only process-local health applies, nothing is shared";
        ctx.ui.notify(message, reset ? "error" : "warning");
        return;
      }
      try {
        if (reset) {
          const changed = store.resetAccount(reset[1]);
          ctx.ui.notify(`native-router: reset account ${reset[1]} (${changed} cause record${changed === 1 ? "" : "s"} cleared; other accounts and provider outages unchanged; in-flight probes fenced)`, "info");
          return;
        }
        ctx.ui.notify(healthReport(store.inspect(), options.now?.() ?? Date.now(), mode).join("\n"), "info");
      } catch (error) {
        degrade(error);
        ctx.ui.notify(`native-router: shared health store failed (${error instanceof Error ? error.message : String(error)}); only process-local health applies`, "error");
      }
    },
  });
  // Cost reconciliation for finished assistant messages, before pi-otel reads usage on turn_end.
  // Pi's recorded cost stays the source; peak pricing and catalog backup adjust it only as defined in reconcile.ts.
  pi.on("message_end", (event, ctx) => {
    const message = event.message as { role?: string; provider?: string; model?: string; timestamp?: number; usage?: CostUsage };
    if (message.role !== "assistant" || !message.provider || !message.model || !message.usage?.cost) return;
    const at = typeof message.timestamp === "number" ? message.timestamp : (options.now?.() ?? Date.now());
    const usage = message.usage;
    const piModel = ctx.modelRegistry.find(message.provider, message.model);
    const piHasPrice = piModel?.cost !== undefined;
    let changed = false;
    if (!piHasPrice || usage.cost.total === 0) {
      try {
        const estimate = lookup(loadSnapshot(defaultPricingPath()), message.provider, message.model, config.pricingOverrides);
        changed = backfillCost(usage, piHasPrice, estimate.status === "unpriced" ? undefined : estimate.record) || changed;
      }
      catch (error) { degrade(error); }
    }
    changed = applyPeak(usage, message.provider, message.model, at) || labelRecordedPeak(usage, message.provider, message.model, at) || changed;
    if (!changed) return;
    return { message: { ...message, usage } as typeof event.message };
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
    const selected = choose(route, available(route, ctx, config), health, Math.max(tokens(event.context.llmMessages), ctx.getContextUsage()?.tokens ?? 0), undefined, state.physical);
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

import type { Config } from "./config";

/** Pi's argument completion item; `value` replaces the whole argument text, not just the last token. */
export interface ArgumentCompletion { value: string; label: string; description?: string }

/** One argument position: the candidates offered after the tokens already typed. */
export type ArgumentSlots = (done: string[]) => Array<{ value: string; description?: string }>;

/**
 * Completes a router command's argument text. Pi passes only the argument prefix, so each command's slots
 * say what may follow the complete tokens already typed; the partial last token filters them.
 */
export function completeArguments(prefix: string, slots: ArgumentSlots): ArgumentCompletion[] | null {
  const trimmed = prefix.trim();
  const tokens = trimmed === "" ? [] : trimmed.split(/\s+/);
  const endsWithSpace = prefix === "" || /\s$/.test(prefix);
  const done = endsWithSpace ? tokens : tokens.slice(0, -1);
  const current = endsWithSpace ? "" : tokens[tokens.length - 1] ?? "";
  const base = done.length > 0 ? `${done.join(" ")} ` : "";
  const items = slots(done)
    .filter(option => option.value.startsWith(current) && !done.includes(option.value))
    .map(option => ({ value: `${base}${option.value}`, label: option.value, ...(option.description ? { description: option.description } : {}) }));
  return items.length > 0 ? items : null;
}

/** Completions for the four router commands, keyed by command name. */
/**
 * The router account or provider a live block belongs to, for `/native-router-health reset`. A block keyed by an
 * account resets that account; a block keyed only by a provider (single-key) resets the provider.
 */
export function blockedResetName(key: string, config: Config): string | undefined {
  const account = key.split("#")[1];
  if (account !== undefined) return Object.values(config.providers).some(p => account in p.accounts) ? account : undefined;
  const provider = key.split("/")[0];
  return provider in config.providers ? provider : undefined;
}

export function commandSlots(config: Config, blocked: () => string[] = () => []): Record<"pricing" | "quotas" | "quotas-config" | "native-router-health" | "route-thinking" | "route-pin", ArgumentSlots> {
  // Price targets are the physical models the routes can select, so the list stays short and needs no catalog load.
  const accounts = Object.values(config.providers).flatMap(provider => Object.keys(provider.accounts));
  const targets = [...new Set(Object.values(config.routes).flatMap(route => route.candidates.map(c => `${c.provider}/${c.id}`)))];
  // The current route is not known while completing, so pin labels cover every route; the command validates against its own route.
  const pinLabels = [...new Set(Object.values(config.routes).flatMap(route => route.candidates.map(c => `${c.provider}/${c.id}${c.account ? `#${c.account}` : ""}`)))];
  return {
    pricing: done => done.length === 0
      ? [{ value: "refresh", description: "download and save catalog prices" }, { value: "show", description: "show one physical model's rates" }]
      : done[0] === "show" && done.length === 1 ? targets.map(value => ({ value, description: "physical model" })) : [],
    quotas: done => done.length === 0 ? [{ value: "refresh", description: "fetch tracker quota now, ignoring the reuse gate" }] : [],
    "quotas-config": () => [{ value: "--replace", description: "replace an existing CodexBar config file" }],
    "route-pin": done => done.length === 0
      ? [{ value: "auto", description: "follow route order again" }, ...pinLabels.map(value => ({ value, description: "candidate" }))]
      : [],
    "route-thinking": done => done.length === 0 ? [{ value: "default", description: "use candidate thinking defaults again" }] : [],
    "native-router-health": done => done.length === 0
      ? [{ value: "reset", description: "clear one account's or provider's health causes" }]
      // Only names with a live block are offered; the list is read at completion time, so it is never stale.
      : done[0] === "reset" && done.length === 1 ? [...new Set(blocked().map(key => blockedResetName(key, config)).filter((name): name is string => name !== undefined))]
          .map(value => ({ value, description: accounts.includes(value) ? "blocked account" : "blocked provider" })) : [],
  };
}

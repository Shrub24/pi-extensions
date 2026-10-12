import type { Display } from "./config";
import { isPeakPriced, isPeakRecorded } from "./pricing/reconcile";

/**
 * Footer status keys the router publishes through `ctx.ui.setStatus`. Powerline shows them as custom
 * items; an unset key (`undefined`) hides its item.
 */
export const FOOTER_KEYS = {
  physical: "native-router-physical",
  peak: "native-router-peak",
  thinking: "native-router-thinking",
} as const;

/**
 * The physical model that will serve the request, as `provider/model`, with its account when one is bound.
 * Configured display labels replace the provider and model names on screen only.
 */
export function physicalText(provider: string, id: string, account: string | undefined, display?: Display): string {
  const shownProvider = display?.providers[provider] ?? provider;
  const shownModel = display?.models[`${provider}/${id}`] ?? id;
  const name = `${shownProvider}/${shownModel}`;
  return account === undefined ? name : `${name} · ${account}`;
}

/** A peak symbol while the physical model's price is at peak, evaluated when the request is dispatched. */
export function peakText(provider: string, id: string, atMs: number): string | undefined {
  return isPeakPriced(provider, id, atMs) || isPeakRecorded(provider, id, atMs) ? "▲" : undefined;
}

/**
 * The thinking level that will run, by its raw name. A level the user chose on the route adds a pencil
 * mark; otherwise the candidate's default applies and the name stands alone.
 */
export function thinkingText(effective: string, requested: string | undefined): string {
  return requested === undefined ? effective : `${effective}✎`;
}

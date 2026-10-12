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
 * The physical model that will serve the request, as `provider/name`, with its account when one is bound.
 * `name` is Pi's model name; a configured provider label replaces the provider id on screen only.
 */
export function physicalText(provider: string, name: string, account: string | undefined, display?: Display, pinned = false): string {
  const shown = `${display?.providers[provider] ?? provider}/${name}`;
  const label = account === undefined ? shown : `${shown} · ${account}`;
  return pinned ? `${label} ⚑` : label;
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

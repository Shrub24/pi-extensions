import type { Display } from "./config";
import { isPeakPriced, isPeakRecorded } from "./pricing/reconcile";

/**
 * Footer status keys the router publishes through `ctx.ui.setStatus`. Powerline shows them as custom
 * items; an unset key (`undefined`) hides its item.
 */
export const FOOTER_KEYS = {
  provider: "native-router-provider",
  model: "native-router-model",
  peak: "native-router-peak",
  thinking: "native-router-thinking",
} as const;

/**
 * The provider that will serve the request, with its account when one is bound. A configured provider label
 * replaces the provider id on screen only.
 */
export function providerText(provider: string, account: string | undefined, display?: Display): string {
  const shown = display?.providers[provider] ?? provider;
  return account === undefined ? shown : `${shown} · ${account}`;
}

/** The model that will serve the request, by Pi's model name, with a pin mark while a route pin is set. */
export function modelText(name: string, pinned = false): string {
  return pinned ? `${name} ⚑` : name;
}

/** A peak symbol while the physical model's price is at peak, evaluated when the request is dispatched. */
export function peakText(provider: string, id: string, atMs: number): string | undefined {
  return isPeakPriced(provider, id, atMs) || isPeakRecorded(provider, id, atMs) ? "▲" : undefined;
}

/** Nerd Font `nf-fa-pencil` (U+F040), marking a thinking level the user chose on the route. */
const USER_CHOICE_GLYPH = "\uF040";

/**
 * The thinking level that will run, by its raw name. A level the user chose on the route adds a pencil
 * mark after a space; otherwise the candidate's default applies and the name stands alone.
 */
export function thinkingText(effective: string, requested: string | undefined): string {
  return requested === undefined ? effective : `${effective} ${USER_CHOICE_GLYPH}`;
}

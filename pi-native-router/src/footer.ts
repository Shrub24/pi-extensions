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

/** The physical model that will serve the request, with its account when one is bound. */
export function physicalText(provider: string, id: string, account?: string): string {
  return account === undefined ? `${provider}/${id}` : `${provider}/${id} · ${account}`;
}

/** A peak marker while the physical model's price is at peak, evaluated when the request is dispatched. */
export function peakText(provider: string, id: string, atMs: number): string | undefined {
  return isPeakPriced(provider, id, atMs) || isPeakRecorded(provider, id, atMs) ? "▲ peak" : undefined;
}

/**
 * The thinking level that will run. `requested` is the user's route choice before clamping; without one the
 * candidate's default applies and no marker is shown.
 */
export function thinkingText(effective: string, requested: string | undefined): string {
  if (requested === undefined) return effective;
  return requested === effective ? `${effective} (set)` : `${effective} (clamped from ${requested})`;
}

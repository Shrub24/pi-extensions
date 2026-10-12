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

/** The physical model id that will serve the request, with its account when one is bound. */
export function physicalText(id: string, account?: string): string {
  return account === undefined ? id : `${id} · ${account}`;
}

/** A peak symbol while the physical model's price is at peak, evaluated when the request is dispatched. */
export function peakText(provider: string, id: string, atMs: number): string | undefined {
  return isPeakPriced(provider, id, atMs) || isPeakRecorded(provider, id, atMs) ? "▲" : undefined;
}

/** One bar per thinking level, rising from off to max. */
const THINKING_BARS: Record<string, string> = { off: "▁", minimal: "▂", low: "▃", medium: "▄", high: "▅", xhigh: "▆", max: "█" };

/**
 * The thinking level that will run, as a bar. A level the user chose on the route adds a pencil mark;
 * otherwise the candidate's default applies and the bar stands alone.
 */
export function thinkingText(effective: string, requested: string | undefined): string {
  const bar = THINKING_BARS[effective] ?? effective;
  return requested === undefined ? bar : `${bar}✎`;
}

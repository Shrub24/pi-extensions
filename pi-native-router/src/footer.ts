import type { Display } from "./config";
import { isPeakPriced, isPeakRecorded } from "./pricing/reconcile";

/**
 * Footer status keys the router publishes through `ctx.ui.setStatus`. Powerline shows them as custom
 * items; an unset key (`undefined`) hides its item.
 */
export const FOOTER_KEYS = {
  provider: "native-router-provider",
  model: "native-router-model",
  thinking: "native-router-thinking",
} as const;

/** Nerd Font glyphs (`nf-md-*`) for the model entry: a route pin, its fallback, and peak pricing. */
export const PIN_GLYPH = "\u{F0931}";
export const PIN_FALLBACK_GLYPH = "\u{F0930}";
export const PEAK_GLYPH = "\u{F0535}";

/** Standard ANSI colours. The status channel carries no theme, so these do not follow the active theme. */
const ANSI_WARNING = (text: string) => `\x1b[33m${text}\x1b[39m`;
const ANSI_ERROR = (text: string) => `\x1b[31m${text}\x1b[39m`;

/**
 * The provider that will serve the request, with its account when one is bound. A configured provider label
 * replaces the provider id on screen only.
 */
export function providerText(provider: string, account: string | undefined, display?: Display): string {
  const shown = display?.providers[provider] ?? provider;
  return account === undefined ? shown : `${shown} · ${account}`;
}

/** Whether the physical model's price is at peak, evaluated when the request is dispatched. */
export function isPeakNow(provider: string, id: string, atMs: number): boolean {
  return isPeakPriced(provider, id, atMs) || isPeakRecorded(provider, id, atMs);
}

/**
 * Pi's model name without the provider it is listed under, so `Claude Haiku 5.5` under `Claude` reads
 * `Haiku 5.5`. The name is only shortened when something remains after the prefix.
 */
export function stripProviderPrefix(name: string, providerLabel: string, providerId: string): string {
  for (const prefix of [providerLabel, providerId]) {
    if (!prefix) continue;
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = name.match(new RegExp(`^${escaped}(?:\\s*[·:–-]\\s*|\\s+)(?=\\S)`, "i"));
    if (match) return name.slice(match[0].length);
  }
  return name;
}

/**
 * The single model entry: the route pin first, then the model, then peak pricing. A pinned model shows the
 * pin glyph; while the pin is set but another model serves, the glyph becomes the warning-coloured fallback.
 */
export function modelEntryText(parts: { name: string; provider: string; providerLabel: string; pin?: "pinned" | "fallback"; blocked?: boolean; peak: boolean }): string {
  const pinGlyph = parts.pin === "pinned" ? PIN_GLYPH : parts.pin === "fallback" ? PIN_FALLBACK_GLYPH : undefined;
  const pin = pinGlyph === undefined ? undefined : parts.blocked ? ANSI_ERROR(pinGlyph) : parts.pin === "fallback" ? ANSI_WARNING(pinGlyph) : pinGlyph;
  const model = stripProviderPrefix(parts.name, parts.providerLabel, parts.provider);
  const shownModel = parts.blocked ? ANSI_ERROR(model) : model;
  const peak = parts.peak ? ANSI_WARNING(PEAK_GLYPH) : undefined;
  return [pin, shownModel, peak].filter((part): part is string => part !== undefined && part !== "").join(" ");
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

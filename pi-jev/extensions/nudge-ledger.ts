/*
 * The nudge ledger: what has already been said, and how often.
 *
 * The audit of four days found 52 delivered nudges and, inside them, two tight
 * bursts — five scope nudges in 56 seconds while an agent retried the same call,
 * three identical policy warnings in 69 seconds. Each was individually right and
 * collectively noise: the fifth sentence teaches the agent that the channel
 * repeats itself, which is how a nudge stream stops being read at all. pi-warden
 * reached the same conclusion from the other end, holding only ~3 calls per 1000.
 *
 * So a finding is not "violated, therefore sent". It is counted, and the count
 * decides the sentence:
 *
 *   - the first occurrence of a finding is delivered as written;
 *   - a repeat inside the cooldown is recorded and stays quiet — the agent is
 *     still working on the same thing, and it has already been told;
 *   - a repeat *after* the cooldown is delivered as an accumulated reminder:
 *     "3rd time this session", followed by the same sentence and the calls that
 *     contributed to it. Repeating a finding that was ignored is a reminder;
 *     repeating it verbatim is nagging.
 *
 * The cooldown doubles per delivery to a cap, so a habit the agent is not
 * changing is mentioned at 1 minute, 2, 4, 8 — rarer each time, never never.
 * Refs are what make the accumulated sentence checkable: they are the subject
 * ids of the calls that produced the finding, so the agent (and the log) can
 * see which calls are being counted rather than take the count on trust.
 *
 * Nothing here decides anything: a suppressed nudge changes no band, no verdict,
 * and no record. It only decides whether a sentence is worth saying again.
 */

import type { Nudge } from "./consumers.js";

export interface LedgerEntry {
	/** Times this finding has occurred, delivered or not. */
	count: number;
	/** Times it has been said out loud. */
	delivered: number;
	/** Clock reading when it was last said. */
	lastAt: number;
	/** How long to stay quiet after the last delivery; doubles per delivery. */
	cooldownMs: number;
	/** Subjects that produced it, newest last, bounded. */
	refs: string[];
}

export interface NudgeLedger {
	/** What to deliver now: the first occurrence, and reminders that are due. */
	admit(nudges: readonly Nudge[], ref?: string | null): Nudge[];
	/** The counts behind the decisions, for tests and diagnostics. */
	entry(nudge: Pick<Nudge, "source" | "finding">): LedgerEntry | undefined;
}

export interface LedgerOptions {
	/** Clock, injected by tests. */
	now?: () => number;
	/** Time before the same finding may be said again. 0 disables the ledger. */
	cooldownMs?: number;
	/** Ceiling the doubling cooldowns approach. */
	maxCooldownMs?: number;
	/** How many contributing subjects a reminder names. */
	maxRefs?: number;
}

export const DEFAULT_NUDGE_COOLDOWN_MS = 60_000;
export const MAX_NUDGE_COOLDOWN_MS = 15 * 60_000;
export const DEFAULT_MAX_REFS = 3;

const PREFIX = /^pi-jev:\s*/i;

/** "2nd", "3rd", "11th" — the count as it reads in a sentence. */
export function ordinal(count: number): string {
	const tens = count % 100;
	if (tens >= 11 && tens <= 13) return `${count}th`;
	switch (count % 10) {
		case 1:
			return `${count}st`;
		case 2:
			return `${count}nd`;
		case 3:
			return `${count}rd`;
		default:
			return `${count}th`;
	}
}

/**
 * The same finding, said again: the count first, because that is the new
 * information, then the sentence the judge wrote, then the calls behind it.
 */
export function accumulatedText(base: string, count: number, refs: readonly string[], max = 500): string {
	const body = base.replace(PREFIX, "").trim();
	const named = refs.length > 0 ? ` Earlier this session: ${refs.join(", ")}.` : "";
	const text = `pi-jev: ${ordinal(count)} time this session. ${body}${named}`;
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * The key one finding is counted under. The question id alone is not enough:
 * `tool.fit` carries both the pack's verdict on the tool and the policy's own
 * warning about it, and those are separate complaints — collapsing them would
 * let the first swallow the second.
 */
export function findingKey(nudge: Pick<Nudge, "source" | "finding">): string {
	return `${nudge.source}\u0000${nudge.finding ?? ""}`;
}

export function createNudgeLedger(options: LedgerOptions = {}): NudgeLedger {
	const now = options.now ?? (() => Date.now());
	const cooldown = options.cooldownMs ?? DEFAULT_NUDGE_COOLDOWN_MS;
	const maxCooldown = options.maxCooldownMs ?? MAX_NUDGE_COOLDOWN_MS;
	const maxRefs = options.maxRefs ?? DEFAULT_MAX_REFS;
	const entries = new Map<string, LedgerEntry>();

	return {
		entry: (nudge) => entries.get(findingKey(nudge)),
		admit(nudges, ref = null) {
			// 0 disables the ledger entirely: every finding is said as written, as
			// it was before this existed. An operator who wants the old behaviour
			// gets it from one number rather than from a code path.
			if (cooldown <= 0) return [...nudges];
			const admitted: Nudge[] = [];
			const at = now();
			for (const nudge of nudges) {
				const key = findingKey(nudge);
				let entry = entries.get(key);
				if (!entry) {
					entry = { count: 0, delivered: 0, lastAt: Number.NEGATIVE_INFINITY, cooldownMs: cooldown, refs: [] };
					entries.set(key, entry);
				}
				entry.count += 1;
				if (typeof ref === "string" && ref !== "") {
					entry.refs.push(ref);
					if (entry.refs.length > maxRefs) entry.refs.shift();
				}
				if (entry.delivered > 0 && at - entry.lastAt < entry.cooldownMs) continue;
				const text = entry.delivered === 0 ? nudge.text : accumulatedText(nudge.text, entry.count, entry.refs.slice(0, -1));
				admitted.push({ ...nudge, text });
				entry.delivered += 1;
				entry.lastAt = at;
				entry.cooldownMs = Math.min(cooldown * 2 ** (entry.delivered - 1), maxCooldown);
			}
			return admitted;
		},
	};
}

/**
 * One ledger per session, held against the session's decision core.
 *
 * A WeakMap rather than a Map keyed by id on purpose: the core is the session's
 * own object and is dropped when its last lease releases, so the counts go with
 * it and nothing has to remember to clean up. A delivery that happens outside a
 * session (a notice before the core exists) shares one fallback ledger.
 */
const ledgers = new WeakMap<object, NudgeLedger>();

/** No session to count against: a notice before the core exists is said as written. */
const passThrough: NudgeLedger = { admit: (nudges) => [...nudges], entry: () => undefined };

export function ledgerFor(scope: object | undefined | null, options: LedgerOptions = {}): NudgeLedger {
	if (!scope) return passThrough;
	const existing = ledgers.get(scope);
	if (existing) return existing;
	const created = createNudgeLedger(options);
	ledgers.set(scope, created);
	return created;
}

import type { RoutingContext, RoutingStrategy } from "@vanillagreen/pi-native-router/strategy";

type Target = RoutingContext["targets"][number];
function quotaNearReset(target: Target, context: RoutingContext, horizonMinutes: number): boolean {
  const quota = target.quota;
  if (quota.status !== "fresh" || !quota.authoritative || quota.windows.length === 0) return false;
  // Any already-exhausted meter makes the account a poor near-reset preference.
  if (quota.windows.some(window => window.usedPercent >= 100)) return false;
  return quota.windows.some(window => window.resetsAt !== undefined && window.resetsAt > context.now &&
    window.resetsAt - context.now <= horizonMinutes * 60_000 && window.usedPercent <= 70);
}

const strategy: RoutingStrategy = {
  version: 1,
  choose(context) {
    const eligible = new Set(context.eligibleTargetIds);
    const targets = context.targets.filter(target => eligible.has(target.targetId));
    if (targets.length === 0) throw new Error("no eligible target");
    const horizon = context.options.resetHorizonMinutes;
    const horizonMinutes = typeof horizon === "number" && Number.isFinite(horizon) && horizon >= 0 ? horizon : 120;
    // Policy order: useful fresh quota near reset, then avoid active peak pricing, then incumbent, then configured order.
    const order = new Map(context.route.configuredOrder.map((id, index) => [id, index]));
    const tieBreak = (choices: readonly Target[]) => choices.find(target => target.targetId === context.currentTargetId) ??
      [...choices].sort((a, b) => (order.get(a.targetId) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.targetId) ?? Number.MAX_SAFE_INTEGER))[0];
    const quota = tieBreak(targets.filter(target => quotaNearReset(target, context, horizonMinutes)));
    if (quota) return { targetId: quota.targetId, reason: `fresh authoritative quota resets within ${horizonMinutes}m with at least 30% remaining` };
    const offPeak = tieBreak(targets.filter(target => !target.peak.active));
    if (offPeak) return { targetId: offPeak.targetId, reason: "avoid a target in its published peak window" };
    const incumbent = targets.find(target => target.targetId === context.currentTargetId);
    if (incumbent) return { targetId: incumbent.targetId, reason: "keep current target when eligible preferences tie" };
    return { targetId: tieBreak(targets)!.targetId, reason: "configured order tie-break" };
  },
};

export default strategy;

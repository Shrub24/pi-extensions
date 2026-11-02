import { createRadarAttention, type RadarActivity } from "pi-radar/attention";
import { systemScheduler, type RadarClient, type RadarScheduler } from "pi-radar/client";
import type { RadarMessageConsumer } from "pi-radar/communication";
import type { RadarRuntimeServices } from "pi-radar/runtime";

/** One recipient loop, sharing the baseline's mailbox and accepted facts hints. */
export function startRadarInbox(options: {
  services: RadarRuntimeServices;
  client: Pick<RadarClient, "watchAttention">;
  activity(): RadarActivity;
  capture: RadarMessageConsumer["capture"];
  /** Why the mailbox stopped draining, or `undefined` once it drains again. */
  onDiagnostic(problem: string | undefined): void;
  scheduler?: RadarScheduler;
}) {
  let active = true;
  const { services } = options;
  const loop = createRadarAttention({
    mailbox: services.communication,
    consumers: [{ kind: "handoff", capture: (message) => active && options.capture(message) }],
    scheduler: options.scheduler ?? systemScheduler,
    activity: options.activity,
    // A drain that keeps failing stops every later message behind it. Radar reports
    // the reason whenever it changes; silence here would leave a stuck mailbox
    // looking like an idle one.
    onDiagnostic: (problem) => {
      if (active) options.onDiagnostic(problem);
    },
    // Herdsman opts into push while working or waiting; the SDK owns idle hold,
    // opener deadlines and reconnects. The subscription carries no payloads.
    watch: async (onAttention, onEnd) => {
      const subject = await services.publication.subject();
      if (!active || subject === undefined)
        return { ok: false, code: "absent", message: "No current Radar mailbox" };
      return options.client.watchAttention({
        registration_id: subject.registration_id, onAttention, onEnd,
      });
    },
  });
  const unsubscribe = services.publication.facts.onAttention((hint) => loop.hint(hint));
  loop.drain();
  return {
    activity: () => loop.activity(),
    stop() {
      active = false;
      unsubscribe();
      loop.stop();
    },
  };
}

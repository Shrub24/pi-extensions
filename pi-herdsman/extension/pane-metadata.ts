import { stripVTControlCharacters } from "node:util";

export const METADATA_TTL_MS = 3_600_000;
export const OWNER_METADATA_TTL_MS = 30_000;
export type MetadataTokens = Record<string, string | null>;
export type PaneMetadata = {
  paneId: string;
  source: string;
  tokens: MetadataTokens;
  title?: string;
  displayAgent?: string;
};

// Formatting follows narumiruna/pi-extensions packages/pi-herdr (MIT).
export function metadataValue(value: string | undefined | null): string | null {
  if (!value) return null;
  const clean = stripVTControlCharacters(value)
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .trim();
  return clean ? [...clean].slice(0, 80).join("") : null;
}

export function sessionMetadata(inputs: {
  model?: string;
  provider?: string;
  thinking?: string;
  name?: string;
  sessionId: string;
  contextPercent?: number;
}): MetadataTokens {
  const percent = inputs.contextPercent;
  return {
    model: metadataValue(inputs.model),
    provider: metadataValue(inputs.provider),
    thinking: metadataValue(inputs.thinking),
    session: metadataValue(inputs.name),
    context_usage:
      percent !== undefined && Number.isFinite(percent) && percent >= 0
        ? `${Math.round(percent)}%`
        : null,
    pi_herdsman_session: metadataValue(inputs.sessionId),
  };
}

export function metadataArgs(snapshot: PaneMetadata, ttlMs: number): string[] {
  const args = [
    "pane",
    "report-metadata",
    snapshot.paneId,
    "--source",
    snapshot.source,
    "--ttl-ms",
    String(ttlMs),
  ];
  if (snapshot.title !== undefined)
    args.push("--title", metadataValue(snapshot.title) ?? "");
  if (snapshot.displayAgent !== undefined)
    args.push("--display-agent", snapshot.displayAgent);
  for (const [key, value] of Object.entries(snapshot.tokens)) {
    const normalized = metadataValue(value);
    args.push(
      normalized === null ? "--clear-token" : "--token",
      normalized === null ? key : `${key}=${normalized}`,
    );
  }
  return args;
}

/** One latest snapshot per source; an outage is retried by the next update or refresh. */
export function createMetadataPublisher(
  send: (args: string[], signal: AbortSignal) => Promise<unknown>,
  ttlMs = METADATA_TTL_MS,
) {
  let desired: PaneMetadata | undefined;
  let published: string | undefined;
  let active: Promise<void> | undefined;
  let dirty = false;
  let closed = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const controller = new AbortController();
  const flush = (): Promise<void> => {
    if (active) return active;
    active = (async () => {
      while (dirty && desired && !closed) {
        dirty = false;
        const attempted = desired;
        try {
          await send(metadataArgs(attempted, ttlMs), controller.signal);
          published = JSON.stringify(attempted);
        } catch {
          // Publication cannot fail the session or delegation.
          if (attempted === desired) break;
        }
      }
    })().finally(() => {
      active = undefined;
      if (dirty && !closed) return flush();
    });
    return active;
  };
  return {
    update(snapshot: PaneMetadata): Promise<void> {
      if (closed) return Promise.resolve();
      desired = { ...snapshot, tokens: { ...snapshot.tokens } };
      if (!timer) {
        timer = setInterval(() => {
          dirty = true;
          void flush();
        }, ttlMs / 2);
        timer.unref();
      }
      // An in-flight snapshot may overwrite even a return to the published value.
      if (active || JSON.stringify(desired) !== published) {
        dirty = true;
        return flush();
      }
      return active ?? Promise.resolve();
    },
    async clear(): Promise<void> {
      if (closed) return;
      closed = true;
      if (timer) clearInterval(timer);
      controller.abort();
      await active;
      if (!desired) return;
      const tokens = Object.fromEntries(
        Object.keys(desired.tokens).map((key) => [key, null]),
      );
      const args = metadataArgs(
        { ...desired, title: undefined, displayAgent: undefined, tokens },
        ttlMs,
      );
      if (desired.title !== undefined) args.push("--clear-title");
      if (desired.displayAgent !== undefined)
        args.push("--clear-display-agent");
      try {
        await send(args, new AbortController().signal);
      } catch {
        /* TTL bounds a failed clear. */
      }
    },
  };
}

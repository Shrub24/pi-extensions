import { createMetadataPublisher, metadataValue } from "./pane-metadata.ts";

/**
 * The awaited set needs its own report: Herdr applies `--ttl-ms` per updated
 * key, so this short-lived fact cannot ride along in the pane's one-hour
 * report without expiring between its 30-minute refreshes.
 */
export const AWAITED_METADATA_TTL_MS = 30_000;
export const AWAITED_SOURCE = "pi-herdsman:awaited";
export const AWAITED_TOKEN = "pi_herdsman_awaited";
export const MAX_AWAITED_ENTRIES = 8;

/** Display value for the awaited set, or null when nothing is awaited. */
export function awaitedTokenValue(entries: readonly string[]): string | null {
  return metadataValue(entries.slice(0, MAX_AWAITED_ENTRIES).join(", "));
}

/**
 * Publishes one pane's awaited set in a short-lived source slot. The publisher
 * is created with the first non-empty set and dropped with the last, so a pane
 * awaiting nothing runs no timer, and its clear names only this key.
 */
export function createAwaitedFacts(options: {
  paneId: string;
  send: (args: string[], signal: AbortSignal) => Promise<unknown>;
  ttlMs?: number;
}) {
  let publisher: ReturnType<typeof createMetadataPublisher> | undefined;
  let closing: Promise<void> | undefined;
  let closed = false;
  // A set that arrives while the clear is in flight is authoritative later, so
  // the clear republishes it instead of letting a detached write race the clear.
  let queued: readonly string[] | undefined;

  const publish = (entries: readonly string[]): void => {
    const value = awaitedTokenValue(entries);
    if (value === null) {
      const current = publisher;
      if (!current) return;
      publisher = undefined;
      closing = current.clear().then(() => {
        closing = undefined;
        const next = queued;
        queued = undefined;
        if (next) publish(next);
      });
      return;
    }
    if (closing) {
      queued = entries;
      return;
    }
    publisher ??= createMetadataPublisher(
      options.send,
      options.ttlMs ?? AWAITED_METADATA_TTL_MS,
    );
    void publisher.update({
      paneId: options.paneId,
      source: AWAITED_SOURCE,
      tokens: { [AWAITED_TOKEN]: value },
    });
  };

  return {
    refresh(entries: readonly string[]): void {
      if (!closed) publish(entries);
    },
    /** Stops publishing and clears this key; later refreshes are ignored. */
    async clear(): Promise<void> {
      closed = true;
      queued = undefined;
      const current = publisher;
      publisher = undefined;
      await current?.clear();
      await closing;
    },
  };
}

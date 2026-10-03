# Publish pane facts without owning sidebar presentation

Status: accepted

The official Herdr Pi integration owns semantic state and session reporting. Herdsman absorbs pi-herdr's session metadata and publishes delegation facts under its own sources. pi-herdr is retired, not forked; Herdsman's widget stays intact.

Workers remain Herdr agents. Each advertises its exact session and direct owner session. The owner separately advertises its public worker projection with a short TTL, including loss that a dead worker cannot report. No parent-held child lists or pre-rendered rows are needed.

Herdr-radar owns ordering, grouping and rendering. Herdsman neither writes nor clears Radar's tokens. The [contract](../reference/pane-metadata.md) and fixture define the seam. A sidebar can change its presentation without changing delegation or state authority.

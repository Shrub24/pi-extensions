# Changelog

All notable changes to \`pi-reqcap\` will be documented in this file.

## [0.1.0]

First release, extracted from the scratch harness that diagnosed the October 2026
cache re-bills (10.4M tokens re-billed in one session, ~$1.2 per event).

### Changed from the scratch harness

- Reads Pi's events instead of wrapping \`globalThis.fetch\` and parsing provider
  streams by hand: \`before_provider_request\` for the payload,
  \`provider_stream_event\` for usage and input transformations, and
  \`after_provider_response\` for status and rate-limit headers. Wrapping fetch
  collided with extensions that shape requests, and the hand-rolled SSE parsing
  guessed at provider-specific usage shapes.
- \`requests.jsonl\` rotates at a size budget instead of growing without bound.
- Payload capture has an off switch (\`PI_REQCAP_BODIES=0\`) and a smaller cap.
- Records Pi's own cause events (compaction, MCP server change, model and thinking
  level change, cache-warming decision) alongside the divergence they explain.

# Changelog

All notable changes to `pi-reqcap` will be documented in this file.

## [Unreleased]

### Added

- A warning toast and a footer status on a re-bill above `PI_REQCAP_NOTICE_MIN_TOKENS`
  (default 20,000 re-billed tokens). Each one also writes its prefix comparison to
  `traces/`, so the evidence outlives the toast.
- Commands: `/reqcap` (session overview), `/reqcap all`, `/reqcap trace [n]`,
  `/reqcap diff [seq]` (full prefix comparison), `/reqcap where`, `/reqcap help`.

### Fixed

- OpenAI-shaped usage (`prompt_tokens` inclusive of `cached_tokens`) was recorded as
  `input + cached`, doubling the prompt size reported for gateway providers.
- Re-bill detection no longer fires on a provider that simply never caches the whole
  prefix: the cached prefix now has to collapse (to half the previous read or less)
  while the prompt holds or grows, or the provider has to charge a cache write.

## [0.1.0]

First release, extracted from the scratch harness that diagnosed the October 2026
cache re-bills (10.4M tokens re-billed in one session, ~$1.2 per event).

### Changed from the scratch harness

- Reads Pi's events instead of wrapping `globalThis.fetch` and parsing provider
  streams by hand: `before_provider_request` for the payload,
  `provider_stream_event` for usage and input transformations, and
  `after_provider_response` for status and rate-limit headers. Wrapping fetch
  collided with extensions that shape requests, and the hand-rolled SSE parsing
  guessed at provider-specific usage shapes.
- `requests.jsonl` rotates at a size budget instead of growing without bound.
- Payload capture has an off switch (`PI_REQCAP_BODIES=0`) and a smaller cap.
- Records Pi's own cause events (compaction, MCP server change, model and thinking
  level change, cache-warming decision) alongside the divergence they explain.

## 1. Combined view
- [x] 1.1 Capture actual nested execution results by root and call ID, with bounded persisted display records and cleanup.
- [x] 1.2 Render combined rows, bounded output, failures and source expansion through the resolver seam.
- [x] 1.3 Reuse the existing edit diff renderer at the actual available width and retain resume behaviour.

## 2. Validation
- [x] 2.1 Exercise parallel isolation, failures, streaming, resume, storage limits and unmodified model-facing results through the event/resolver boundary.
- [x] 2.2 Check rendered widths and the full renderer suite; bundle and validate OpenSpec.
- [x] 2.3 Document presentation, display storage limits and fallback behaviour.

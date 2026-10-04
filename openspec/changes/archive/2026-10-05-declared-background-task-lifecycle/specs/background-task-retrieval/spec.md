# Background task retrieval

## Purpose

Make background shell work observable through session-scoped task handles, declared result retrieval, review reminders, and explicit cancellation, without inferring reads of live log files.

## ADDED Requirements

### Requirement: Dispatch returns a task handle without exposing a live log

The system SHALL preserve ordinary foreground command completion, automatic background yield after the configured foreground window, and explicit background dispatch. Yield and dispatch SHALL return a task ID, running metadata, and a bounded preview without advertising a mutable live log path. The foreground window MUST NOT become a task termination deadline.

#### Scenario: A command outlives the foreground window
- **WHEN** a managed command is still running when the foreground window ends
- **THEN** execution SHALL continue under the task manager and the response SHALL return its ID, elapsed time, review/hard deadlines when configured, and bounded preview
- **AND** the response SHALL recommend independent work or ending the response to await a wake, not polling

#### Scenario: A command finishes before yield
- **WHEN** a command finishes and its output flushes within the foreground window
- **THEN** the normal bash response SHALL deliver its outcome and bounded output, preserving complete output through an artifact when truncated
- **AND** no duplicate background completion wake SHALL be owed

### Requirement: Task handles are scoped to the owning session

Retrieval and mutation SHALL resolve handles within the owning session and SHALL reject an unknown or foreign-session handle without acknowledging or cancelling another session's work. IDs MUST NOT be inferred from a live file path.

#### Scenario: Two sessions have similarly numbered tasks
- **WHEN** one session retrieves or stops a handle belonging only to another session
- **THEN** the operation SHALL fail explicitly without revealing that task's output or changing its lifecycle

### Requirement: Running retrieval is a nonblocking progress review

A running `get` SHALL return command, task ID, elapsed time, state, configured deadlines, bounded output, and whether captured output changed since the previous review. A successful running retrieval SHALL reset the soft review interval without acknowledging completion or changing the absolute hard deadline. Failed retrieval SHALL NOT count as review.

#### Scenario: Inspecting active work
- **WHEN** a task remains active at the retrieval's observation point
- **THEN** `get` SHALL return progress promptly without waiting for process completion
- **AND** its eventual completion wake SHALL remain enabled

#### Scenario: Inspecting unchanged output
- **WHEN** successive deliberate retrievals observe unchanged output
- **THEN** the response SHALL say so and remind the caller that completion notification remains enabled
- **AND** each successful deliberate running retrieval SHALL reset the soft interval without imposing a polling loop or arbitrary retrieval rate limit

### Requirement: Terminal readiness includes flushed output

A terminal result SHALL be ready only after process lifecycle completion and output flush. A `get` racing with completion SHALL return either a running/finalizing observation without final acknowledgment, or a complete terminal result; it MUST NOT report a terminal result whose output is still being appended.

#### Scenario: Process exit precedes the last log flush
- **WHEN** the process has exited but output persistence is still settling
- **THEN** retrieval SHALL identify finalization as incomplete and SHALL NOT acknowledge final completion
- **AND** a subsequent terminal retrieval SHALL include the final flushed output

### Requirement: Terminal retrieval acknowledges notifications, not data

A successful terminal `get` SHALL deliver outcome, exit/termination details, and output, then durably acknowledge the completion notification obligation. Acknowledgment SHALL be idempotent and SHALL NOT delete retained output or invalidate the task handle. A failed output handoff SHALL NOT silently acknowledge completion.

#### Scenario: Repeated final retrieval
- **WHEN** the caller retrieves a completed result twice within its retention lifetime
- **THEN** both retrievals SHALL remain usable
- **AND** no additional completion notification SHALL be created by either retrieval

### Requirement: Full output uses ordinary stdout and stable artifacts

On supported POSIX hosts, `pi-bg get ID --output` SHALL emit the complete captured combined output snapshot to stdout and retrieval metadata to stderr. New Windows CLI support is out of scope; Pi-tool get/stop/list SHALL retain their existing platform support. While running, that snapshot SHALL be clearly identified as partial in metadata and SHALL NOT later mutate. For tool delivery, an oversized response SHALL preserve the complete snapshot in an immutable readable artifact before upstream truncation, with an explicit reference in the bounded response. No custom output-destination argument SHALL be required.

#### Scenario: Shell redirection and filtering
- **WHEN** the caller executes `pi-bg get ID --output > file` or pipes stdout into a filter
- **THEN** redirection/filtering SHALL operate on the complete snapshot rather than a previously truncated preview
- **AND** the redirected output SHALL exclude retrieval metadata

#### Scenario: Output exceeds all inline limits
- **WHEN** captured output exceeds the managed-bash and tool-output-policy inline limits
- **THEN** any advertised full-output artifact SHALL contain the complete captured snapshot, not merely the tail that survived an earlier truncation

#### Scenario: Preview and full retrieval acknowledge the same final result
- **WHEN** either preview or full-output retrieval completes its requested stdout write/stream successfully and the manager accepts its internal success receipt
- **THEN** the same completion acknowledgment semantics SHALL apply without claiming that a downstream consumer read every byte
- **AND** later full retrieval SHALL remain available within retention

#### Scenario: A pipe closes before output handoff completes
- **WHEN** `pi-bg get ID --output | head` or another consumer closes early and the CLI detects EPIPE before completing the requested output handoff
- **THEN** the CLI SHALL NOT send a success receipt or acknowledge completion
- **AND** retained output SHALL remain retrievable and the existing completion obligation SHALL remain outstanding

#### Scenario: Output preparation or delivery fails
- **WHEN** snapshot preparation, opening or writing output, or transport before receipt acceptance fails
- **THEN** retrieval SHALL report a management failure without silently acknowledging completion or resetting a running review clock
- **AND** receipt retries after an ambiguous accepted-receipt response SHALL be idempotent, returning the committed result for accepted tokens throughout the owning task's retained lifetime rather than treating them as abandoned unaccepted preparations
- **AND** once that task is pruned, retry SHALL report explicit task expiry without implying its acknowledgment was reversed

#### Scenario: A short stream completes before the consumer closes
- **WHEN** the requested write finishes without detected error and its receipt is accepted before a downstream consumer closes
- **THEN** retrieval SHALL count as a successful handoff without requiring proof of downstream byte consumption

### Requirement: Both streams are captured without rewriting shell commands

The system SHALL continue capturing stdout and stderr into its combined output log without requiring or injecting shell `2>&1` redirection. User-authored command redirections SHALL retain their ordinary shell semantics. Stream identity and exact global ordering between independent stdout/stderr pipes SHALL NOT be claimed.

#### Scenario: A command writes to both streams
- **WHEN** a command writes to stdout and stderr without explicit redirection
- **THEN** the task output SHALL contain captured data from both streams

#### Scenario: A command redirects its own output elsewhere
- **WHEN** a command redirects a stream into another file
- **THEN** that stream SHALL follow the shell redirection and SHALL NOT be represented as data captured by the manager

### Requirement: Stop delivers a result and preserves retrieval

`stop` SHALL request termination of owned process work and return the task ID, actual state/outcome, termination details, and retained output using the terminal retrieval contract when termination is confirmed. It SHALL wait only for the bounded termination/finalization procedure, not the original task timeout. Signal dispatch alone MUST NOT be represented as confirmed termination. A nonterminal or failed stop SHALL retain the eventual completion obligation.

#### Scenario: Confirmed stop
- **WHEN** termination and output flush succeed
- **THEN** the stop response SHALL deliver and acknowledge the final result without requiring a subsequent `get`
- **AND** `get` and full-output retrieval SHALL remain available under the same ID

#### Scenario: Natural completion wins the race
- **WHEN** the task finishes normally before the stop takes effect
- **THEN** stop SHALL return the real completed outcome without changing it to cancelled

#### Scenario: Termination cannot be confirmed
- **WHEN** signaling fails or the bounded stop procedure ends while the process is still active or output is not ready
- **THEN** stop SHALL report the unresolved state explicitly
- **AND** it SHALL NOT falsely acknowledge a complete result, delete output, or clear ownership

### Requirement: Inventory is observational

`list` SHALL return compact task metadata without acknowledging terminal results, resetting review intervals, or exposing mutable live logs. Repeated inventory checks SHALL NOT postpone reminders or completion delivery.

#### Scenario: Listing a completed and a running task
- **WHEN** the caller lists tasks
- **THEN** neither task's notification or review state SHALL change merely because its metadata was listed

### Requirement: Progress reminders are review based and coalesced

A configured soft interval SHALL schedule a progress-review wake based on the most recent successful running retrieval or delivered progress review. A progress wake SHALL include task ID, command, elapsed time, deadlines, output preview, and changed/unchanged indication. At most one extension-held progress wake per task SHALL be pending. Output activity SHALL NOT reset the interval. Successful inspection SHALL invalidate stale extension-held reminders.

#### Scenario: Output chatter continues without review
- **WHEN** a running task keeps producing output past its review interval
- **THEN** a progress review SHALL still be due
- **AND** the hard deadline SHALL remain unchanged

#### Scenario: Review occurs before a deferred reminder is dispatched
- **WHEN** a reminder is held during an active turn and a running `get` succeeds
- **THEN** the stale held reminder SHALL be cancelled and the next interval SHALL start at that review

#### Scenario: A progress review is delivered
- **WHEN** a valid reminder is handed to the host
- **THEN** the next configured review interval SHALL be armed
- **AND** a task that has become terminal SHALL receive completion handling instead of a stale running reminder

#### Scenario: The caller re-arms a running review interval
- **WHEN** a running task's progress review is delivered and the caller re-arms it with a different soft interval
- **THEN** the next reminder SHALL be measured from that re-arm using the new interval, without stopping the process
- **AND** the absolute hard deadline SHALL be unchanged, and `0` SHALL disable further reminders for that task

### Requirement: Hard deadlines remain absolute

The existing `defaultTimeoutSeconds` process timeout and per-task `timeoutSeconds` override SHALL define the absolute hard process-lifetime ceiling; `defaultSoftTimeoutMs` SHALL remain the separate progress-review interval, not a process ceiling. A configured hard timeout SHALL remain an absolute process-lifetime ceiling. Foreground yield, retrieval, listing, output activity, progress reminders, or any legacy soft-reset compatibility path SHALL NOT extend it. A task without a configured hard limit SHALL NOT acquire an invented deadline through retrieval.

#### Scenario: Repeated inspections approach the hard limit
- **WHEN** successful running retrievals keep resetting the review interval
- **THEN** the original hard limit SHALL still terminate the task when reached and produce its actual terminal outcome

### Requirement: Completion delivery is reconciled and recoverable

The system SHALL reconcile terminal retrieval, stop, normal completion, and restore using one per-task completion notification obligation. A terminal get/stop SHALL cancel any completion notification still held by the extension. Submission of a completion notification to Pi SHALL fulfill that obligation and SHALL be recorded for recovery. Restoring an acknowledged task SHALL NOT generate a fresh completion wake. Raw file reads SHALL NOT alter acknowledgment.

#### Scenario: Completion is deferred during a tool turn
- **WHEN** a task completes during a turn and terminal `get` delivers its result before the deferred wake is dispatched
- **THEN** the held completion wake SHALL be suppressed

#### Scenario: An acknowledged task is restored
- **WHEN** a snapshot with acknowledged completion is restored
- **THEN** no duplicate completion wake SHALL be scheduled and retained output SHALL remain accessible

#### Scenario: Crash interrupts the host submission boundary
- **WHEN** the process crashes between host submission and recording delivery
- **THEN** recovery SHALL follow the documented at-least-once policy for that ambiguous boundary
- **AND** the implementation SHALL NOT claim transactional exactly-once delivery across Pi and its own persistence

### Requirement: Host queue limitations do not erase unrelated messages

On Pi 0.99.2, the system SHALL NOT clear/reconstruct whole steering or follow-up queues to cancel one task wake, mutate private Pi queues, or claim selective cancellation that the public API does not provide. Messages already handed to Pi SHALL carry task identity and be recognizable as stale after retrieval. Removing an already-dispatched wake or undoing a model request is outside this change.

#### Scenario: Retrieval races with a custom message queued in Pi
- **WHEN** a completion wake has already been submitted and retrieval later acknowledges the task
- **THEN** the result SHALL be delivered normally and the implementation SHALL not delete unrelated user/extension messages
- **AND** the remaining possible stale wake SHALL be documented, not concealed as a guarantee of retraction

### Requirement: Interactive waiting changes do not break deferred integrations

Ordinary interactive guidance and schema SHALL prefer spawn/get/stop/list/extend and ending the response for native wakes. `extend` SHALL only re-arm or disable a running task's soft progress-reminder interval; it SHALL NOT move a hard deadline. Existing child/headless/internal wait compatibility SHALL remain usable until the separate pending-work lifecycle bridge is verified. This change SHALL NOT modify pi-subagents lifetime management or remove codemode's existing foreground-only background-task safeguards.

#### Scenario: A legacy child needs a shell result before its session closes
- **WHEN** a current child/headless caller uses the retained bounded wait compatibility path
- **THEN** it SHALL still deliver or truthfully report the task state using the new acknowledgment rules
- **AND** the ordinary interactive instructions SHALL not recommend that legacy waiting strategy

#### Scenario: Shared installed guidance is used by a noninteractive child
- **WHEN** the effective prompt and tool schema are assembled for print, json, rpc, or unknown mode
- **THEN** retained bounded wait and required bg_status SHALL be callable and the mode-specific prompt SHALL explain the compatibility wait when the caller needs a pending shell result before returning
- **AND** shared append-system instructions SHALL NOT tell that caller to rely on push-only end-response waiting or name tools/actions absent from another receiving mode
- **AND** compatibility bg_status list/stop/log SHALL use the shared list/stop/get operations without live-log-path advertisements or a separate acknowledgment channel

#### Scenario: TUI guidance and tool schema are assembled
- **WHEN** the session mode is tui
- **THEN** the effective prompt SHALL recommend independent work followed by end-response waiting for native wakes and bg_task's schema SHALL expose only spawn/get/stop/list/extend
- **AND** bg_status SHALL NOT be registered in TUI, and neither bg_status nor bg_task action:"wait" SHALL be recommended by the TUI prompt
- **AND** the TUI `extend` action SHALL re-arm or disable the task's soft progress-reminder interval without changing the absolute hard deadline
- **AND** the installed shared block SHALL be mode-neutral, with mode-specific waiting instructions supplied through a supported per-session prompt contribution instead of rewriting a shared user instruction file

### Requirement: Retention protects active work and handed-off output

Task and artifact retention SHALL preserve active work and SHALL keep a stopped/completed task retrievable for the configured retained lifetime. Cleanup SHALL report expiration explicitly rather than silently substitute incomplete output. A handed-off artifact SHALL be independent from subsequent appends to the live log.

#### Scenario: A task or artifact has expired
- **WHEN** a caller retrieves a handle whose configured retention has expired
- **THEN** retrieval SHALL return an explicit missing/expired error without fabricating a successful empty result

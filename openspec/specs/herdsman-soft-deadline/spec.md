# herdsman-soft-deadline Specification

## Purpose
Give the controller that owns delegated work a regular, advisory checkpoint on long-running assignments, so it can keep waiting, steer, interrupt, extend, or close before drift, hangs, or a lapsed prompt cache cost it more.

## Requirements

### Requirement: Accepted assignments arm a soft window

When a worker acknowledges an assignment delivered through `agent_delegate` or `agent_continue`, the owning controller SHALL arm a soft window for that assignment. The window's length SHALL be the configured `softTimeoutMs` (default 300000 milliseconds). The window SHALL be measured from the worker's acceptance of the assignment. A `softTimeoutMs` of `0` SHALL disable soft windows entirely. The setting SHALL accept only integers from `0` through `2147483647`; any other value SHALL make the configuration invalid.

#### Scenario: Delegation arms a window

- **WHEN** a lead delegates an assignment and the worker acknowledges it, with `softTimeoutMs` unset
- **THEN** a 300000 ms soft window is armed for that assignment, measured from the acknowledgement

#### Scenario: Zero disables the deadline

- **WHEN** `softTimeoutMs` is `0` and an assignment is accepted
- **THEN** no soft window is armed and no soft-deadline digest is ever delivered for it

#### Scenario: Invalid value rejected

- **WHEN** the configuration file sets `softTimeoutMs` to `-1`, `1.5`, or `"300000"`
- **THEN** reading the configuration fails with an error naming `softTimeoutMs`

### Requirement: Expired windows are delivered as one digest to an idle owner

A soft window SHALL be due once its length has elapsed while its assignment is still unresolved. Due windows SHALL be checked on the existing health-reconciliation cadence, so delivery may lag expiry by up to one scan interval. When at least one window is due and the owning controller is idle, the controller SHALL receive exactly one soft-deadline digest covering every due window it owns. The digest SHALL wake the controller. Each entry SHALL name the worker, its definition, the assignment's elapsed time, and the controls that worker currently allows, taken from the same eligibility used for `agent_list`'s `available_tools`. The digest SHALL state that it is advisory, that no worker was aborted, steered, or closed, and that waiting is a valid response. A due window SHALL NOT be delivered while the controller is busy. It SHALL be included in the next digest delivered after the controller becomes idle. Soft-deadline delivery SHALL NOT prevent, delay, or replace any other health attention, and other health attention SHALL NOT suppress a due digest.

#### Scenario: Two overdue workers, one wake

- **WHEN** two workers owned by the same idle lead pass their windows before the same scan
- **THEN** the lead receives one digest containing both workers, each with its elapsed time and current controls

#### Scenario: Busy owner defers delivery

- **WHEN** a window is due while the lead is mid-turn
- **THEN** nothing is delivered during the turn, and the window appears in the first digest after the lead becomes idle

#### Scenario: Controls reflect current eligibility

- **WHEN** an overdue worker has a pending owner question
- **THEN** its digest entry lists the reply control and does not offer interrupt

#### Scenario: Coexists with stale attention

- **WHEN** a worker is both stale and past its soft window in the same scan
- **THEN** the stale attention and the soft-deadline digest are both delivered

### Requirement: Windows re-arm after every digest

After a window has been included in a delivered digest, the owning controller SHALL immediately arm the next window for the same assignment. That window's length SHALL be `softTimeoutMs`, unless `agent_extend` set a different length for it. Windows SHALL stop when the assignment resolves: its result is delivered, the worker is closed, or the worker is proven lost. A resolved assignment SHALL NOT appear in any later digest.

#### Scenario: Periodic checkpoint

- **WHEN** a worker keeps working across three consecutive windows
- **THEN** the lead receives that worker in three digests, roughly one window apart

#### Scenario: Completion stops the windows

- **WHEN** a worker's result is delivered while its window is armed
- **THEN** that window is discarded and the worker appears in no later digest

### Requirement: `agent_extend` lengthens one worker's next window

The controller SHALL expose an `agent_extend` tool. It SHALL take the exact live agent identity and a window length in milliseconds (an integer from `1` through `2147483647`). It SHALL accept no other fields. On success it SHALL replace that worker's current window with a fresh window of the given length, measured from the call. Windows armed after that one SHALL use `softTimeoutMs` again. `agent_extend` SHALL appear in a worker's `available_tools` only while that worker is directly owned by the caller and has an armed soft window. Calling it for any other worker SHALL fail without changing any window. `agent_extend` SHALL NOT change the assignment, steer the worker, or create a result.

#### Scenario: Extend a long-running worker

- **WHEN** the lead calls `agent_extend` for a working worker with 1800000 ms
- **THEN** that worker is not included in a digest for the next 1800000 ms, and afterwards its windows return to `softTimeoutMs`

#### Scenario: Extend unavailable without a window

- **WHEN** `softTimeoutMs` is `0`, or the worker's assignment has resolved
- **THEN** `agent_extend` is absent from that worker's `available_tools`, and calling it fails with no effect

#### Scenario: Strict schema

- **WHEN** `agent_extend` is called with an extra field such as `task`
- **THEN** the call is rejected by schema validation

### Requirement: Soft windows survive controller restart

Armed windows, extensions, and the last delivered window SHALL be recorded durably by the owning controller in a form that does not enter model context. After the controller restarts, every unresolved assignment's window SHALL resume from its recorded state. A window that was delivered before the restart SHALL NOT be delivered again. A window that expired while the controller was down SHALL be due at the first scan after recovery.

#### Scenario: Restart mid-window

- **WHEN** the lead restarts 120000 ms into a 300000 ms window
- **THEN** the window expires about 180000 ms after recovery, not 300000 ms

#### Scenario: Restart after delivery

- **WHEN** the lead restarts just after a digest was delivered for a window
- **THEN** that window is not delivered again, and the next window continues from its recorded arming

### Requirement: Digest is published to other extensions before delivery

Before delivering a digest, the controller SHALL emit it on Pi's extension event bus under a documented channel name. The event payload SHALL carry the digest's entries and a mutable list of annotations. Annotations that listeners add synchronously SHALL be included in the delivered digest. A listener that throws SHALL NOT prevent delivery. When no listener is registered, delivery SHALL be unchanged.

#### Scenario: Listener annotates a digest

- **WHEN** an extension subscribed to the channel appends an annotation to a digest event
- **THEN** the delivered digest contains that annotation

#### Scenario: Failing listener

- **WHEN** a subscribed listener throws
- **THEN** the digest is still delivered without that listener's annotations

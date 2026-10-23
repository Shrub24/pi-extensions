# Spec Delta

## Purpose

Let the user choose a physical candidate for a route on the current session branch, without removing the route's fallbacks.

## ADDED Requirements

### Requirement: Branch-scoped physical pin

The router SHALL store a physical pin per route as a session branch entry. The last entry for a role on the branch SHALL decide the pin, and a pin SHALL NOT be shared across sessions or roles.

#### Scenario: Resume restores the pin
- **WHEN** a session with a pin is resumed or forked
- **THEN** the route uses the pin recorded on that branch

#### Scenario: Auto clears the pin
- **WHEN** the user selects `auto`
- **THEN** the route clears the manual pin and uses its configured automatic selection (route order when no custom strategy is configured) from the next request

### Requirement: User pin overrides stickiness once

A newly set physical pin or cycle choice SHALL override current-target stickiness and automatic selection once when the candidate fits and has available credentials. It MAY bypass a live health block for this single attempt, subject to shared probe leases and normal transition, activation and flush safeguards. A failed attempt SHALL retain the block and use normal fallback; a successful attempt SHALL clear only the causes it proved recovered. After the attempt, the dispatched target SHALL remain sticky while eligible; a still-stored pin SHALL be preferred when the incumbent becomes unavailable.

#### Scenario: New pin overrides a healthy incumbent once
- **WHEN** the user sets or cycles to an eligible candidate different from the current physical target
- **THEN** the next route resolution selects that candidate
- **AND** the override is consumed after selection
- **AND** later requests stay on the selected target while it remains eligible

#### Scenario: Stored pin does not reclaim a healthy fallback
- **WHEN** the pinned candidate becomes eligible again after failover, while the current fallback remains eligible
- **THEN** the router keeps the current fallback sticky
- **AND** the pin remains stored for when the incumbent becomes unavailable

#### Scenario: No eligible incumbent
- **WHEN** a pin is set and there is no eligible current physical target
- **THEN** the router tries the pinned candidate before configured route order

#### Scenario: Manual choice supersedes recovery preference
- **WHEN** the user sets a new pin while a recovery target is pending
- **THEN** the eligible pinned candidate is selected for the next resolution
- **AND** normal retry safety and dispatch safeguards still apply

### Requirement: Blocked pin one-shot bypass

A cooling or otherwise health-blocked candidate SHALL remain in configured-order pin cycling and picker lists. Choosing it SHALL perform one explicit attempt if it fits and has available credentials. Health SHALL block automatic selection after the attempt fails; a successful attempt SHALL clear the causes it proved recovered. A candidate that cannot fit or lacks credentials SHALL not bypass those checks.

#### Scenario: Blocked candidate selected by cycle
- **WHEN** the user cycles to a candidate with a live health block
- **THEN** the candidate remains selectable and is shown with a red blocked indicator
- **AND** the next request attempts it once

#### Scenario: Bypassed attempt fails
- **WHEN** the explicit attempt on the blocked candidate fails
- **THEN** the health block remains and normal routing falls back to another eligible candidate
- **AND** the pin remains stored and visibly marked blocked

#### Scenario: Bypassed attempt succeeds
- **WHEN** the explicit attempt on the blocked candidate succeeds
- **THEN** the proven health block is cleared
- **AND** the candidate's pin marker returns to its normal colour

#### Scenario: Pinned candidate too small or credentials unavailable
- **WHEN** the pinned candidate cannot fit or its credential is unavailable
- **THEN** the router does not bypass that constraint and uses normal fallback selection

### Requirement: Picker and argument command

`/route-pin` SHALL open a picker listing `auto` and the route's candidate labels when a UI is available. Given an argument, it SHALL set the pin to the matching candidate label or to `auto`, and SHALL reject any other argument.

#### Scenario: Picker
- **WHEN** the user runs `/route-pin` with a UI
- **THEN** a picker lists `auto` and each candidate label, and the chosen item becomes the pin

#### Scenario: Unknown label
- **WHEN** the user runs `/route-pin` with a label that is not a candidate of the route
- **THEN** the command rejects it and the pin is unchanged

### Requirement: Cycle hotkey

A configurable hotkey SHALL move the pin to the next configured candidate in route order after the one currently serving, wrapping at the end; cycling order is independent of custom automatic selection. Health-blocked candidates remain in the cycle and picker, visibly marked red. They are skipped by automatic routing but receive a one-shot explicit attempt when selected by the user.

#### Scenario: Cycle wraps
- **WHEN** the user presses the hotkey on the last candidate
- **THEN** the pin moves to the first configured candidate

#### Scenario: No configured candidate can be cycled
- **WHEN** no route candidate is registered with usable credentials
- **THEN** the pin is unchanged and the user is notified

### Requirement: Visible and logged state

The physical footer item SHALL show a pin mark while a pin is set, colour that glyph red while the pinned candidate has a live health block, and return it to normal colour when the block clears. Each manual change SHALL be logged with reason `manual`.

#### Scenario: Pin mark
- **WHEN** a pin is set
- **THEN** the physical item shows the pin mark, including when the pin is dormant

### Requirement: Pin preference notice

A manual change SHALL explain that an eligible new pin applies on the next request and that the selected target remains sticky afterward.

#### Scenario: Change notice
- **WHEN** the user changes the pin
- **THEN** the notification describes the one-shot override and subsequent stickiness

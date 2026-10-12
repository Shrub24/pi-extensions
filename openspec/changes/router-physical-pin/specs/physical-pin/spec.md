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
- **THEN** the route uses route order again from the next request

### Requirement: Pin as preference

The router SHALL try the pinned candidate first whenever it is eligible and fits the request. Recovery targets SHALL keep priority over the pin.

#### Scenario: Eligible pin
- **WHEN** a pin is set and the pinned candidate is eligible and fits the request
- **THEN** the router dispatches to the pinned candidate

#### Scenario: Recovery keeps priority
- **WHEN** a recovery target is pending and a pin is set
- **THEN** the recovery target is tried first

### Requirement: Dormant pin

When the pinned candidate cannot serve a request, the router SHALL use route order for that request and SHALL keep the pin.

#### Scenario: Pinned candidate in cooldown
- **WHEN** the pinned candidate is in cooldown
- **THEN** the request goes to the next eligible candidate in route order
- **AND** the pin is still set and applies again once the candidate is eligible

#### Scenario: Pinned candidate too small
- **WHEN** the pinned candidate cannot fit the request
- **THEN** the router skips it for that request only

### Requirement: Picker and argument command

`/route-pin` SHALL open a picker listing `auto` and the route's candidate labels when a UI is available. Given an argument, it SHALL set the pin to the matching candidate label or to `auto`, and SHALL reject any other argument.

#### Scenario: Picker
- **WHEN** the user runs `/route-pin` with a UI
- **THEN** a picker lists `auto` and each candidate label, and the chosen item becomes the pin

#### Scenario: Unknown label
- **WHEN** the user runs `/route-pin` with a label that is not a candidate of the route
- **THEN** the command rejects it and the pin is unchanged

### Requirement: Cycle hotkey

A configurable hotkey SHALL move the pin to the next eligible candidate in route order after the one currently serving, wrapping once. When no candidate is eligible, it SHALL notify and leave the pin unchanged.

#### Scenario: Cycle wraps
- **WHEN** the user presses the hotkey on the last candidate
- **THEN** the pin moves to the first eligible candidate

#### Scenario: Nothing eligible
- **WHEN** the user presses the hotkey and no candidate is eligible
- **THEN** the pin is unchanged and the user is notified

### Requirement: Visible and logged state

The physical footer item SHALL show a pin mark while a pin is set, and each manual change SHALL be logged with reason `manual`.

#### Scenario: Pin mark
- **WHEN** a pin is set
- **THEN** the physical item shows the pin mark, including when the pin is dormant

### Requirement: Cache notice

A manual change SHALL state that the route's cache rebuilds on the next request.

#### Scenario: Change notice
- **WHEN** the user changes the pin
- **THEN** the notification says the route's cache rebuilds on the next request

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

A newly set physical pin SHALL override the current target and automatic recovery preference for the next route resolution, if the pin is eligible. After that resolution, the dispatched physical target SHALL remain sticky while eligible; a still-stored pin SHALL be preferred when the incumbent becomes unavailable. An ineligible pin SHALL use the existing fallback selection and SHALL NOT bypass health, fit, transition, activation or flush safeguards.

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

### Requirement: Dormant pin

When the pinned candidate cannot serve a request, the router SHALL use the configured automatic selection for that request and SHALL keep the pin. Automatic selection uses route order when no custom strategy is configured. The pin becomes preferred again only when the incumbent is unavailable or there is no eligible incumbent.

#### Scenario: Pinned candidate in cooldown
- **WHEN** the pinned candidate is in cooldown while the current target remains eligible
- **THEN** the router stays with the current target
- **AND** the pin remains stored but does not displace that target

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

A configurable hotkey SHALL move the pin to the next eligible candidate in configured route order after the one currently serving, wrapping once; cycling order is independent of custom automatic selection. When no candidate is eligible, it SHALL notify and leave the pin unchanged.

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

### Requirement: Pin preference notice

A manual change SHALL explain that an eligible new pin applies on the next request and that the selected target remains sticky afterward.

#### Scenario: Change notice
- **WHEN** the user changes the pin
- **THEN** the notification describes the one-shot override and subsequent stickiness

# herdsman-awaited-facts Specification

## Purpose
`pi_herdsman_awaited`: what a pane herdsman publishes for is still waiting on, as `agent:<label>`
entries for its outstanding direct children and `owner` while an owner reply is outstanding.
Published on every pane, including a Lead listing its live workers, and independent of the
agent's own state, so the consumer derives one waiting word from a set that was already there.

## Requirements

### Requirement: Every pane advertises what it is awaiting

A pane herdsman publishes for SHALL carry `pi_herdsman_awaited` while anything is
outstanding, listing `agent:<label>` entries for each outstanding direct child
and `owner` when it has asked its owner. A direct child is outstanding while its
assignment has an active request, an undelivered result or a durable result
error; a delivered, resolved or retained idle child is not awaited. The key SHALL
be cleared when nothing is awaited.

#### Scenario: A Lead awaits its workers

- **WHEN** a Lead has two workers with outstanding work
- **THEN** its pane carries `pi_herdsman_awaited` naming both labels

#### Scenario: A worker awaits a nested agent

- **WHEN** a worker has a nested child with outstanding work
- **THEN** its pane carries `pi_herdsman_awaited` naming that child

#### Scenario: A direct child has no outstanding work

- **WHEN** a direct child's result has been delivered
- **THEN** that child is not named in `pi_herdsman_awaited`

#### Scenario: A pane awaits an owner reply

- **WHEN** a pane has asked its owner and the reply is outstanding
- **THEN** its set contains `owner`

#### Scenario: Nothing is awaited

- **WHEN** the last awaited item is resolved
- **THEN** the key is cleared

### Requirement: The awaited set does not depend on the pane's state

The set SHALL be published while the agent is working as well as while it is
stopped, because it describes what is outstanding rather than what the agent is
doing.

#### Scenario: Working with outstanding work

- **WHEN** a pane has spawned two background tasks and is still working
- **THEN** the awaited items are published while the pane is working

#### Scenario: The turn ends with the same outstanding work

- **WHEN** that pane's turn ends and the items are still outstanding
- **THEN** the set is unchanged and the derived state becomes waiting

### Requirement: Awaited values are bounded and content-free

Every published value SHALL be at most 80 Unicode characters with control
characters replaced by spaces, SHALL hold at most 8 entries, and SHALL contain
only labels and the literal `owner` — never task content, commands, output or
paths.

#### Scenario: More awaited items than the cap

- **WHEN** more items are awaited than the cap allows
- **THEN** the value is capped and still terminal-safe

### Requirement: Awaited facts are refreshed while they exist

While the set is non-empty the facts SHALL be re-published before their TTL
expires, and a pane awaiting nothing SHALL publish nothing and run no timer.

#### Scenario: An item stays outstanding past the TTL

- **WHEN** an awaited item remains outstanding longer than the TTL
- **THEN** the facts are refreshed and remain on the pane

### Requirement: The consumer rule is documented

The pane metadata reference SHALL state that the pane's activity state is
derived rather than published: a live owner `lost` wins; else a working native
state stays working; else a native unknown or missing state stays unknown; else
a non-empty union of awaited items is waiting; else the native state stands. The
union spans publishers, and the owner's assignment projection is not a second
authority for that state.

#### Scenario: A consumer derives the state

- **WHEN** a pane is not working and carries awaited items from any publisher
- **THEN** the documented rule yields waiting, and yields the native state when the union is empty

### Requirement: Managed worker panes advertise their runtime label

A managed worker pane SHALL publish `pi_herdsman_label` with its runtime label
under its existing metadata source, alongside `pi_herdsman_role`, so a consumer
names the pane by the same label its owner's `agent:<label>` awaited entry uses.
The key SHALL be part of that source's own report, so the pane clears it with the
other names it owns, and the report SHALL stay within the 16-key limit. Root
panes need not publish the key.

#### Scenario: A worker publishes its label

- **WHEN** a managed worker publishes its pane metadata
- **THEN** its report carries `pi_herdsman_label` with the runtime label

#### Scenario: A root pane publishes no worker label

- **WHEN** a Lead pane publishes its metadata
- **THEN** its report carries no `pi_herdsman_label`

### Requirement: The control projection is unchanged

`pi_herdsman_state` SHALL keep its existing values and meaning as the assignment
projection, including `settling`, `delivered` and `lost`.

#### Scenario: A control decision is unaffected

- **WHEN** any awaited fact is published or cleared
- **THEN** `pi_herdsman_state` and the control decisions derived from it are unchanged

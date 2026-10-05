# Awaited facts

## ADDED Requirements

### Requirement: Every pane advertises what it is awaiting

A pane herdsman publishes for SHALL carry `pi_herdsman_awaited` while anything is
outstanding, listing `agent:<label>` entries for the agents it awaits and
`owner` when it has asked its owner. The key SHALL be cleared when nothing is
awaited.

#### Scenario: A Lead awaits its workers

- **WHEN** a Lead has two live workers
- **THEN** its pane carries `pi_herdsman_awaited` naming both labels

#### Scenario: A worker awaits a nested agent

- **WHEN** a worker has a live nested child
- **THEN** its pane carries `pi_herdsman_awaited` naming that child

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

The pane metadata reference SHALL state that `waiting` is derived rather than
published: a pane that is not working with a non-empty union of awaited items is
waiting, and the union spans publishers.

#### Scenario: A consumer derives the state

- **WHEN** a pane is not working and carries awaited items from any publisher
- **THEN** the documented rule yields waiting, and yields idle when the union is empty

### Requirement: The control projection is unchanged

`pi_herdsman_state` SHALL keep its existing values and meaning as the assignment
projection, including `settling`, `delivered` and `lost`.

#### Scenario: A control decision is unaffected

- **WHEN** any awaited fact is published or cleared
- **THEN** `pi_herdsman_state` and the control decisions derived from it are unchanged

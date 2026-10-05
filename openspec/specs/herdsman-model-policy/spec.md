# herdsman-model-policy Specification

## Purpose
Constrain which models a delegated agent may run on, and fail a launch whose model cannot resolve before a child starts.

## Requirements

### Requirement: The model policy is validated strictly

The herdsman configuration SHALL accept a `modelScopes` key holding an optional `allow` list
and optional per-definition lists under `agents`, each entry a non-empty pattern. A malformed
scope, an unknown field inside it, or an invalid pattern SHALL fail configuration loading.

#### Scenario: A malformed policy fails loudly

- **WHEN** `modelScopes.agents` is an array, or a pattern is empty
- **THEN** loading fails naming the offending value

#### Scenario: An absent policy leaves resolution unchanged

- **WHEN** `modelScopes` is absent
- **THEN** a definition's pinned model is used and an unpinned agent inherits the controller's
  model, exactly as before

### Requirement: A resolved model must satisfy every scope that exists

The model a launch would use SHALL be checked against the global `allow` list and the
definition's own list when either is present, and the launch SHALL fail when the model is
permitted by neither.

#### Scenario: A pinned model outside the policy is rejected

- **WHEN** a definition pins `omniroute/explorer` and the global `allow` list does not permit
  it
- **THEN** the launch fails naming the definition, the model and the rejecting scope

#### Scenario: An inherited model outside the policy is rejected

- **WHEN** a definition pins no model, the controller runs a model the policy does not permit,
  and the definition's list does not allow `$inherited`
- **THEN** the launch fails naming the inherited model

#### Scenario: A per-definition list restricts without exempting

- **WHEN** the global list permits `omniroute/*` and the definition's list permits only
  `omniroute/explorer`
- **THEN** `omniroute/explorer` launches and another `omniroute` model is rejected

#### Scenario: A wildcard permits a provider's models

- **WHEN** a list contains `openai-codex/*`
- **THEN** any `openai-codex` model is permitted by that scope

### Requirement: The reserved inherited token matches only inherited models

A pattern of `$inherited` SHALL match a model the launch inherited, and SHALL NOT match a model
the definition pinned.

#### Scenario: An inherited model is permitted by the token

- **WHEN** a definition pins no model and its scope allows `$inherited`
- **THEN** the inherited model is permitted by that scope

#### Scenario: A pinned model is not permitted by the token

- **WHEN** a definition pins a model and its scope allows only `$inherited`
- **THEN** the launch fails

### Requirement: A pinned extension-provided model fails fast when discovery is denied

When a definition pins an extension-provided model, denies extension discovery and lists no
explicit extensions, the launch SHALL fail immediately with a diagnostic naming the definition,
the model, the registering provider and available remedies. A non-empty explicit `extensions`
list SHALL be allowed without enabling discovery; the operator is responsible for including the
provider entry, and Pi remains responsible for resolving the model from those loaded extensions.

#### Scenario: The contradiction is reported before the launch

- **WHEN** a definition pins a model from an extension-registered provider and sets
  `noExtensions: true` with no explicit extensions
- **THEN** the launch fails with that diagnostic and no child process is started

#### Scenario: An explicit provider extension keeps the child thin

- **WHEN** a definition pins an extension-provided model, sets `noExtensions: true` and
  explicitly lists the provider entry and required built-ins
- **THEN** the launch preserves `--no-extensions` and passes each explicit entry unchanged
- **AND** the pre-launch guard does not reject the model merely because discovery is disabled

### Requirement: A pinned model is part of the launch record

A definition's pinned model SHALL be part of the launch inputs the stored launch fingerprint
covers, so changing the pin is visible to a retained worker's reuse. An inherited model is
deliberately absent from that record, and the policy needs no separate entry there: a violation
fails the launch rather than changing it.

#### Scenario: Changing a pin is visible to reuse

- **WHEN** a retained worker's definition is reused after its pinned model changes
- **THEN** the stored launch fingerprint differs and the worker is not reused as-is

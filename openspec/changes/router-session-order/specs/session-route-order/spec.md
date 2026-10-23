## ADDED Requirements

### Requirement: Session-local route editing

The router SHALL provide `/route-order` to edit candidate order and automatic-enabled state for the selected route in the current session, without mutating configuration. Up/Down SHALL select, Shift+Up/Down SHALL move the selected candidate, Space SHALL toggle automatic eligibility, Enter SHALL apply, and Escape SHALL cancel. `/route-order reset` SHALL restore configured order and enabled set.

#### Scenario: Apply and cancel

- **WHEN** the user moves or toggles candidates and presses Enter
- **THEN** the session route SHALL use the draft
- **AND** an all-disabled draft SHALL be rejected with feedback while preserving the prior override
- **WHEN** the user presses Escape
- **THEN** the prior override SHALL remain unchanged

#### Scenario: Route exit

- **WHEN** the selected model changes away from the route
- **THEN** its local override SHALL be cleared

### Requirement: Consistent automatic eligibility

Automatic dispatch, previews, retry, terminal fallback, custom strategy eligibility and quota-resumption readiness SHALL honor effective order and disabled state. Custom strategies SHALL receive effective order and retain their choice precedence. Applying or resetting SHALL request one reconsideration of automatic priority, after which normal stickiness SHALL resume. Reordering SHALL NOT bypass health, request fit or admission rules.

#### Scenario: Reconsider then remain sticky

- **WHEN** order is applied or reset on a healthy incumbent
- **THEN** the next automatic decision SHALL reconsider priority
- **AND** after dispatch the chosen candidate SHALL follow normal stickiness

#### Scenario: Disabled target and manual choice

- **WHEN** a candidate is disabled for automatic routing
- **THEN** it SHALL remain in the manual pin picker and cycle
- **AND** a new explicit pin SHALL permit its existing one-shot override
- **AND** a failed disabled pin SHALL NOT automatically reselect that disabled target
- **AND** toggling eligibility SHALL NOT clear shared health

#### Scenario: Quota wake

- **WHEN** only a disabled target has ready capacity
- **THEN** automatic resumption SHALL NOT wake for that target
- **WHEN** an enabled target within the authorized scope becomes ready
- **THEN** resumption SHALL route using the effective order and existing scope fences

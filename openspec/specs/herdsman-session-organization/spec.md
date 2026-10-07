# herdsman-session-organization Specification

## Purpose
Separate new managed-worker session files from operator conversations and persist enough session-local classification and direct-owner metadata for offline consumers to distinguish and reconstruct their hierarchy.

## Requirements

### Requirement: Project-local operator deployment

The deployment SHALL configure native Pi `sessionDir` as `.pi/sessions`, relative to the launch cwd. Native operator CLI and environment overrides SHALL retain their normal precedence. Generated session directories SHALL be ignored by version control at root and nested cwd locations without ignoring other `.pi` resources.

#### Scenario: Fresh operator session
- **WHEN** Pi starts a fresh operator session with the deployment setting and no directory override
- **THEN** it writes the session under `<cwd>/.pi/sessions/`

#### Scenario: Explicit operator override
- **WHEN** the operator supplies a native session-directory override
- **THEN** Pi honors that override rather than the deployment default

#### Scenario: Ignore only generated session data
- **WHEN** version control evaluates root and nested `.pi/sessions/` files and `.pi/settings.json` or skill files
- **THEN** generated session data is ignored and the other `.pi` resources are not ignored by this rule

### Requirement: Local child-session storage

Fresh managed sessions SHALL use `<target-cwd>/.pi/sessions/children/` through an explicit managed-launch directory override. Storage SHALL depend on the target cwd, not delegation depth, parent session path, or inherited operator session-directory configuration.

#### Scenario: Fresh delegated worker
- **WHEN** an operator delegates a fresh managed session
- **THEN** its JSONL file is created in the target cwd's `children/` directory, not beside operator JSONL files

#### Scenario: Nested worker
- **WHEN** a managed worker delegates another worker in the same cwd
- **THEN** both use the same `children/` directory and no `children/children/` directory is introduced

#### Scenario: Different target cwd
- **WHEN** a managed launch targets another cwd
- **THEN** its session is stored under that cwd's `.pi/sessions/children/`

#### Scenario: Inherited directory override
- **WHEN** the parent has an operator setting or environment override for another session directory
- **THEN** a fresh managed launch still selects the target cwd's explicit child directory

### Requirement: Existing paths remain stable

Continuation, retained reuse, recovery, and owner-control restart SHALL preserve the saved Pi session ID and exact path. The new layout SHALL NOT move, rename, rewrite headers, or delete historical session files. Existing ownership, identity, locking, and unread-result safeguards SHALL remain unchanged.

#### Scenario: Legacy global continuation
- **WHEN** an owned worker saved under the legacy global session directory is continued
- **THEN** the same file is resumed by exact path and is not relocated to local storage

#### Scenario: Local continuation and restart
- **WHEN** a local managed worker is continued or restarted by its owner
- **THEN** its existing session file remains at the same child path with the same session ID

#### Scenario: Retained process reuse
- **WHEN** an unchanged retained idle worker receives a new assignment
- **THEN** the existing process/session is reused without creating or relocating a session file

### Requirement: Durable session classification

Herdsman SHALL persist `pi-herdsman-session-metadata` custom entries with data version `1`, `sessionId`, `kind` (`operator` or `managed`), and `role`. Managed metadata SHALL also contain `parentSessionId`, `definition`, and `label`. Metadata SHALL be available from JSONL after pane/mailbox removal and SHALL NOT replace the existing agent-definition identity entry.

#### Scenario: Operator metadata
- **WHEN** a fresh ordinary operator session starts with Herdsman loaded
- **THEN** its own JSONL contains versioned operator metadata for its session ID and effective Lead/Manager/Chief role

#### Scenario: Managed metadata
- **WHEN** a verified managed session starts
- **THEN** its own JSONL contains managed metadata with its session ID, direct owner's session ID, definition, label, and effective role

#### Scenario: Offline discovery
- **WHEN** a consumer reads a managed session file after its process, pane, and mailbox are gone
- **THEN** it can recover classification and recorded direct parent from the file without consulting the former live runtime

### Requirement: Direct owner is distinct from fork lineage

Managed `parentSessionId` SHALL identify the current direct owner, not the root lead. A legitimate ownership change SHALL append updated metadata. Pi's native `parentSession` header SHALL retain its existing fork/branch meaning and SHALL NOT be rewritten to represent orchestration ownership.

#### Scenario: Nested owner pointer
- **WHEN** worker A delegates worker B
- **THEN** B records A's session ID as its direct parent

#### Scenario: Legitimate continuation changes owner
- **WHEN** existing authorization permits another controller to continue the same saved managed session
- **THEN** updated metadata records that direct owner while the session identity and earlier metadata history remain intact

#### Scenario: Fork lineage remains native
- **WHEN** Pi creates a fork with a native parent header
- **THEN** Herdsman does not replace that header relationship with a managed owner relationship

### Requirement: Session-scoped metadata interpretation

Readers SHALL ignore metadata belonging to another session ID before validating its contents, then interpret the latest current-session record. Malformed or unsupported-version current records SHALL produce explicit unavailable-metadata diagnostics, not an inferred operator classification. Such discovery errors SHALL NOT terminate the live session or change assignment authority.

#### Scenario: Fork copies managed entries
- **WHEN** an operator fork contains copied metadata for its managed source's different session ID
- **THEN** copied entries do not classify the fork as managed, and a fresh operator record can describe the fork itself

#### Scenario: Malformed foreign entry
- **WHEN** a copied foreign-session entry has an invalid payload
- **THEN** it is ignored rather than blocking current-session metadata

#### Scenario: Invalid current entry
- **WHEN** the latest matching current-session record is malformed or has an unsupported version
- **THEN** the error is surfaced durably, classification is not guessed, and the active session remains usable

### Requirement: Meaningful updates preserve origin

Herdsman SHALL append metadata at startup and meaningful role/owner changes, without appending an unchanged record. A current-session managed classification SHALL NOT become operator merely because its file is opened outside managed launch environment. Unknown legacy parentage SHALL remain unknown until a verified managed launch supplies it.

#### Scenario: Repeated startup
- **WHEN** the same session restarts without any metadata change
- **THEN** another identical metadata record is not appended

#### Scenario: Operator role transition
- **WHEN** an operator changes between Lead, Manager, and Chief
- **THEN** a new metadata record reflects the effective role while classification remains operator

#### Scenario: Manual opening of a managed file
- **WHEN** an operator opens a file with current-session managed metadata without managed launch environment
- **THEN** its managed origin and recorded owner/definition/label are preserved rather than rewritten as operator

#### Scenario: Legacy worker with unknown parent
- **WHEN** a manually opened legacy file has its own agent-definition identity but no managed metadata or verified owner
- **THEN** Herdsman does not invent parentage or classify it as operator; a later verified managed launch can add complete metadata

### Requirement: Discovery facts do not grant control

Session metadata SHALL be discovery information only. It SHALL NOT replace mailbox/result provenance, bypass ownership or identity validation, or grant continuation/control rights. It SHALL omit process/pane state and child lists; consumers derive hierarchy from direct-parent records.

#### Scenario: Metadata alone cannot authorize continuation
- **WHEN** a session file advertises a parent relationship but lacks the caller's existing proven ownership provenance
- **THEN** continuation remains refused under existing authorization rules

# Spec Delta

## Purpose

This capability describes what this repository's flake promises: one package per plugin, built against
the published Pi-Bolt.nix interface, and checks that prove only the artefacts this repository produces.

## ADDED Requirements

### Requirement: Every plugin is its own flake package
The flake SHALL export each plugin in `nix/recipes.nix` as `packages.<system>.<plugin name>`, in
addition to the npm tarballs it already exports, and SHALL NOT require a consumer to apply the overlay
to reach one.

#### Scenario: A consumer takes a single plugin
- **WHEN** a consumer passes `packages.<system>.herdsman` to `pkgs.pi-bolt.withPlugins`
- **THEN** the payload accepts it, because the derivation carries `passthru.piBolt` with the entry,
  plugin name, dependencies and package name the recipe declares

#### Scenario: A plugin depends on another
- **WHEN** `bash-processes` is taken as a package and `tool-renderer` is not
- **THEN** the derivation still resolves, because the builder stages declared dependencies

### Requirement: The default package is the catalogue, not a payload
`packages.<system>.default` SHALL be the plugin catalogue, and the flake SHALL NOT export a compiled
payload under any package name.

#### Scenario: A consumer builds the default
- **WHEN** a consumer builds `packages.<system>.default`
- **THEN** it receives the plugin trees, not a Pi-Bolt build carrying this repository's selection and
  AOT ceiling

### Requirement: Published plugins carry their lock facts
The flake SHALL export `lib.pluginLockCandidates`, mapping each published plugin to its manifest and,
for an npm-sourced plugin, the pin its archive lives at, so a consumer holding a plugin set lock does
not read this repository's recipe file.

#### Scenario: A consumer regenerates its plugin lock
- **WHEN** the consumer reads `lib.pluginLockCandidates`
- **THEN** it receives every published plugin's manifest path and, for an npm-sourced one, the name,
  version and hash needed to fetch the archive the manifest lives in
- **AND** the value evaluates without a `pkgs` instance

### Requirement: Checks prove only this repository's artefacts
`checks.<system>` SHALL build the npm tarballs and the plugin trees, and SHALL NOT assert the
behaviour of Pi-Bolt.nix's builder, Pi-Bolt's payload, or any nixpkgs primitive.

#### Scenario: A plugin patch no longer applies
- **WHEN** a recipe's `postPatch` substitution stops matching its source
- **THEN** `nix flake check` fails, because the plugin tree is built

#### Scenario: A build produces a payload
- **WHEN** `nix flake check` runs
- **THEN** no payload is compiled, and no check reads a string from another project's artefact

### Requirement: The plugin scope stays available
`overlays.default` SHALL continue to merge the plugins into `piBoltPlugins` for a consumer that wants
the whole set, and `mkJev` SHALL remain in that scope as a builder.

#### Scenario: An existing overlay consumer upgrades
- **WHEN** a consumer that reads `piBoltPlugins.<name>` applies `overlays.default`
- **THEN** every plugin is still reachable by the same attribute

### Requirement: The flake builds against the published interface
The flake SHALL take its plugin builders from `github:Shrub24/Pi-Bolt.nix` rather than from a branch of
the Pi-Bolt application repository.
#### Scenario: The interface moves
- **WHEN** Pi-Bolt.nix changes its builder, the flake's input moves to the release that carries it
- **THEN** no recipe in this repository needs editing, because recipes pass only arguments the builder
  documents

## REMOVED Requirements

### Requirement: A compiled payload with this repository's selection
The flake previously exported a compiled Pi-Bolt build as `packages.<system>.pi-bolt` (and as
`default`) and asserted its compiled plugin list in `checks.<system>.pi-bolt`. Both are removed: the
payload is the consumer's build, and the assertion tested another project's artefact.

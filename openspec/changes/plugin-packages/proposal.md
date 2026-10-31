# Proposal: plugin packages, and checks that stay inside what we own

## Objective

Each plugin in this repository becomes its own flake package, built against the published Pi-Bolt.nix
interface, so a consumer takes plugins by package instead of by overlay attribute. The flake's checks
stop asserting things other layers already prove.

## Why

Two problems, one change, because they meet in the same output table.

**Consumers can only get a plugin through the overlay.** The repository's Nix is written against a
branch of the Pi-Bolt application repository, and individual plugins are reachable only as
`piBoltPlugins.<name>`. Pi-Bolt's payload reads a plugin derivation's `passthru.piBolt` and nothing
else, so a plugin repository can own its plugins as packages; ours does not expose them that way.

**The checks assert someone else's artefact.** `checks.<system>.pi-bolt` builds a full compiled
payload and then greps its `pi-bolt.txt` for `plugins compiled in: …`. No build script writes that
line — it exists in neither the fork branch nor the release — so the check has been asserting a
format that stopped existing, unnoticed, because it is expensive enough to run rarely. It also tests
the thing Pi-Bolt.nix owns: that `withPlugins` compiles a selection and reports it.

## What changes

**Packages.** Pi-Bolt.nix replaces the application-branch input. `packages.<system>` carries every
plugin under its plugin name beside the existing npm tarballs, and `default` becomes the plugin
catalogue rather than a compiled payload.

**The payload leaves the repository.** No `pi-bolt` output, no compiled check, no permission-system
stub, no default plugin selection. Which plugins a build compiles in is the consumer's decision, and
the consumer that needs it — nix-dotfiles — builds the payload on every switch.

**Checks keep only our artefacts.** `npm-packages` and `pi-bolt-plugins` build the two families this
repository produces. Both are our transformations running: our `substituteInPlace` patterns against
our own source, our dependency wiring, our tarball manifests. Nothing asserts nixpkgs behaviour, the
builder's behaviour, or Pi's runtime.

**Two flake outputs nothing consumes go.** `legacyPackages.<system>.piBoltPlugins` and
`lib.piBoltRecipes` have no caller in this repository or downstream; the overlay carries the scope,
and a consumer that wants the recipes reads `nix/recipes.nix` from a checkout.

## Non-goals

- No change to `nix/recipes.nix`, `nix/plugins.nix` or `nix/npm-packages.nix`. Verified against the
  published builder: `herdsman`, `otel` and `tool-renderer` build with no recipe edits.
- No new checks. Every claim I considered adding is already proven by the layer that owns it (see
  `design.md`).
- No change to the overlay, which stays the catalogue for a consumer that wants the whole set merged.
- `mkJev` stays in the plugin scope. It is a builder, and a builder belongs beside
  `buildPiBoltPlugin`; it cannot be a flake package, because it is a function.

## Done

- `nix flake check` passes with two checks and builds no payload.
- `nix build .#herdsman` yields a derivation whose `passthru.piBolt` still names our entry, plugin
  name and dependencies.
- `pkgs.pi-bolt.withPlugins (_: [ inputs.pi-extensions.packages.${system}.herdsman ])` evaluates, with
  the plugin coming from the package table rather than the scope.
- `lib.piBoltRecipes` and `legacyPackages` are gone, and no file references them.

## Risks

- **The input rename is cross-repository.** nix-dotfiles followed
  `inputs.pi-extensions.pi-bolt.follows = "pi-bolt-nix"`; the rename makes that
  line name an input that no longer exists, so it is renamed to
  `inputs.pi-extensions.pi-bolt-nix.follows`, the pin is moved to the release that
  carries the interface, and their lock is regenerated in the same landing. The
  follow is kept, not dropped: it is what keeps one Pi-Bolt.nix for the plugins and
  for the payload that compiles them in.
- **Losing the payload build loses a local integration gate.** Nothing in this repository now proves
  the plugins compile together. That proof moves to the consumer's build and to Pi-Bolt.nix's own
  `checks.plugins`/`plugin-builder`/`plugin-dependencies`, which test the contract at the layer that
  defines it.

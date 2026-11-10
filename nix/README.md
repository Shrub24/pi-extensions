# Nix outputs

This flake packages the extensions in this repository two ways:

- as **Pi-Bolt plugins**, through Pi-Bolt's own plugin interface, so a build compiles them in
  (`pi-bolt.withPlugins`) and the same derivation loads them from the store;
- as **npm tarballs**, one per workspace, installable by npm or Pi.

Which plugins a build contains is the caller's decision; this flake carries the plugins, not a
profile. Each plugin is a package of its own, so a consumer takes the ones it compiles in.

```sh
nix build .#herdsman            # one plugin, as a derivation a payload can compile
nix build .#pi-herdsman         # one npm tarball
nix build .#pi-bolt-plugins     # every plugin tree (patched), also the default
nix build .#npm-extensions      # every workspace tarball in one directory
nix flake check                 # tarballs and plugin trees
```

## Outputs

| Output | |
|---|---|
| `packages.<system>.<plugin>` | One plugin, under the name Pi knows it by (`herdsman`, `radar`, `tool-renderer`, …). |
| `packages.<system>.pi-<name>` | One workspace's npm tarball. |
| `packages.<system>.npm-extensions` | All of them, in one directory. |
| `packages.<system>.pi-bolt-plugins` (default) | This repository's plugin trees. |
| `overlays.default` | The plugin scope, with this repository's plugins merged into Pi-Bolt's. Apply it after Pi-Bolt's overlay. |
| `lib.pluginLockCandidates` | Each published plugin's manifest and npm pin, for a consumer that keeps a plugin set lock. |
| `checks.<system>` | The tarballs and the plugin trees, built. |

There is no payload here: which plugins a Pi-Bolt build carries is the consumer's decision, and a
payload exported from this repository would be that decision already made. Build one where it is
wanted — `pkgs.pi-bolt.withPlugins` below — and test it there.

## Taking one plugin

A plugin is a package, so a consumer takes it by name and passes it to the payload. Pi-Bolt's overlay
defines `pi-bolt` and `piBoltPlugins`; this repository's overlay is only needed for the `ps.<name>`
form below.

```nix
programs.pi-coding-agent.package = pkgs.pi-bolt.withPlugins (_: [
  inputs.pi-extensions.packages.${system}.radar
  inputs.pi-extensions.packages.${system}.herdsman
  inputs.pi-extensions.packages.${system}.tool-renderer
]);
```

The payload reads `passthru.piBolt` from each derivation and nothing else, so a package taken this way
and one taken from the scope compile identically.

## Selecting plugins through the scope

Apply Pi-Bolt's overlay first (it defines `piBoltPlugins`), then this one:

```nix
nixpkgs.overlays = [
  inputs.pi-bolt-nix.overlays.default
  inputs.pi-extensions.overlays.default
];

programs.pi-coding-agent.package = pkgs.pi-bolt.withPlugins (ps: [
  ps.radar
  ps.otel
  ps.herdsman
  ps.cbmem
  ps.bash-processes
  ps.tool-renderer
  ps.output-policy
  ps.reqcap
]);
```

Each selected plugin becomes a built-in extension, `builtin:<pluginName>`: on by default, turned off
with `-builtin:<name>` in the `extensions` setting. The same derivations load at run time from the
store, for example `pi-bolt.override { extensions = [ ps.radar ps.herdsman ]; }`.

Herdsman requires the separately activated `radar` baseline. Its dependency stages the same
`pi-radar` package tree for SDK imports, but staging alone does not register an extension.
Select both `ps.radar` and `ps.herdsman`. Workers explicitly
load the Radar baseline and Herdsman even when their optional extension selection disables
discovery. Radar owns the process claim and exposes the shared subject runtime; Herdsman
never creates a substitute registrar.

`nix/recipes.nix` holds the plugin recipes as data: each plugin's path in this checkout (or the npm
archive it is pinned to), manifest, entry, plugin name, dependencies by name, and the compile-time
patch AOT needs. `nix/plugins.nix` builds those recipes into plugin derivations. A plugin whose
dependency has a `packageName` imports it by that name, linked into the dependent's `node_modules` —
`pi-bash-processes` imports `pi-tool-renderer` that way, and `pi-herdsman` imports
`pi-bash-processes`. A dependency without one is addressed by its staged sibling folder, which only
exists while the plugin set is being compiled, so a recipe that needs the import to work in the
built tree gives the dependency a `packageName` and rewrites the import to it.

A consumer that keeps a plugin set lock — one npm lock shared by the plugins it compiles in — reads
`lib.pluginLockCandidates` instead of the recipes: each published plugin's manifest, and for an
npm-sourced one its pin, as the packages were built from them.

```nix
inputs.pi-extensions.lib.pluginLockCandidates
# { herdsman = { manifest = "pi-herdsman/package.json"; };
#   radar = { manifest = "package/package.json";
#             npm = { name = "pi-radar"; version = "0.15.0"; hash = "sha512-…"; }; };
#   … }
```

`recipe.version` is the plugin's own version, and an npm recipe (`radar`) has `npm.name`/`npm.hash`
instead of `path`.

## Runtime dependencies

A plugin runs with its `dependencies` and nothing else. Each plugin that declares any has a
projected manifest and a lock under `nix/locks/<plugin>/`, generated by `bun run nix:locks`; Pi-Bolt
installs that lock into the plugin's `node_modules`, so the tree is self-contained:

- `bun.lock` stays the development resolution — the one the test suites run against.
- `nix/locks/<plugin>/package.json` is the plugin's manifest with only `name`, `version` and
  `dependencies`: the declaration the lock resolves.
- `nix/locks/<plugin>/package-lock.json` is npm's resolution of it, deduped within that one
  package. No devDependency and no peer is in it, so a plugin tree carries no dev tooling and no
  second copy of Pi.

Version ranges in `package.json` resolve independently of `bun.lock`, so a bump can land different
patch versions than the suite tested. `bun run nix:locks:check` fails CI when a lock no longer
matches its dependencies, and `checks.<system>.plugin-dependencies` verifies the built tree holds
exactly what its lock installs. A plugin whose trimmed dependencies disagree with what it imports
fails at compile or load, not silently.

## jev

`pi-jev` is the permission system's consumer side, and its provider is a plugin this repository does
not carry. It is a builder rather than a plugin, and it needs the provider's plugin name to be the
one its patched import names:

```nix
pkgs.pi-bolt.withPlugins (ps: [
  ps.permission-system                   # whoever provides it
  (ps.mkJev ps.permission-system)
])
```

The provider plugin's tree has to keep its `src/` layout, because the patched import names
`../../permission-system/src/service.ts`.

## The Pi-Bolt input

`pi-bolt-nix` is [Pi-Bolt.nix](https://github.com/Shrub24/Pi-Bolt.nix), the published packaging:
it owns the payload, the plugin scope and the builder this repository writes its recipes against. Its
own checks test the plugin contract (`checks.plugins`, `plugin-builder`, `plugin-dependencies`), so
this repository does not repeat them — it verifies the two things it produces, the plugin trees and
the npm tarballs.

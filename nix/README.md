# Nix outputs

This flake packages the extensions in this repository two ways:

- as **Pi-Bolt plugins**, through Pi-Bolt's own plugin interface, so a build compiles them in
  (`pi-bolt.withPlugins`) and the same derivation loads them from the store;
- as **npm tarballs**, one per workspace, installable by npm or Pi.

Which plugins a build contains is the caller's decision; this flake carries the plugins, not a
profile.

```sh
nix build .#npm-extensions      # every workspace tarball in one directory
nix build .#pi-herdsman         # one npm tarball
nix build .#pi-bolt-plugins     # every plugin tree (patched)
nix build .#pi-bolt             # this repository's plugins compiled in
nix flake check                 # tarballs, plugins, and a Pi-Bolt build
```

## Outputs

| Output | |
|---|---|
| `packages.<system>.pi-<name>` | One workspace's npm tarball. |
| `packages.<system>.npm-extensions` | All of them, in one directory. |
| `packages.<system>.pi-bolt-plugins` | This repository's plugin trees. |
| `packages.<system>.pi-bolt` (default) | Pi-Bolt with this repository's plugins compiled in. |
| `legacyPackages.<system>.piBoltPlugins` | The plugin scope, with this repository's plugins merged into Pi-Bolt's. |
| `overlays.default` | The same merge, for `nixpkgs.overlays`. Apply it after Pi-Bolt's overlay. |
| `checks.<system>` | The three above, built. |

## Selecting plugins

Apply Pi-Bolt's overlay first (it defines `piBoltPlugins`), then this one:

```nix
nixpkgs.overlays = [
  inputs.pi-bolt.overlays.default
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
Select both `ps.radar` and `ps.herdsman`; the default build above does so. Workers explicitly
load the Radar baseline and Herdsman even when their optional extension selection disables
discovery. Radar owns the process claim and exposes the shared subject runtime; Herdsman
never creates a substitute registrar.

`nix/recipes.nix` holds the plugin recipes as data: each plugin's path in this checkout (or the npm
archive it is pinned to), manifest, entry, plugin name, dependencies by name, and the compile-time
patch AOT needs. `nix/plugins.nix` builds those recipes into plugin derivations. A plugin whose
dependency has a `packageName` imports it by that name without either side being rewritten —
`pi-bash-processes` imports `pi-tool-renderer` that way.

A package set that builds these plugins with its own lock imports the recipes from a checkout of
this repository and supplies only its own `pi-radar` tree. `nix/recipes.nix` takes the checkout as
`self`, so it works for a source-only input as well as a flake input:

```nix
let
  piExtensions = inputs.pi-extensions;   # a checkout, flake = false is enough
  recipes = import "${piExtensions}/nix/recipes.nix" {
    inherit lib;
    self = piExtensions;
  };
in
{
  herdsman = {
    inherit (recipes.herdsman) entry pluginName dependencies;
    src = "${piExtensions}/${recipes.herdsman.path}";
    postPatch = recipes.herdsman.patch {
      radar = radarTree;                 # the `radar` plugin's built tree
      inherit (recipes.herdsman) version;
    };
  };
}
```

A flake input can read the same value as `inputs.pi-extensions.lib.piBoltRecipes`.

`recipe.version` is the plugin's own version, and an npm recipe (`radar`) has `npm.name`/`npm.hash`
instead of `path`. The `pi-radar` pin is checked against `pi-herdsman/package.json` when the recipes
are evaluated, so a recipe cannot drift from Herdsman's dependency.

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

## The Pi-Bolt pin

`pi-bolt` is an input pinned to the plugin interface this packaging is written against. When that
work lands upstream, point the input at the upstream repository instead of the fork's branch.

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
store, which is what `pi-bolt.override { extensions = [ ps.herdsman ]; }` does.

`nix/plugins.nix` holds the plugin definitions: their names, entries, dependencies, npm libraries
and the compile-time patches AOT needs. `dependencies` are plugin derivations, and a plugin whose
dependency has a `packageName` imports it by that name without either side being rewritten —
`pi-bash-processes` imports `pi-tool-renderer` that way.

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

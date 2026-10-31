# Design

## The interface we build against

Pi-Bolt.nix (`github:Shrub24/Pi-Bolt.nix`) owns the payload, the plugin scope and the builder:

- `overlays.default` defines `piBoltPlugins` (a scope with `buildPiBoltPlugin` and `fetchNpmPackage`),
  `pi-bolt` and `pi-bolt-runtime`.
- `buildPiBoltPlugin` takes `pname`, `version`, `src`, `entry`, `pluginName`, `packageName`,
  `dependencies`, `packageLock`, `nodeModules`, `workers`, `runtimeInputs`, `builtin`, `postPatch`.
- `pi-bolt.withPlugins (ps: [ … ])` compiles any derivation whose `passthru.piBolt` has the builder's
  shape, whether or not it came from that scope.

Checked against our recipes rather than assumed: `herdsman`, `otel` and `tool-renderer` build with
this builder unchanged, `otel`'s `nodeModules` argument is accepted, `postPatch` applies, dependency
links appear (`node_modules/pi-radar`, `pi-tool-renderer`), and `passthru.piBolt` still names our
entry, plugin name and dependencies. Feeding the result to `withPlugins` from outside the scope
evaluates to a payload derivation.

The one argument difference between the branch we used and this flake is `libraries` versus
`packageLock`. Our recipes pass neither: the only dependency tree is pi-otel's, supplied as
`nodeModules`, which both builders accept. So the input swap needs no recipe change.

## Outputs

```
packages.<system>.<npm tarball>      unchanged: pi-<name>, npm-extensions
packages.<system>.<plugin name>      new: herdman… — one derivation per plugin
packages.<system>.pi-bolt-plugins    unchanged: every plugin tree, in one linkFarm
packages.<system>.default            now the catalogue (pi-bolt-plugins)
checks.<system>.npm-packages         unchanged
checks.<system>.pi-bolt-plugins      unchanged
overlays.default                     unchanged
```

Gone: `packages.<system>.pi-bolt`, `checks.<system>.pi-bolt`, `legacyPackages`,
`lib.piBoltRecipes`, and the default plugin selection that only the payload used.

`default` is the catalogue rather than a payload: a payload carries this repository's selection and
AOT ceiling, and a consumer that types `nix build` should not silently get one.

## Why no check replaces the payload one

Each candidate fails the ownership test in `testing-discipline` — either the claim is another layer's,
or it is our own table asserted back to ourselves:

| Candidate | Why not |
| --- | --- |
| The payload compiles a selection and reports it | Pi-Bolt.nix's `checks.plugins`, `plugin-builder`, `plugin-dependencies`; and the consumer builds it on every switch |
| A plugin's `entry` file exists | `buildPiBoltPlugin` asserts `test -f $out/$entry`; a second copy is duplicate evidence |
| A dependency resolves, and the graph is acyclic | The builder throws on a dependency that is not a plugin; a cycle hangs evaluation |
| Plugin names are unique | The payload throws `different plugin derivations share a name` — the layer that resolves names |
| `packages` carries these names | Our own output table, asserted back to itself: a rename moves both sides and the check never fails |

What remains is what we own: the two artefact families build, which runs our patches and our wiring,
and the two data asserts already in place — the `pi-radar` pin against `pi-herdsman/package.json`,
and `mkJev`'s provider plugin name.

## Consumer shape

```nix
programs.pi-coding-agent.package = pkgs.pi-bolt.withPlugins (_: [
  inputs.pi-extensions.packages.${system}.radar
  inputs.pi-extensions.packages.${system}.herdsman
  inputs.pi-extensions.packages.${system}.tool-renderer
]);
```

The overlay remains for a consumer that wants the whole set merged into `piBoltPlugins`, and mixing
the two is fine: the payload reads `passthru.piBolt` only.

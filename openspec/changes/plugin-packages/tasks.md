# Tasks

## 1. Input

- [x] 1.1 Replace the `pi-bolt` input with `pi-bolt-nix = github:Shrub24/Pi-Bolt.nix`, nixpkgs following.
- [x] 1.2 Read the plugin scope from `pi-bolt-nix.overlays.default`; regenerate `flake.lock`.

## 2. Outputs

- [x] 2.1 Export every plugin as `packages.<system>.<plugin name>` beside the npm tarballs.
- [x] 2.2 Make `default` the plugin catalogue; drop `packages.<system>.pi-bolt`.
- [x] 2.3 Drop `legacyPackages` and `lib.piBoltRecipes`.
- [x] 2.4 Export `lib.pluginLockCandidates` from the recipes, and point the consumer that keeps the
      plugin set lock at it instead of at `nix/recipes.nix`.

## 3. Checks

- [x] 3.1 Remove `checks.<system>.pi-bolt` with the compiled build, the AOT ceiling override, the
      permission-system stub and the default plugin selection it fed.
- [x] 3.2 Leave `checks.<system>.npm-packages` and `checks.<system>.pi-bolt-plugins` as the whole set.

## 4. Documentation

- [x] 4.1 Update `nix/README.md`: outputs table, build examples, the plugin-in-a-flake example, and
      the "Pi-Bolt pin" section that described this change as pending.

## 5. Verification

- [x] 5.1 `nix flake check` passes, building no payload.
- [x] 5.2 `nix build .#herdsman` succeeds and `passthru.piBolt` still names the recipe's entry, plugin
      name and dependencies.
- [x] 5.3 `pkgs.pi-bolt.withPlugins (_: [ packages.<system>.herdsman ])` evaluates from the package
      table only.
- [x] 5.4 No file references `piBoltRecipes`, `legacyPackages` or the removed payload.
- [x] 5.6 `lib.pluginLockCandidates` evaluates without `pkgs` and names every published plugin.
- [x] 5.5 nix-dotfiles: rename the follow to `inputs.pi-extensions.pi-bolt-nix.follows`, bump
      `pi-bolt-nix` to the revision that exports the npm helper, regenerate their generated flake, and
      confirm one Pi-Bolt.nix node in their lock.

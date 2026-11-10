# This repository's extensions as Pi-Bolt plugins, built from `nix/recipes.nix`.
#
# The interface is Pi-Bolt's: `piBoltPlugins.buildPiBoltPlugin` (nix/plugins/build-plugin.nix
# in Pi-Bolt) returns a plugin derivation that `pi-bolt.withPlugins` compiles in and
# `pi-bolt.override { extensions = [ plugin ]; }` loads from the store, from the same patched tree.
# Each plugin carries its own compile-time adaptations and dependencies, so a consumer's build
# needs no recipe of its own for them.
{
  lib,
  pkgs,
  self,
  buildPiBoltPlugin,
  fetchNpmPackage,
}:
let
  recipes = import ./recipes.nix { inherit lib self; };
  checkout = name: "${self}/${name}";
  versionOf = name: (lib.importJSON "${checkout name}/package.json").version;

  # A plugin's runtime dependencies, as its lock under nix/locks resolves them (`bun run nix:locks`).
  # Pi-Bolt installs that lock into the plugin's node_modules, so the tree carries no dev tooling and
  # no second copy of Pi.
  ownDependencies =
    recipe:
    lib.optionalAttrs
      (recipe.path != null && builtins.pathExists "${self}/nix/locks/${recipe.path}/package-lock.json")
      {
        packageLock = "${self}/nix/locks/${recipe.path}/package-lock.json";
      };

  # Every recipe becomes a plugin. Dependencies and patches name other plugins, so the set refers to
  # itself lazily; the graph is acyclic.
  plugins = lib.mapAttrs (
    name: recipe:
    let
      # A plugin fetched from npm states its pin in the recipe; a local one states its version in its
      # manifest.
      fromNpm = recipe.npm != null;
      inherit (recipe) version;
      src =
        if fromNpm then
          fetchNpmPackage {
            pname = recipe.npm.name;
            inherit version;
            inherit (recipe.npm) hash;
          }
        else
          checkout recipe.path;
    in
    buildPiBoltPlugin (
      {
        pname = if fromNpm then recipe.npm.name else recipe.path;
        inherit version;
        inherit (recipe) entry pluginName;
        inherit src;
        dependencies = map (dep: plugins.${dep}) recipe.dependencies;
        postPatch = recipe.patch {
          inherit version;
          radar = plugins.radar;
        };
      }
      // lib.optionalAttrs (recipe ? packageName) { inherit (recipe) packageName; }
      // ownDependencies recipe
    )
  ) recipes;

  # jev is a builder, not a recipe: its provider is another plugin this repository does not carry.
  # Its two entry files are one extension with a permission surface and one with a tool surface; a
  # compiled manifest takes one factory.
  mkJev =
    permissionSystem:
    assert lib.assertMsg ((permissionSystem.piBolt or { }).name == "permission-system")
      "pi-jev: pass the permission-system plugin (pluginName \"permission-system\"); its provider import is patched to that sibling directory";
    buildPiBoltPlugin {
      pname = "pi-jev";
      version = versionOf "pi-jev";
      src = checkout "pi-jev";
      entry = "extensions/compiled.ts";
      pluginName = "jev";
      dependencies = [ permissionSystem ];
      # The provider is resolved per session through a process global, so the provider's module
      # is imported, never cached. A compiled build cannot resolve a computed specifier, so name the
      # staged provider instead.
      postPatch = ''
        cat > extensions/compiled.ts <<'EOF'
        import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
        import permissions from "./permission-authorizer.ts";
        import intent from "./tool-intent.ts";
        export default function jev(pi: ExtensionAPI) { permissions(pi); intent(pi); }
        EOF
        substituteInPlace extensions/gotgenes.ts \
          --replace-fail 'return import(specifier);' 'return import("../../permission-system/src/service.ts");'
      '';
    };
in
{
  inherit plugins mkJev recipes;
}

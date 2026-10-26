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

  # pi-otel's locked OpenTelemetry dependencies, as the node_modules the plugin imports them from.
  #
  # Its lockfile is the runtime tree only once Pi's own packages (Pi provides them) and the
  # dev-only entries are dropped: npm records some dev entries without an integrity hash, which
  # importNpmLock has to fetch with.
  otelManifest = lib.importJSON "${checkout "pi-otel"}/package.json";
  otelLock = lib.importJSON "${checkout "pi-otel"}/package-lock.json";
  otelDependencies = pkgs.importNpmLock.buildNodeModules {
    npmRoot = checkout "pi-otel";
    package = removeAttrs otelManifest [ "devDependencies" ];
    packageLock = otelLock // {
      packages = lib.filterAttrs (
        path: entry:
        !(entry.dev or false)
        && !(entry.link or false)
        && !(lib.hasInfix "node_modules/@earendil-works/pi-" path)
      ) otelLock.packages;
    };
    nodejs = pkgs.nodejs;
    # Pi supplies its own packages as peers, so npm must not try to install them.
    derivationArgs = {
      npmFlags = [ "--legacy-peer-deps" ];
      npmRebuildFlags = [ "--ignore-scripts" ];
    };
  };

  # What a recipe needs beyond its recipe data: a dependency closure this repository builds itself.
  extras = {
    otel.nodeModules = "${otelDependencies}/node_modules";
  };

  # Every recipe becomes a plugin. Dependencies and patches name other plugins, so the set refers to
  # itself lazily; the graph is acyclic.
  plugins = lib.mapAttrs (
    name: recipe:
    let
      src =
        if recipe.npm != null then
          fetchNpmPackage {
            pname = recipe.npm.name;
            inherit (recipe) version;
            inherit (recipe.npm) hash;
          }
        else
          checkout recipe.path;
    in
    buildPiBoltPlugin (
      {
        pname = if recipe.npm != null then recipe.npm.name else recipe.path;
        inherit (recipe) version entry pluginName;
        inherit src;
        dependencies = map (dep: plugins.${dep}) recipe.dependencies;
        postPatch = recipe.patch {
          inherit (recipe) version;
          radar = plugins.radar;
        };
      }
      // lib.optionalAttrs (recipe ? packageName) { inherit (recipe) packageName; }
      // (extras.${name} or { })
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

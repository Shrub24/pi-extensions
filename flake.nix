{
  description = "pi-extensions: npm artifacts and Pi-Bolt plugin packages";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    # Pi-Bolt's published packaging interface: the plugin scope this repository
    # builds against, and the payload a consumer compiles the plugins into.
    pi-bolt-nix = {
      url = "github:Shrub24/Pi-Bolt.nix";
      # One nixpkgs: the plugin scope and these packages are built from the same
      # instance.
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      pi-bolt-nix,
    }:
    let
      lib = nixpkgs.lib;
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = lib.genAttrs systems;

      pluginsFor =
        pkgs:
        import ./nix/plugins.nix {
          inherit lib pkgs;
          self = self.outPath;
          inherit (pkgs.piBoltPlugins) buildPiBoltPlugin fetchNpmPackage;
        };

      perSystem =
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system}.extend pi-bolt-nix.overlays.default;
          npmPackages = import ./nix/npm-packages.nix { inherit pkgs self; };
          extensions = pluginsFor pkgs;
          pluginTrees = pkgs.linkFarm "pi-bolt-plugins" (
            lib.mapAttrsToList (name: plugin: {
              inherit name;
              path = plugin;
            }) extensions.plugins
          );
        in
        {
          inherit
            pkgs
            extensions
            npmPackages
            pluginTrees
            ;
        };

      scopes = forAllSystems perSystem;
    in
    {
      # Apply after Pi-Bolt's overlay: it extends the plugin scope that overlay
      # defines, so `pi-bolt.withPlugins (ps: [ ps.herdsman ... ])` finds them.
      overlays.default = final: prev: {
        piBoltPlugins = prev.piBoltPlugins.overrideScope (
          _final: _prev:
          let
            extensions = import ./nix/plugins.nix {
              lib = final.lib;
              pkgs = final;
              self = self.outPath;
              inherit (prev.piBoltPlugins) buildPiBoltPlugin fetchNpmPackage;
            };
          in
          extensions.plugins // { inherit (extensions) mkJev; }
        );
      };

      # One package per plugin, under the name Pi knows it by, beside the npm
      # tarballs: a consumer takes what it compiles in and nothing else. The
      # default is the catalogue, never a payload — a payload carries a selection
      # and an AOT ceiling that belong to whoever builds it.
      packages = lib.mapAttrs (
        _: scope:
        scope.npmPackages
        // scope.extensions.plugins
        // {
          pi-bolt-plugins = scope.pluginTrees;
          default = scope.pluginTrees;
        }
      ) scopes;

      # Both families this repository produces, and nothing else: building them
      # runs our patches and our dependency wiring. A compiled payload is the
      # consumer's build, and Pi-Bolt.nix tests the plugin contract itself.
      checks = lib.mapAttrs (_: scope: {
        npm-packages = scope.npmPackages.npm-extensions;
        pi-bolt-plugins = scope.pluginTrees;
      }) scopes;

      formatter = forAllSystems (system: nixpkgs.legacyPackages.${system}.nixfmt);
    };
}

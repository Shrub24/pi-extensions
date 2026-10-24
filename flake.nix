{
  description = "pi-extensions: npm artifacts and Pi-Bolt plugin packages";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    # Pi-Bolt's plugin interface (`piBoltPlugins`) and the AOT package this
    # repository's plugins are built and verified against. This branch carries
    # the interface; it is not on Pi-Bolt's release line.
    pi-bolt = {
      url = "github:Shrub24/pi-bolt/feature/nix-flake-hm-module";
      # One nixpkgs: the plugin scope and these packages are built from the same
      # instance.
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      pi-bolt,
    }:
    let
      lib = nixpkgs.lib;
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = lib.genAttrs systems;

      # The extensions this repository compiles into its own build. jev is not
      # among them: it needs the permission system's plugin, which this
      # repository does not carry (see nix/plugins.nix).
      defaultPluginNames = [
        "radar"
        "otel"
        "herdsman"
        "cbmem"
        "bash-processes"
        "tool-renderer"
        "output-policy"
        "reqcap"
      ];

      pluginsFor =
        pkgs:
        import ./nix/plugins.nix {
          inherit lib pkgs;
          self = self.outPath;
          inherit (pkgs.piBoltPlugins) buildPiBoltPlugin fetchNpmPackage;
        };

      # The plugin scope Pi-Bolt's own flake would have, with this repository's
      # plugins merged into it.
      scopeFor =
        pkgs:
        let
          extensions = pluginsFor pkgs;
        in
        pkgs.piBoltPlugins.overrideScope (
          _final: _prev: extensions.plugins // { inherit (extensions) mkJev; }
        );

      perSystem =
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system}.extend pi-bolt.overlays.default;
          npmPackages = import ./nix/npm-packages.nix { inherit pkgs self; };
          extensions = pluginsFor pkgs;
          selected = map (name: extensions.plugins.${name}) defaultPluginNames;
          # pi-herdsman's extension is one large module, whose top-level bytecode
          # passes the compiler's default ceiling; raise it as the compiler asks
          # rather than leave the plugin out.
          piBoltBase = pkgs.pi-bolt.override { maxAotCandidateBytecodeSize = 500000; };
          piBolt = piBoltBase.withPlugins (_: selected);
          pluginTrees = pkgs.linkFarm "pi-bolt-plugins" (
            lib.mapAttrsToList (name: plugin: {
              inherit name;
              path = plugin;
            }) extensions.plugins
          );

          # jev's provider, as a stand-in for the permission system's own plugin:
          # the same plugin name and the same file jev's patched import names.
          # Compiling both in is what proves the provider resolves at build time.
          providerSrc = pkgs.runCommand "permission-system-stub" { } ''
            mkdir -p "$out/src"
            printf '%s\n' '{ "name": "@gotgenes/pi-permission-system", "version": "0", "type": "module" }' > "$out/package.json"
            printf '%s\n' 'export function getPermissionsService() { return undefined; }' 'export default function permissionSystem() {}' > "$out/src/index.ts"
            printf '%s\n' 'export function getPermissionsService() { return undefined; }' > "$out/src/service.ts"
          '';
          provider = pkgs.piBoltPlugins.buildPiBoltPlugin {
            pname = "permission-system";
            version = "0";
            src = providerSrc;
            entry = "src/index.ts";
          };
          jev = extensions.mkJev provider;
          piBoltWithJev = piBoltBase.withPlugins (_: [
            provider
            jev
          ]);

          compiledCheck = pkgs.runCommand "pi-bolt-compiled-plugins" { } ''
            export HOME=$TMPDIR
            grep -q 'plugins compiled in: ${lib.concatStringsSep ", " defaultPluginNames}' ${piBolt}/lib/pi-bolt/pi-bolt.txt
            grep -q 'plugins compiled in: permission-system, jev' ${piBoltWithJev}/lib/pi-bolt/pi-bolt.txt
            ${lib.getExe piBolt} --version
            touch $out
          '';
        in
        {
          inherit
            pkgs
            extensions
            npmPackages
            selected
            piBolt
            pluginTrees
            compiledCheck
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

      packages = lib.mapAttrs (
        _: scope:
        scope.npmPackages
        // {
          pi-bolt-plugins = scope.pluginTrees;
          pi-bolt = scope.piBolt;
          default = scope.piBolt;
        }
      ) scopes;

      legacyPackages = lib.mapAttrs (_: scope: { piBoltPlugins = scopeFor scope.pkgs; }) scopes;

      checks = lib.mapAttrs (_: scope: {
        npm-packages = scope.npmPackages.npm-extensions;
        pi-bolt-plugins = scope.pluginTrees;
        pi-bolt = scope.compiledCheck;
      }) scopes;

      formatter = forAllSystems (system: nixpkgs.legacyPackages.${system}.nixfmt);
    };
}

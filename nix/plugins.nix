# This repository's extensions as Pi-Bolt plugins.
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

  # pi-herdsman's one npm dependency (`npm view pi-radar@0.2.0 dist.integrity`).
  piRadar = fetchNpmPackage {
    pname = "pi-radar";
    version = "0.2.0";
    hash = "sha512-91uezCVJCU2NeRoYPNd+8740ZS30l08DGOywqhkYF7al0fzxGHGZquTKzYGWrdMxTpbceK6qqGtgojg4EW6pSQ==";
  };

  otel = buildPiBoltPlugin {
    pname = "pi-otel";
    version = versionOf "pi-otel";
    src = checkout "pi-otel";
    entry = "src/index.ts";
    pluginName = "otel";
    nodeModules = "${otelDependencies}/node_modules";
    # A compiled build has no source-relative package.json to read the version from.
    postPatch = ''
      substituteInPlace src/version.ts \
        --replace-fail 'import { readFileSync } from "node:fs";' "" \
        --replace-fail 'JSON.parse(readFileSync(url, "utf8")) as { version?: string }' '{ version: "${versionOf "pi-otel"}" } as { version?: string }'
    '';
  };

  cbmem = buildPiBoltPlugin {
    pname = "pi-cbmem";
    version = versionOf "pi-cbmem";
    src = checkout "pi-cbmem";
    entry = "extensions/cbmem.ts";
    pluginName = "cbmem";
  };

  output-policy = buildPiBoltPlugin {
    pname = "pi-output-policy";
    version = versionOf "pi-output-policy";
    src = checkout "pi-output-policy";
    entry = "extensions/output-policy.ts";
    pluginName = "output-policy";
  };

  reqcap = buildPiBoltPlugin {
    pname = "pi-reqcap";
    version = versionOf "pi-reqcap";
    src = checkout "pi-reqcap";
    entry = "extensions/index.ts";
    pluginName = "reqcap";
  };

  # Its package.json export map is what pi-bash-processes imports it by, so a
  # dependency link there resolves without either plugin being rewritten. The
  # dependency is optional: without the renderer the row falls back to its own
  # presentation.
  tool-renderer = buildPiBoltPlugin {
    pname = "pi-tool-renderer";
    version = versionOf "pi-tool-renderer";
    src = checkout "pi-tool-renderer";
    entry = "extensions/tool-renderer.ts";
    pluginName = "tool-renderer";
    packageName = "pi-tool-renderer";
  };

  bash-processes = buildPiBoltPlugin {
    pname = "pi-bash-processes";
    version = versionOf "pi-bash-processes";
    src = checkout "pi-bash-processes";
    entry = "extensions/background-tasks.ts";
    pluginName = "bash-processes";
    dependencies = [ tool-renderer ];
  };

  herdsman = buildPiBoltPlugin {
    pname = "pi-herdsman";
    version = versionOf "pi-herdsman";
    src = checkout "pi-herdsman";
    entry = "extension/index.ts";
    pluginName = "herdsman";
    libraries = [ piRadar ];
    # Its two hooks import bash-processes' source, and bash-processes imports
    # tool-renderer's, so both are staged whether or not the build registers them.
    dependencies = [
      bash-processes
      tool-renderer
    ];
    # A child on stock Pi needs the extension's files as a path, and bundled agent
    # definitions have to stay readable from disk rather than from Bun's virtual
    # file system. This plugin's own store tree is the copy that outlives the build.
    postPatch = ''
      substituteInPlace extension/index.ts \
        --replace-fail 'const HERDSMAN_EXTENSION_PATH = fileURLToPath(import.meta.url);' 'const HERDSMAN_EXTENSION_PATH = "$out/extension/index.ts";' \
        --replace-fail '"../../pi-bash-processes/extensions/background-work.ts"' '"../../bash-processes/extensions/background-work.ts"'
      substituteInPlace extension/advisory-wake.ts \
        --replace-fail '"../../pi-bash-processes/extensions/wake-consumer.ts"' '"../../bash-processes/extensions/wake-consumer.ts"'
      substituteInPlace extension/agent-definitions.ts \
        --replace-fail 'const BUILTIN_AGENT_DIR = fileURLToPath(
        new URL("./agent-definitions", import.meta.url),
      );' 'const BUILTIN_AGENT_DIR = "$out/extension/agent-definitions";'
    '';
  };

  # pi-jev is the permission system's consumer side, and this repository does not
  # carry its provider: build it with the plugin that provides it. The provider's
  # plugin name is what its patched import names, so it has to be that one.
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
      # Its two entry files are one extension with a permission surface and one
      # with a tool surface; a compiled manifest takes one factory.
      postPatch = ''
        cat > extensions/compiled.ts <<'EOF'
        import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
        import permissions from "./permission-authorizer.ts";
        import intent from "./tool-intent.ts";
        export default function jev(pi: ExtensionAPI) { permissions(pi); intent(pi); }
        EOF
        # The provider is resolved per session through a process global, so the
        # provider's module is imported, never cached. A compiled build cannot
        # resolve a computed specifier, so name the staged provider instead.
        substituteInPlace extensions/gotgenes.ts \
          --replace-fail 'return import(specifier);' 'return import("../../permission-system/src/service.ts");'
      '';
    };

  plugins = {
    inherit
      bash-processes
      cbmem
      herdsman
      otel
      output-policy
      reqcap
      tool-renderer
      ;
  };
in
{
  inherit plugins mkJev;
}

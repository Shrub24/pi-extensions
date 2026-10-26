# This repository's plugin recipes, as data.
#
# A recipe names where a plugin's source is (a path in this checkout, or the npm archive it is
# pinned to), its manifest, the entry Pi-Bolt compiles, the name it registers under, the plugins
# it depends on by name, and its compile-time patch. Nothing here builds anything: `nix/plugins.nix`
# builds these recipes for this repository, and a downstream package set builds the same recipes
# with its own lock and its own copy of the source.
#
# Paths are relative to the repository root, so a consumer composes them with its own input:
#
#   recipe.path == null     -> recipe.npm is the pinned archive
#   otherwise               -> "${piExtensions}/${recipe.path}" is the source tree
#
# `patch` takes `{ version, radar }` and returns the postPatch text. `radar` is the built tree of
# the `radar` plugin; the patch needs it only as a path, so a consumer passes its own. `version`
# is the plugin's own version.
{
  lib,
  self,
}:
let
  manifestOf = path: lib.importJSON "${self}/${path}/package.json";

  # A plugin whose source is a directory of this checkout.
  local = path: {
    inherit path;
    manifest = "${path}/package.json";
    version = (manifestOf path).version;
    npm = null;
    patch = _: "";
  };

  noPatch = _: "";

  # Herdsman's pi-radar pin. Pi-Bolt compiles the baseline in as a plugin; this pin is the one the
  # shared SDK imports, so the two must agree.
  radarVersion = "0.12.0";

  recipes = assert lib.assertMsg
    ((manifestOf "pi-herdsman").dependencies."pi-radar" == radarVersion)
    "nix/recipes.nix: pi-radar ${radarVersion} is not the version pi-herdsman/package.json depends on";
  {
    # The SDK is also the registrar extension. Its baseline is the entry Herdsman's children load
    # from disk, so the built tree must keep extension/baseline.ts beside the SDK's own files.
    radar = {
      path = null;
      npm = {
        name = "pi-radar";
        hash = "sha512-9guUUWReM1Z9Vt2uMXBYuv/mRGv+wtF1XZPvxcJVa4BuEfPnmhMpmSBNOsz+uLrv2/s1oR4o9594q5XuNiRhjQ==";
      };
      version = radarVersion;
      manifest = "package/package.json";
      entry = "extension/baseline.ts";
      pluginName = "radar";
      packageName = "pi-radar";
      dependencies = [ ];
      patch = noPatch;
    };

    otel = (local "pi-otel") // {
      entry = "src/index.ts";
      pluginName = "otel";
      dependencies = [ ];
      # A compiled build has no source-relative package.json to read the version from.
      patch =
        { version, ... }:
        ''
          substituteInPlace src/version.ts \
            --replace-fail 'import { readFileSync } from "node:fs";' "" \
            --replace-fail 'JSON.parse(readFileSync(url, "utf8")) as { version?: string }' '{ version: "${version}" } as { version?: string }'
        '';
    };

    cbmem = (local "pi-cbmem") // {
      entry = "extensions/cbmem.ts";
      pluginName = "cbmem";
      dependencies = [ ];
    };

    copy-mode = (local "pi-copy-mode") // {
      entry = "extensions/copy-mode.ts";
      pluginName = "copy-mode";
      dependencies = [ ];
    };

    output-policy = (local "pi-output-policy") // {
      entry = "extensions/output-policy.ts";
      pluginName = "output-policy";
      dependencies = [ ];
    };

    reqcap = (local "pi-reqcap") // {
      entry = "extensions/index.ts";
      pluginName = "reqcap";
      dependencies = [ ];
    };

    # Its package.json export map is what pi-bash-processes imports it by, so a dependency link
    # there resolves without either plugin being rewritten. The dependency is optional: without the
    # renderer the row falls back to its own presentation.
    tool-renderer = (local "pi-tool-renderer") // {
      entry = "extensions/tool-renderer.ts";
      pluginName = "tool-renderer";
      packageName = "pi-tool-renderer";
      dependencies = [ ];
    };

    bash-processes = (local "pi-bash-processes") // {
      entry = "extensions/background-tasks.ts";
      pluginName = "bash-processes";
      dependencies = [ "tool-renderer" ];
    };

    herdsman = (local "pi-herdsman") // {
      entry = "extension/index.ts";
      pluginName = "herdsman";
      # The shared registrar is a plugin dependency, not a second SDK library. Herdsman's hooks also
      # import bash-processes and its tool-renderer dependency.
      dependencies = [
        "radar"
        "bash-processes"
        "tool-renderer"
      ];
      # A child on stock Pi needs the extension's files as a path, and bundled agent definitions
      # have to stay readable from disk rather than from Bun's virtual file system. This plugin's
      # own store tree is the copy that outlives the build.
      patch =
        { radar, ... }:
        ''
          substituteInPlace extension/index.ts \
            --replace-fail 'const HERDSMAN_EXTENSION_PATH = fileURLToPath(import.meta.url);' 'const HERDSMAN_EXTENSION_PATH = "$out/extension/index.ts";' \
            --replace-fail '"../../pi-bash-processes/extensions/background-work.ts"' '"../../bash-processes/extensions/background-work.ts"'
          substituteInPlace extension/radar-baseline.ts \
            --replace-fail 'const BUILD_BASELINE_PATH: string | undefined = undefined;' 'const BUILD_BASELINE_PATH: string | undefined = "${radar}/extension/baseline.ts";'
          substituteInPlace extension/advisory-wake.ts \
            --replace-fail '"../../pi-bash-processes/extensions/wake-consumer.ts"' '"../../bash-processes/extensions/wake-consumer.ts"'
          substituteInPlace extension/agent-definitions.ts \
            --replace-fail 'const BUILTIN_AGENT_DIR = fileURLToPath(
            new URL("./agent-definitions", import.meta.url),
          );' 'const BUILTIN_AGENT_DIR = "$out/extension/agent-definitions";'
        '';
    };
  };
in
recipes

{ pkgs, self }:
let
  lib = pkgs.lib;
  packageDirs = [
    "pi-bash-processes"
    "pi-cbmem"
    "pi-herdsman"
    "pi-jev"
    "pi-native-router"
    "pi-otel"
    "pi-output-policy"
    "pi-reqcap"
    "pi-tool-renderer"
  ];

  manifests = lib.genAttrs packageDirs (dir: lib.importJSON (self.outPath + "/${dir}/package.json"));
  versionsByName = lib.listToAttrs (
    map (dir: {
      name = manifests.${dir}.name;
      value = manifests.${dir}.version;
    }) packageDirs
  );

  normalizeWorkspaceRange =
    dependency: range:
    let
      version = versionsByName.${dependency} or (throw "Unknown workspace dependency: ${dependency}");
      suffix = lib.removePrefix "workspace:" range;
    in
    if suffix == "" || suffix == "*" then
      version
    else if suffix == "^" then
      "^${version}"
    else if suffix == "~" then
      "~${version}"
    else
      suffix;

  normalizeSection =
    section:
    lib.mapAttrs (
      dependency: range:
      if lib.isString range && lib.hasPrefix "workspace:" range then
        normalizeWorkspaceRange dependency range
      else
        range
    ) section;

  dependencySections = [
    "dependencies"
    "devDependencies"
    "optionalDependencies"
    "peerDependencies"
  ];

  normalizeManifest =
    manifest:
    lib.foldl' (
      current: section:
      if builtins.hasAttr section current then
        current // { ${section} = normalizeSection current.${section}; }
      else
        current
    ) manifest dependencySections;

  filenameFor =
    manifest:
    "${
      lib.removePrefix "@" (lib.replaceStrings [ "/" ] [ "-" ] manifest.name)
    }-${manifest.version}.tgz";

  packageFor =
    dir:
    let
      manifest = manifests.${dir};
      normalizedManifest = pkgs.writeText "${dir}-package.json" (
        builtins.toJSON (normalizeManifest manifest)
      );
      filename = filenameFor manifest;
    in
    pkgs.stdenvNoCC.mkDerivation {
      pname = "npm-${dir}";
      version = manifest.version;
      dontUnpack = true;
      nativeBuildInputs = [ pkgs.nodejs ];

      installPhase = ''
        runHook preInstall
        export HOME="$TMPDIR/home"
        export npm_config_cache="$TMPDIR/npm-cache"
        mkdir -p "$HOME" "$npm_config_cache"
        package="$TMPDIR/package"
        mkdir -p "$package"
        cp -R "${self.outPath}/${dir}/." "$package/"
        chmod -R u+w "$package"
        cp ${normalizedManifest} "$package/package.json"
        cd "$package"
        npm pack --ignore-scripts --pack-destination "$TMPDIR"
        mv "$TMPDIR/${filename}" "$out"
        runHook postInstall
      '';

      passthru = {
        inherit filename;
        packageName = manifest.name;
      };
    };

  packages = lib.genAttrs packageDirs packageFor;
  npmExtensions = pkgs.runCommand "pi-extensions-npm" { } ''
    mkdir -p "$out"
    ${lib.concatMapStringsSep "\n" (
      dir: "ln -s ${packages.${dir}} $out/${packages.${dir}.filename}"
    ) packageDirs}
  '';
in
packages // { npm-extensions = npmExtensions; }

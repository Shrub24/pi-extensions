#!/usr/bin/env node
// Regenerates each plugin's runtime dependency set under nix/locks/<plugin>/.
//
// A plugin's own manifest carries dev tooling and peers, which are not what it runs with. What it
// runs with is its `dependencies`; npm resolves those into a lock, and Pi-Bolt installs that lock
// into the plugin's node_modules. The projected manifest beside the lock is what importNpmLock
// reads, so the resolution and the declaration cannot disagree.
//
// `--check` regenerates and fails if a committed lock differs, which is how CI keeps them honest.
// Regeneration needs the registry; the build does not.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const locksRoot = join(root, "nix", "locks");
const check = process.argv.includes("--check");

const plugins = readdirSync(root, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name.startsWith("pi-"))
  .map((entry) => entry.name)
  .filter((name) => existsSync(join(root, name, "package.json")));

const generate = (name) => {
  const manifest = JSON.parse(readFileSync(join(root, name, "package.json"), "utf8"));
  const dependencies = manifest.dependencies ?? {};
  if (Object.keys(dependencies).length === 0) return null;

  const projected = {
    name: manifest.name,
    version: manifest.version,
    private: true,
    dependencies,
  };

  const workdir = mkdtempSync(join(tmpdir(), `${name}-lock-`));
  try {
    writeFileSync(join(workdir, "package.json"), `${JSON.stringify(projected, null, 2)}\n`);
    execFileSync("npm", ["install", "--package-lock-only", "--ignore-scripts"], {
      cwd: workdir,
      stdio: ["ignore", "ignore", "inherit"],
    });
    return {
      manifest: `${JSON.stringify(projected, null, 2)}\n`,
      lock: readFileSync(join(workdir, "package-lock.json"), "utf8"),
    };
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
};

const problems = [];
let written = 0;

for (const name of plugins) {
  const generated = generate(name);
  if (generated === null) continue;

  const directory = join(locksRoot, name);
  const files = { "package.json": generated.manifest, "package-lock.json": generated.lock };

  if (!check) {
    mkdirSync(directory, { recursive: true });
    for (const [file, content] of Object.entries(files)) writeFileSync(join(directory, file), content);
    written += 1;
    console.log(`${name}: nix/locks/${name}/ regenerated`);
    continue;
  }

  for (const [file, content] of Object.entries(files)) {
    const target = join(directory, file);
    if (!existsSync(target) || readFileSync(target, "utf8") !== content) {
      problems.push(
        `${name}: nix/locks/${name}/${file} does not match the current dependencies; run \`bun run nix:locks\``,
      );
    }
  }
}

if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}

console.log(
  check
    ? `${plugins.length} plugins checked: every lock matches its dependencies`
    : `${written} dependency sets written`,
);

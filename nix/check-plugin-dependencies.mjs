#!/usr/bin/env node
// Verifies that each plugin tree contains what its own lock installs, at those versions.
//
// The trees are the plugin packages built by nix/plugins.nix, so this checks our artefact: that the
// lock Pi-Bolt installed from actually reached the output. A nested entry in the lock
// (`node_modules/a/node_modules/b`) is checked at that path, so a dedupe that npm made is verified
// as written rather than assumed.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const expected = JSON.parse(process.env.expected ?? "{}");
const problems = [];
let checked = 0;

for (const [name, { tree, lock }] of Object.entries(expected)) {
  const { packages } = JSON.parse(readFileSync(lock, "utf8"));
  for (const [path, entry] of Object.entries(packages)) {
    if (path === "") continue;
    checked += 1;
    const manifest = join(tree, path, "package.json");
    if (!existsSync(manifest)) {
      problems.push(`${name}: ${path} is missing from the plugin tree`);
      continue;
    }
    const found = JSON.parse(readFileSync(manifest, "utf8")).version;
    if (found !== entry.version) {
      problems.push(`${name}: ${path} is ${found}, its lock installs ${entry.version}`);
    }
  }
}

if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}

console.log(
  `plugin trees match their locks: ${checked} packages over ${Object.keys(expected).length} plugins`,
);

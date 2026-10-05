import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  MAX_PRELOADED_SKILL_BYTES,
  resolveDefinitionSkills,
  resolveSkillValue,
  skillSearchPaths,
  type SkillSearchPath,
} from "./agent-skills.ts";

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `pi-herdsman-${prefix}-`));
}

function writeSkill(root: string, name: string, body: string): string {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(
    join(root, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: test skill\n---\n\n${body}\n`,
  );
  return join(root, name, "SKILL.md");
}

function roots(project: string, user: string): SkillSearchPath[] {
  return [
    { path: project, source: "project" },
    { path: user, source: "user" },
  ];
}

test("skill search paths put the project's roots before the user's", () => {
  const cwd = tempDir("cwd");
  const agentDir = tempDir("agent");
  const paths = skillSearchPaths({ cwd, agentDir });
  assert.deepEqual(
    paths.map((entry) => [entry.path, entry.source]),
    [
      [join(cwd, ".pi", "skills"), "project"],
      [join(cwd, ".agents", "skills"), "project"],
      [join(agentDir, "skills"), "user"],
      [join(homedir(), ".agents", "skills"), "user"],
    ],
  );
});

test("a bare skill name resolves inside a search root", () => {
  const cwd = tempDir("cwd");
  const project = tempDir("project-skills");
  const path = writeSkill(project, "codebase-explore", "Look first.");
  const resolved = resolveSkillValue("codebase-explore", {
    cwd,
    roots: roots(project, tempDir("user-skills")),
  });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.ok && resolved.skill.path, path);
  assert.equal(resolved.ok && resolved.skill.source, "project");
});

test("a project skill outranks a user skill of the same name", () => {
  const cwd = tempDir("cwd");
  const project = tempDir("project-skills");
  const user = tempDir("user-skills");
  const projectPath = writeSkill(project, "review-policy", "Project copy.");
  writeSkill(user, "review-policy", "User copy.");
  const resolved = resolveSkillValue("review-policy", {
    cwd,
    roots: roots(project, user),
  });
  assert.equal(resolved.ok && resolved.skill.path, projectPath);
  assert.equal(resolved.ok && resolved.skill.source, "project");
});

test("an explicit skill path passes through unchanged", () => {
  const cwd = tempDir("cwd");
  const root = tempDir("skills");
  const path = writeSkill(root, "local", "Local copy.");
  const resolved = resolveSkillValue(path, { cwd, roots: [] });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.ok && resolved.skill.path, path);
  assert.equal(resolved.ok && resolved.skill.source, "explicit");
});

test("a relative skill path resolves against the launch cwd", () => {
  const cwd = tempDir("cwd");
  const root = tempDir("skills");
  const path = writeSkill(root, "local", "Local copy.");
  const resolved = resolveSkillValue("./local/SKILL.md", {
    cwd: root,
    roots: [],
  });
  assert.equal(resolved.ok && resolved.skill.path, path);
});

test("an unknown skill name fails and names the roots searched", () => {
  const cwd = tempDir("cwd");
  const project = tempDir("project-skills");
  const resolved = resolveSkillValue("no-such-skill", {
    cwd,
    roots: roots(project, tempDir("user-skills")),
  });
  assert.equal(resolved.ok, false);
  assert.match(
    resolved.ok ? "" : resolved.reason,
    /names no skill under .*project-skills/,
  );
});

test("a missing explicit path fails", () => {
  const cwd = tempDir("cwd");
  const resolved = resolveSkillValue("./missing/SKILL.md", {
    cwd,
    roots: [],
  });
  assert.equal(resolved.ok, false);
  assert.match(resolved.ok ? "" : resolved.reason, /does not exist/);
});

test("a directory is not a skill file", () => {
  const cwd = tempDir("cwd");
  const dir = join(cwd, "not-a-file");
  mkdirSync(dir, { recursive: true });
  const resolved = resolveSkillValue(dir, { cwd, roots: [] });
  assert.equal(resolved.ok, false);
  assert.match(resolved.ok ? "" : resolved.reason, /is not a file/);
});

test("a package-declared skill resolves from an installed package", () => {
  const cwd = tempDir("cwd");
  const agentDir = tempDir("agent");
  const name = `packaged-${randomUUID().slice(0, 8)}`;
  const packageRoot = join(cwd, ".pi", "npm", "node_modules", "pi-tools");
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "pi-tools", pi: { skills: ["./skills"] } }),
  );
  writeSkill(join(packageRoot, "skills"), name, "Packaged method.");
  const resolved = resolveSkillValue(name, { cwd, agentDir });
  assert.equal(resolved.ok, true);
  assert.equal(
    resolved.ok && resolved.skill.path,
    join(packageRoot, "skills", name, "SKILL.md"),
  );
  assert.equal(resolved.ok && resolved.skill.source, "project-package");
});

test("a settings-declared skill root resolves", () => {
  const cwd = tempDir("cwd");
  const agentDir = tempDir("agent");
  const name = `declared-${randomUUID().slice(0, 8)}`;
  const extra = join(cwd, ".pi", "extra-skills");
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(
    join(cwd, ".pi", "settings.json"),
    JSON.stringify({ skills: ["./extra-skills"] }),
  );
  writeSkill(extra, name, "Settings method.");
  const resolved = resolveSkillValue(name, { cwd, agentDir });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.ok && resolved.skill.source, "project-settings");
});

test("a settings package declaration contributes its skills", () => {
  const cwd = tempDir("cwd");
  const agentDir = tempDir("agent");
  const name = `fromsettings-${randomUUID().slice(0, 8)}`;
  const packageRoot = join(cwd, ".pi", "npm", "node_modules", "declared-tools");
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "declared-tools", pi: { skills: ["./skills"] } }),
  );
  writeSkill(join(packageRoot, "skills"), name, "Declared method.");
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(
    join(cwd, ".pi", "settings.json"),
    JSON.stringify({ packages: ["npm:declared-tools"] }),
  );
  const resolved = resolveSkillValue(name, { cwd, agentDir });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.ok && resolved.skill.source, "project-package");
});

test("a project skill directory outranks a package skill of the same name", () => {
  const cwd = tempDir("cwd");
  const agentDir = tempDir("agent");
  const name = `ranked-${randomUUID().slice(0, 8)}`;
  const packageRoot = join(cwd, ".pi", "npm", "node_modules", "pi-tools");
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "pi-tools", pi: { skills: ["./skills"] } }),
  );
  writeSkill(join(packageRoot, "skills"), name, "Packaged copy.");
  const projectPath = writeSkill(
    join(cwd, ".pi", "skills"),
    name,
    "Project copy.",
  );
  const resolved = resolveSkillValue(name, { cwd, agentDir });
  assert.equal(resolved.ok && resolved.skill.path, projectPath);
  assert.equal(resolved.ok && resolved.skill.source, "project");
});

test("a malformed settings file contributes no roots", () => {
  const cwd = tempDir("cwd");
  const agentDir = tempDir("agent");
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "settings.json"), "{ not json");
  const name = `absent-${randomUUID().slice(0, 8)}`;
  const resolved = resolveSkillValue(name, { cwd, agentDir });
  assert.equal(resolved.ok, false);
  assert.match(resolved.ok ? "" : resolved.reason, /names no skill under/);
});

test("a preloaded skill carries its body without frontmatter", () => {
  const cwd = tempDir("cwd");
  const project = tempDir("project-skills");
  writeSkill(project, "lean-implementation", "Smallest coherent change.");
  const resolved = resolveDefinitionSkills({
    agent: "worker",
    preloadedSkills: ["lean-implementation"],
    cwd,
    roots: roots(project, tempDir("user-skills")),
  });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.ok && resolved.preloaded.length, 1);
  assert.equal(
    resolved.ok && resolved.preloaded[0]?.body,
    "Smallest coherent change.",
  );
  assert.equal(resolved.ok && resolved.advertised.length, 0);
});

test("a skill named in both fields is only preloaded", () => {
  const cwd = tempDir("cwd");
  const project = tempDir("project-skills");
  const path = writeSkill(project, "review-policy", "Review method.");
  writeSkill(project, "codebase-explore", "Look first.");
  const resolved = resolveDefinitionSkills({
    agent: "reviewer",
    skills: ["review-policy", "codebase-explore"],
    preloadedSkills: ["review-policy"],
    cwd,
    roots: roots(project, tempDir("user-skills")),
  });
  assert.equal(resolved.ok, true);
  assert.deepEqual(
    resolved.ok ? resolved.preloaded.map((skill) => skill.path) : [],
    [path],
  );
  assert.deepEqual(
    resolved.ok ? resolved.advertised : [],
    [join(project, "codebase-explore", "SKILL.md")],
  );
});

test("a value naming the same skill twice resolves once", () => {
  const cwd = tempDir("cwd");
  const project = tempDir("project-skills");
  const path = writeSkill(project, "scout", "Scout method.");
  const resolved = resolveDefinitionSkills({
    agent: "scout",
    skills: ["scout", path],
    cwd,
    roots: roots(project, tempDir("user-skills")),
  });
  assert.equal(resolved.ok, true);
  assert.deepEqual(resolved.ok ? resolved.advertised : [], [path]);
});

test("preloaded skills beyond the cap fail rather than truncate", () => {
  const cwd = tempDir("cwd");
  const project = tempDir("project-skills");
  writeSkill(project, "huge", "x".repeat(MAX_PRELOADED_SKILL_BYTES + 1));
  const resolved = resolveDefinitionSkills({
    agent: "worker",
    preloadedSkills: ["huge"],
    cwd,
    roots: roots(project, tempDir("user-skills")),
  });
  assert.equal(resolved.ok, false);
  assert.match(resolved.ok ? "" : resolved.reason, /exceed 65536 bytes/);
});

test("an unresolvable preloaded skill names the definition", () => {
  const cwd = tempDir("cwd");
  const resolved = resolveDefinitionSkills({
    agent: "worker",
    preloadedSkills: ["nope"],
    cwd,
    roots: roots(tempDir("project-skills"), tempDir("user-skills")),
  });
  assert.equal(resolved.ok, false);
  assert.match(resolved.ok ? "" : resolved.reason, /agent worker: preloadedSkills entry "nope"/);
});

test("a missing skill path fails the definition it belongs to", () => {
  const cwd = tempDir("cwd");
  const resolved = resolveDefinitionSkills({
    agent: "delegate",
    skills: ["./gone/SKILL.md"],
    cwd,
    roots: [],
  });
  assert.equal(resolved.ok, false);
  assert.match(resolved.ok ? "" : resolved.reason, /agent delegate: skills entry/);
});

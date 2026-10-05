/**
 * Skill resolution for agent definitions.
 *
 * A definition's `skills` and `preloadedSkills` values reach a child launch as
 * Pi arguments, so they are resolved here first. A value that names a file is
 * used as it is; a bare name is looked up against the same roots Pi and
 * pi-subagents search; a value that resolves to nothing fails the launch
 * instead of reaching Pi as a path that does not exist.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  parseFrontmatter,
} from "@earendil-works/pi-coding-agent";

export type SkillSource =
  | "project"
  | "user"
  | "project-package"
  | "user-package"
  | "project-settings"
  | "user-settings"
  | "explicit";

export type SkillSearchPath = { path: string; source: SkillSource };

export type ResolvedSkill = {
  value: string;
  path: string;
  source: SkillSource;
};

export type PreloadedSkill = ResolvedSkill & { body: string };

export type SkillResolution =
  | { ok: true; advertised: string[]; preloaded: PreloadedSkill[] }
  | { ok: false; reason: string };

export type SkillResolutionOptions = {
  cwd: string;
  agentDir?: string;
  roots?: SkillSearchPath[];
};

/** Total inlined skill content allowed for one launch. */
export const MAX_PRELOADED_SKILL_BYTES = 64 * 1024;

const SOURCE_PRIORITY: Record<SkillSource, number> = {
  project: 7,
  user: 6,
  "project-package": 5,
  "user-package": 4,
  "project-settings": 3,
  "user-settings": 2,
  explicit: 1,
};

/** Skill roots declared by an installed package's `pi.skills` manifest. */
function packageSkillPaths(
  packageRoot: string,
  source: SkillSource,
): SkillSearchPath[] {
  const manifest = readJsonFile(join(packageRoot, "package.json"));
  if (!isRecord(manifest)) return [];
  const pi = manifest.pi;
  if (!isRecord(pi) || !Array.isArray(pi.skills)) return [];
  return pi.skills
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => ({ path: resolve(packageRoot, entry), source }));
}

/** Every package installed under a `node_modules` root, including scoped ones. */
function installedPackageRoots(nodeModules: string): string[] {
  const entries = readDirectory(nodeModules);
  const roots: string[] = [];
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    if (!entry.startsWith("@")) {
      roots.push(join(nodeModules, entry));
      continue;
    }
    const scope = join(nodeModules, entry);
    for (const scoped of readDirectory(scope))
      if (!scoped.startsWith(".")) roots.push(join(scope, scoped));
  }
  return roots;
}

function installedPackageSkillPaths(
  projectConfigDir: string,
  agentDir: string,
): SkillSearchPath[] {
  return [
    { root: join(projectConfigDir, "npm", "node_modules"), source: "project-package" as const },
    { root: join(agentDir, "npm", "node_modules"), source: "user-package" as const },
  ].flatMap(({ root, source }) =>
    installedPackageRoots(root).flatMap((packageRoot) =>
      packageSkillPaths(packageRoot, source),
    ),
  );
}

/** The package root a settings `packages` source names, as pi-subagents resolves it. */
function settingsPackageRoot(source: string, base: string): string | undefined {
  const trimmed = source.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.startsWith("git:")) {
    const spec = trimmed.slice(4).replace(/^\/\//u, "");
    const [host, ...rest] = spec.split("/");
    return host !== undefined && rest.length > 0
      ? join(base, "git", host, ...rest)
      : undefined;
  }
  if (trimmed.startsWith("npm:")) {
    const name = trimmed.slice(4).trim();
    return name.length > 0
      ? join(base, "npm", "node_modules", name)
      : undefined;
  }
  const normalized = trimmed.startsWith("file:")
    ? trimmed.slice(5)
    : trimmed;
  if (normalized === "~") return homedir();
  if (normalized.startsWith("~/"))
    return join(homedir(), normalized.slice(2));
  if (isAbsolute(normalized)) return normalized;
  return resolve(base, normalized);
}

/** Skill roots a project or user `settings.json` declares. */
function settingsSkillPaths(
  projectConfigDir: string,
  agentDir: string,
): SkillSearchPath[] {
  const files = [
    { file: join(projectConfigDir, "settings.json"), base: projectConfigDir, scope: "project" as const },
    { file: join(agentDir, "settings.json"), base: agentDir, scope: "user" as const },
  ];
  return files.flatMap(({ file, base, scope }) => {
    const settings = readJsonFile(file);
    if (!isRecord(settings)) return [];
    const declared = Array.isArray(settings.skills)
      ? settings.skills
          .filter((entry): entry is string => typeof entry === "string")
          .map((entry) => ({
            path: entry.startsWith("~/")
              ? join(homedir(), entry.slice(2))
              : resolve(base, entry),
            source: `${scope}-settings` as SkillSource,
          }))
      : [];
    const packages = Array.isArray(settings.packages)
      ? settings.packages.flatMap((entry) => {
          const source =
            typeof entry === "string"
              ? entry
              : isRecord(entry) && typeof entry.source === "string"
                ? entry.source
                : undefined;
          const root =
            source === undefined ? undefined : settingsPackageRoot(source, base);
          return root === undefined
            ? []
            : packageSkillPaths(root, `${scope}-package` as SkillSource);
        })
      : [];
    return [...declared, ...packages];
  });
}

/**
 * The roots a bare skill name is looked up in, highest priority first:
 * the project's own skill directories, then the user's.
 */
export function skillSearchPaths(options: {
  cwd: string;
  agentDir?: string;
}): SkillSearchPath[] {
  const agentDir = options.agentDir ?? getAgentDir();
  const projectConfigDir = join(options.cwd, CONFIG_DIR_NAME);
  const roots: SkillSearchPath[] = [
    { path: join(projectConfigDir, "skills"), source: "project" },
    { path: join(options.cwd, ".agents", "skills"), source: "project" },
    { path: join(agentDir, "skills"), source: "user" },
    { path: join(homedir(), ".agents", "skills"), source: "user" },
    ...installedPackageSkillPaths(projectConfigDir, agentDir),
    ...packageSkillPaths(options.cwd, "project-package"),
    ...settingsSkillPaths(projectConfigDir, agentDir),
  ];
  const deduped = new Map<string, SkillSearchPath>();
  for (const root of roots) {
    const path = resolve(root.path);
    const existing = deduped.get(path);
    if (
      existing === undefined ||
      SOURCE_PRIORITY[root.source] > SOURCE_PRIORITY[existing.source]
    )
      deduped.set(path, { path, source: root.source });
  }
  return [...deduped.values()];
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Best-effort JSON read: a missing or malformed file contributes no roots. */
function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function readDirectory(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

/** The skill file a name maps to inside a root. */
function skillFileIn(root: string, name: string): string | undefined {
  return [join(root, name, "SKILL.md"), join(root, `${name}.md`)].find(isFile);
}

function looksLikePath(value: string): boolean {
  return (
    isAbsolute(value) ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith("~") ||
    value.includes("/") ||
    value.includes("\\")
  );
}

function expandHome(value: string): string {
  if (value === "~") return homedir();
  return value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
}

function sourceForPath(
  path: string,
  roots: SkillSearchPath[],
): SkillSource {
  for (const root of roots)
    if (path === root.path || path.startsWith(`${root.path}/`))
      return root.source;
  return "explicit";
}

/**
 * Resolve one `skills` or `preloadedSkills` value.
 *
 * A value that looks like a path is used as it is and must exist. Anything else
 * is a skill name and must be found in one of the search roots.
 */
export function resolveSkillValue(
  value: string,
  options: SkillResolutionOptions,
): { ok: true; skill: ResolvedSkill } | { ok: false; reason: string } {
  const trimmed = value.trim();
  if (trimmed.length === 0) return { ok: false, reason: "is empty" };
  const roots = options.roots ?? skillSearchPaths(options);
  if (looksLikePath(trimmed)) {
    const path = resolve(options.cwd, expandHome(trimmed));
    if (!existsSync(path))
      return { ok: false, reason: `is a path that does not exist: ${path}` };
    if (!isFile(path)) return { ok: false, reason: `is not a file: ${path}` };
    return {
      ok: true,
      skill: { value: trimmed, path, source: sourceForPath(path, roots) },
    };
  }
  for (const root of roots) {
    const path = skillFileIn(root.path, trimmed);
    if (path !== undefined)
      return { ok: true, skill: { value: trimmed, path, source: root.source } };
  }
  return {
    ok: false,
    reason: `names no skill under ${roots.map((root) => root.path).join(", ")}`,
  };
}

/** A skill's body with its frontmatter removed. */
export function readSkillBody(
  skill: ResolvedSkill,
): { ok: true; body: string } | { ok: false; reason: string } {
  let content: string;
  try {
    content = readFileSync(skill.path, "utf8").replace(/^\uFEFF/u, "");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `cannot be read: ${message}` };
  }
  try {
    return { ok: true, body: parseFrontmatter<Record<string, unknown>>(content).body };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `has invalid frontmatter: ${message}` };
  }
}

/**
 * Resolve every skill a definition names.
 *
 * A skill named in both fields is preloaded and dropped from the advertised
 * list, because advertising a skill whose text is already in the prompt only
 * spends tokens.
 */
export function resolveDefinitionSkills(input: {
  agent: string;
  skills?: string[];
  preloadedSkills?: string[];
  cwd: string;
  agentDir?: string;
  roots?: SkillSearchPath[];
}): SkillResolution {
  const options: SkillResolutionOptions = {
    cwd: input.cwd,
    ...(input.agentDir !== undefined ? { agentDir: input.agentDir } : {}),
    ...(input.roots !== undefined ? { roots: input.roots } : {}),
  };
  const preloaded: PreloadedSkill[] = [];
  const advertised: string[] = [];
  let bytes = 0;

  for (const value of input.preloadedSkills ?? []) {
    const resolved = resolveSkillValue(value, options);
    if (!resolved.ok)
      return {
        ok: false,
        reason: `agent ${input.agent}: preloadedSkills entry ${JSON.stringify(value)} ${resolved.reason}`,
      };
    if (preloaded.some((skill) => skill.path === resolved.skill.path)) continue;
    const body = readSkillBody(resolved.skill);
    if (!body.ok)
      return {
        ok: false,
        reason: `agent ${input.agent}: preloadedSkills entry ${JSON.stringify(value)} ${body.reason}`,
      };
    bytes += Buffer.byteLength(body.body, "utf8");
    if (bytes > MAX_PRELOADED_SKILL_BYTES)
      return {
        ok: false,
        reason: `agent ${input.agent}: preloaded skills exceed ${MAX_PRELOADED_SKILL_BYTES} bytes`,
      };
    preloaded.push({ ...resolved.skill, body: body.body });
  }

  for (const value of input.skills ?? []) {
    const resolved = resolveSkillValue(value, options);
    if (!resolved.ok)
      return {
        ok: false,
        reason: `agent ${input.agent}: skills entry ${JSON.stringify(value)} ${resolved.reason}`,
      };
    if (preloaded.some((skill) => skill.path === resolved.skill.path)) continue;
    if (advertised.includes(resolved.skill.path)) continue;
    advertised.push(resolved.skill.path);
  }

  return { ok: true, advertised, preloaded };
}

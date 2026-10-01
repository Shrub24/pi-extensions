/**
 * A model of Pi's tool registry and prompt-assembly rules, taken from the
 * installed host (`_refreshToolRegistry` and `buildRules` in
 * `@earendil-works/pi-coding-agent`).
 *
 * It exists because the thing a mode's surface has to be judged on is not the
 * TypeBox literal a tool was registered with: it is what ends up in
 * `getAllTools()`, in `getActiveTools()`, and in the assembled prompt. Pi
 * activates a newly registered tool through the ordinary registration path
 * unless an allowlist exists, and it builds both the "Available tools" list and
 * the Guidelines section from the ACTIVE tools only:
 *
 *   - `_refreshToolRegistry`: with an allowlist, only an allowlisted registered
 *     name activates; without one, a name that was not already activated on
 *     registration and is declarable activates; previously active names are kept
 *     so a narrowing `setActiveTools` survives later registrations; an excluded
 *     name is filtered out of the registry entirely.
 *   - `buildSystemPromptSections`/`buildRules`: `selectedTools` (the active set)
 *     drives both `toolSnippets` and `toolGuidelines`.
 *
 * Real behaviour is confirmed on a real boot in the fresh-host check; this is the
 * deterministic model the fixtures and the surface tests assert against.
 */
export interface SurfaceTool {
	name: string;
	description?: string;
	/** One-line "Available tools" snippet Pi shows for an active tool. */
	promptSnippet?: string;
	/** Guideline bullets Pi appends while this tool is active. */
	promptGuidelines?: string[];
	/** How the model reaches the tool. Default: `"direct"`. */
	exposure?: string;
	/** Pi's `defaultActive === false` opt-out from activation on registration. */
	defaultActive?: boolean;
	parameters?: unknown;
}

export interface ToolRegistry {
	register(tool: SurfaceTool): void;
	getActiveTools(): string[];
	getAllTools(): SurfaceTool[];
	setActiveTools(names: string[]): void;
	refresh(): void;
	/** The model-visible prompt surface: active tools' snippets and guidelines. */
	systemPromptSurface(): { availableTools: string[]; guidelines: string[] };
}

export interface ToolRegistryOptions {
	/** An explicit allowlist, as `--tools` or a configured selection supplies. */
	activeTools?: string[];
	/** An explicit exclusion, as a configured disabled-tools entry supplies. */
	excludedTools?: string[];
}

export function createToolRegistry(options: ToolRegistryOptions = {}): ToolRegistry {
	const tools = new Map<string, SurfaceTool>();
	const active = new Set<string>();
	const allowed = options.activeTools ? new Set(options.activeTools) : undefined;
	const excluded = options.excludedTools ? new Set(options.excludedTools) : undefined;
	const isAllowed = (name: string) => (!allowed || allowed.has(name)) && !excluded?.has(name);
	const isDeclarable = (tool: SurfaceTool) => (tool.exposure ?? "direct") === "direct" || tool.exposure === "model-only";
	const activatedOnRegistration = (tool: SurfaceTool) => isDeclarable(tool) && tool.defaultActive !== false;

	// Pi computes "already activated on registration" from the registry as it
	// stood BEFORE the current registration, so the set is carried across
	// refreshes rather than recomputed from the post-registration registry.
	let previouslyActivated = new Set<string>();
	const refresh = (): void => {
		const previous = new Set(active);
		const next = new Set([...previous].filter((name) => tools.has(name) && isAllowed(name)));
		if (allowed) {
			for (const [name, tool] of tools) {
				if (allowed.has(name) && isAllowed(name) && isDeclarable(tool)) next.add(name);
			}
		} else {
			for (const [name, tool] of tools) {
				if (!previouslyActivated.has(name) && activatedOnRegistration(tool) && isAllowed(name)) next.add(name);
			}
		}
		active.clear();
		for (const name of next) active.add(name);
		previouslyActivated = new Set([...tools.keys()].filter((name) => activatedOnRegistration(tools.get(name)!)));
	};

	return {
		register(tool) {
			tools.set(tool.name, tool);
			refresh();
		},
		getActiveTools: () => [...active],
		// An excluded name is filtered out of the definition registry itself, so it
		// is neither declared nor listed — a user's exclusion is honoured, not
		// merely left inactive.
		getAllTools: () => [...tools.values()].filter((tool) => isAllowed(tool.name)),
		setActiveTools(names) {
			active.clear();
			for (const name of names) if (tools.has(name) && isAllowed(name)) active.add(name);
		},
		refresh,
		systemPromptSurface() {
			const names = [...active];
			return {
				availableTools: names
					.map((name) => ({ name, snippet: tools.get(name)?.promptSnippet }))
					.filter((entry): entry is { name: string; snippet: string } => Boolean(entry.snippet))
					.map(({ name, snippet }) => `${name}: ${snippet}`),
				guidelines: names.flatMap((name) => tools.get(name)?.promptGuidelines ?? []),
			};
		},
	};
}

/**
 * Every string a registered tool's parameter schema puts in front of the model:
 * property names, descriptions and enum members. Pi sends the declared schema
 * with the tool, so a description may not recommend an action the same schema
 * does not declare.
 */
export function declaredSchemaText(tool: SurfaceTool): string {
	const chunks: string[] = [];
	const walk = (value: unknown, depth: number): void => {
		if (depth > 6 || value == null) return;
		if (typeof value === "string") {
			chunks.push(value);
			return;
		}
		if (Array.isArray(value)) {
			for (const entry of value) walk(entry, depth + 1);
			return;
		}
		if (typeof value === "object") {
			for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
				chunks.push(key);
				walk(entry, depth + 1);
			}
		}
	};
	walk(tool.parameters, 0);
	return chunks.join("\n");
}

/**
 * The `action` enum a registered tool actually declares. `StringEnum` produces
 * `{ type: "string", enum: [...] }`; a hand-built `Type.Union` of literals
 * serializes as `anyOf: [{ const }]`. Both spell the same declaration, so both
 * are read.
 */
export function declaredActionEnum(tool: SurfaceTool): string[] | null {
	const action = (tool.parameters as { properties?: { action?: { enum?: unknown[]; anyOf?: { const?: unknown }[] } } } | undefined)
		?.properties?.action;
	const fromEnum = action?.enum?.filter((entry): entry is string => typeof entry === "string");
	if (fromEnum && fromEnum.length > 0) return fromEnum;
	const fromUnion = action?.anyOf?.map((entry) => entry.const).filter((entry): entry is string => typeof entry === "string");
	return fromUnion && fromUnion.length > 0 ? fromUnion : null;
}

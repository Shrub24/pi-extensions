import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { clearPackageConfigCache } from "./package-config.js";
import { invalidateRenderCaches } from "./settings-revision.js";

interface ToolExecutionUi {
	requestRender?: () => void;
}

interface TrackedToolExecutionComponent {
	invalidate?: () => void;
	ui?: ToolExecutionUi;
}

/** Pi's chat view owns each tool-execution component; this module only needs
 *  to reach the ones Pi still holds. A weak reference per component keeps a
 *  component Pi dropped collectable, and `trackedComponents` stops the same
 *  component taking a second reference on every render. */
let trackedComponents = new WeakSet<TrackedToolExecutionComponent>();
let componentRefs = new Set<WeakRef<TrackedToolExecutionComponent>>();
/** Reference count at which the next track call drops collected references.
 *  It doubles past the live count after each prune, so pruning stays amortized. */
const MIN_PRUNE_AT = 64;
let pruneAt = MIN_PRUNE_AT;

export function trackToolExecutionComponent(component: unknown): void {
	if (!component || typeof component !== "object") return;
	const tracked = component as TrackedToolExecutionComponent;
	if (trackedComponents.has(tracked)) return;
	trackedComponents.add(tracked);
	componentRefs.add(new WeakRef(tracked));
	if (componentRefs.size < pruneAt) return;
	pruneCollectedComponents();
	pruneAt = Math.max(MIN_PRUNE_AT, componentRefs.size * 2);
}

function pruneCollectedComponents(): void {
	for (const ref of componentRefs) {
		if (!ref.deref()) componentRefs.delete(ref);
	}
}

export function refreshToolExecutionComponents(): void {
	const userInterfaces = new Set<ToolExecutionUi>();
	for (const ref of componentRefs) {
		const component = ref.deref();
		if (!component) {
			componentRefs.delete(ref);
			continue;
		}
		if (component.ui) userInterfaces.add(component.ui);
		try {
			component.invalidate?.();
		} catch {
			// Ignore stale components left behind by a session transition.
		}
	}
	for (const ui of userInterfaces) {
		try {
			ui.requestRender?.();
		} catch {
			// Ignore stale TUI instances left behind by a session transition.
		}
	}
}

export function clearTrackedToolExecutionComponents(): void {
	trackedComponents = new WeakSet();
	componentRefs = new Set();
	pruneAt = MIN_PRUNE_AT;
}

export function installLiveSettingsRefresh(pi: ExtensionAPI): void {
	pi.on("session_start", () => {
		// Settings are file-managed: a change applies on the next read window, so
		// the lifecycle is the only point this process can be sure of a fresh
		// answer, and the tracked components are dropped with the session.
		clearPackageConfigCache();
		clearTrackedToolExecutionComponents();
	});
	pi.on("session_shutdown", () => {
		clearPackageConfigCache();
		clearTrackedToolExecutionComponents();
	});
}

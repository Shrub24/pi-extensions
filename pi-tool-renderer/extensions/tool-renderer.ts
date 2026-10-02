import { CompactionSummaryMessageComponent, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerToolBatch } from "./tool-renderer/batch.js";
import {
	installToolChromePatch,
	installToolExecutionRendererPatch,
	installWorkingIndicator,
	installWorkingLoaderAlignmentPatch,
	registerToolChromeEvents,
} from "./tool-renderer/chrome.js";
import {
	installAssistantMessageRenderer,
	installCompactionSummaryRenderer,
	installCustomMessageSpacingPatch,
	installMarkdownCodeBlockRenderer,
	installSkillInvocationRenderer,
	installUserMessageRenderer,
} from "./tool-renderer/messages.js";
import { installLiveSettingsRefresh } from "./tool-renderer/live-settings.js";
import { installSettingsCacheRefresh, recordProjectTrust } from "./tool-renderer/package-config.js";
import { settingBoolean } from "./tool-renderer/settings.js";
import { registerStackEvents } from "./tool-renderer/stack.js";
import { installIntentGuard } from "./tool-renderer/intent.js";
import { registerBashOnSessionStart, registerEdit, registerRead, registerReadOnly, registerWrite } from "./tool-renderer/tools.js";
import { installFffRenderers } from "./tool-renderer/fff-patch.js";
import { installCbmRenderers } from "./tool-renderer/cbm-patch.js";
import { installRenderDebugOnSessionStart, registerRenderDebugCommand } from "./tool-renderer/render-debug.js";

const INSTALL_SYMBOL = Symbol.for("kendex.pi-tool-renderer.installed");

export default async function toolRenderer(pi: ExtensionAPI): Promise<void> {
	const guard = pi as unknown as Record<PropertyKey, unknown>;
	if (guard[INSTALL_SYMBOL]) return;
	guard[INSTALL_SYMBOL] = true;
	if (!settingBoolean("enabled", true)) return;
	installSettingsCacheRefresh(pi);
	pi.on("session_start", (_event, ctx) => recordProjectTrust(ctx));

	registerStackEvents(pi);
	registerRenderDebugCommand(pi);
	installRenderDebugOnSessionStart(pi);
	installFffRenderers(pi);
	installCbmRenderers(pi);
	installToolExecutionRendererPatch(pi);
	installLiveSettingsRefresh(pi);
	installToolChromePatch();
	registerToolChromeEvents(pi);
	installWorkingLoaderAlignmentPatch();
	installWorkingIndicator(pi);
	installMarkdownCodeBlockRenderer(pi);
	installCompactionSummaryRenderer(pi, CompactionSummaryMessageComponent);

	const agent = await import("@earendil-works/pi-coding-agent");
	installUserMessageRenderer(pi, agent.UserMessageComponent);
	installAssistantMessageRenderer(pi, agent.AssistantMessageComponent);
	installCustomMessageSpacingPatch(pi, (agent as any).CustomMessageComponent);
	installSkillInvocationRenderer(pi, (agent as any).SkillInvocationMessageComponent);
	const cwd = process.cwd();
	// Every tool this package wraps carries the intent argument; the guard refuses
	// a model-issued call that omits a required one, and (as the package that
	// presents the root codemode row) a root codemode script without its purpose.
	// Together with `bash`/`bg_task` in pi-background-tasks, every intent-aware
	// tool is read from the same settings and refused in the same place.
	const intentTools: string[] = [];
	if (registerRead(pi, agent, cwd)) intentTools.push("read");
	registerBashOnSessionStart(pi, agent, cwd);
	if (settingBoolean("renderMutationTools", false, cwd)) {
		if (registerEdit(pi, agent, cwd)) intentTools.push("edit");
		if (registerWrite(pi, agent, cwd)) intentTools.push("write");
	}
	if (registerReadOnly(pi, agent, cwd, "grep")) intentTools.push("grep");
	if (registerReadOnly(pi, agent, cwd, "find")) intentTools.push("find");
	if (registerReadOnly(pi, agent, cwd, "ls")) intentTools.push("ls");
	if (settingBoolean("registerBatchTool", true, cwd) && registerToolBatch(pi, cwd)) intentTools.push("tool_batch");
	installIntentGuard(pi, { tools: intentTools, codemodePurpose: true });
}

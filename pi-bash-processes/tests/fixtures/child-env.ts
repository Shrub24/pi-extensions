// A spawned fixture must look like a fresh Pi session rather than a member of the
// developer's live one. Inheriting the ambient session identity lets a fixture
// child attach to a real background-task manager through `PI_BG_SOCKET`, which
// changes the timers, identities and shutdown rows these tests assert on — and
// makes the suite pass or fail depending on whether the developer happens to be
// running Pi with a live socket. Unsetting any single variable disables the
// attachment, so the whole session identity is removed rather than one name.
const SESSION_VARS = [
	"PI_BG_SOCKET",
	"PI_BG_SESSION",
	"PI_SESSION_ID",
	"PI_SESSION_FILE",
	"PI_INTERCOM_SESSION_ID",
	"HERDR_PANE_ID",
	"HERDR_TAB_ID",
	"HERDR_WORKSPACE_ID",
	"PI_HERDSMAN_RUN_ID",
	"PI_HERDSMAN_OWNER_SESSION_ID",
	"PI_HERDSMAN_LABEL",
	"PI_HERDSMAN_AGENT_DEFINITION",
];

export function fixtureChildEnv(
	overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = { ...process.env };
	for (const name of SESSION_VARS) delete env[name];
	return { ...env, ...overrides };
}

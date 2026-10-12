import { test } from "node:test";
import assert from "node:assert/strict";
import { radarDaemon, resetRadarState, WORKSPACE } from "./support.ts";
import { createRadarClient } from "./radar-client.ts";
import {
  radarLocalPane,
  resolveRadarProcessLocation,
  tmuxServerName,
} from "./radar-location.ts";

/**
 * A canonical observation of one pane, exactly as the tmux daemon reports it.
 *
 * These tests drive the real decoder over a real socket: the daemon's inventory
 * is the pinned canonical schema, and the fixture is only the transport.
 */
const SERVER = "work";
const PANE = `tmux:${SERVER}:%1`;
const TAB = `tmux:${SERVER}:@0`;
const WORKSPACE_HANDLE = `tmux:${SERVER}:$0`;

function fleetOf(options: {
  pane?: string;
  workspace?: string;
  tab?: string;
  extraPanes?: Array<{ workspace_id: string; tab_id: string; pane_id: string }>;
  tabs?: Array<{ tab_id: string; workspace_id: string }>;
  workspaces?: Array<{ workspace_id: string }>;
}) {
  const workspace = options.workspace ?? WORKSPACE_HANDLE;
  const tab = options.tab ?? TAB;
  return {
    workspaces: options.workspaces ?? [{ workspace_id: workspace }],
    tabs: options.tabs ?? [{ tab_id: tab, workspace_id: workspace }],
    panes: [
      {
        location: {
          workspace_id: workspace,
          tab_id: tab,
          pane_id: options.pane ?? PANE,
        },
      },
      ...(options.extraPanes ?? []).map((location) => ({ location })),
    ],
    agents: [],
  };
}

function client() {
  return createRadarClient();
}

/** This process sits in the tmux pane %1 of the daemon's own server. */
function resetEnvironment(): void {
  resetRadarState();
  delete process.env.TMUX_PANE;
  delete process.env.TMUX;
  delete process.env.PI_HERDSMAN_PARENT_PANE_ID;
  process.env.TMUX = `/tmp/tmux-1000/${SERVER},4242,0`;
  process.env.TMUX_PANE = "%1";
  radarDaemon.options.backend = "tmux";
  radarDaemon.options.instance = SERVER;
  radarDaemon.options.inventory = fleetOf({});
}

test("a pane the topology reports resolves with its own canonical containment", async () => {
  resetEnvironment();
  const resolution = await resolveRadarProcessLocation(client());
  assert.equal(resolution.state, "resolved", JSON.stringify(resolution));
  assert.deepEqual(resolution.state === "resolved" ? resolution.location : undefined, {
    backend: "tmux",
    instance: SERVER,
    workspace: WORKSPACE_HANDLE,
    tab: TAB,
    pane: PANE,
  });
});

test("a pane the topology does not report publishes no location", async () => {
  resetEnvironment();
  // The daemon answers, and its inventory is about other panes: this process's
  // own pane is missing, so the environment is not a substitute for topology.
  radarDaemon.options.inventory = fleetOf({ pane: `tmux:${SERVER}:%9` });
  const resolution = await resolveRadarProcessLocation(client());
  assert.equal(resolution.state, "pending", JSON.stringify(resolution));
  assert.match(resolution.state === "pending" ? resolution.reason : "", /%1/);
});

test("an unreadable topology publishes no location", async () => {
  resetEnvironment();
  radarDaemon.options.observeUnavailable = true;
  const resolution = await resolveRadarProcessLocation(client());
  assert.equal(resolution.state, "pending", JSON.stringify(resolution));
});

test("a pane reported twice is ambiguous and publishes no location", async () => {
  resetEnvironment();
  radarDaemon.options.inventory = fleetOf({
    extraPanes: [{ workspace_id: WORKSPACE_HANDLE, tab_id: TAB, pane_id: PANE }],
  });
  const resolution = await resolveRadarProcessLocation(client());
  assert.equal(resolution.state, "pending", JSON.stringify(resolution));
});

test("containment the tab row contradicts publishes no location", async () => {
  resetEnvironment();
  radarDaemon.options.inventory = fleetOf({
    tabs: [{ tab_id: TAB, workspace_id: "tmux:other:$0" }],
  });
  const resolution = await resolveRadarProcessLocation(client());
  assert.equal(resolution.state, "pending", JSON.stringify(resolution));
});

test("a process whose environment names no pane publishes no location by fact", async () => {
  resetEnvironment();
  delete process.env.TMUX_PANE;
  const resolution = await resolveRadarProcessLocation(client());
  assert.equal(resolution.state, "absent", JSON.stringify(resolution));
});

test("a daemon serving the herdr backend publishes no location by fact", async () => {
  resetEnvironment();
  radarDaemon.options.backend = "herdr";
  radarDaemon.options.instance = null;
  const resolution = await resolveRadarProcessLocation(client());
  assert.equal(resolution.state, "absent", JSON.stringify(resolution));
});

test("a child in the pane its launch was created beside publishes no location", async () => {
  resetEnvironment();
  process.env.PI_HERDSMAN_PARENT_PANE_ID = PANE;
  const resolution = await resolveRadarProcessLocation(client());
  assert.equal(resolution.state, "absent", JSON.stringify(resolution));
});

test("a tmux process attached to another server publishes no location by fact", async () => {
  resetEnvironment();
  process.env.TMUX = "/tmp/tmux-1000/other,4242,0";
  const resolution = await resolveRadarProcessLocation(client());
  assert.equal(resolution.state, "absent", JSON.stringify(resolution));
});

test("a tmux process whose own client names no server publishes no location by fact", async () => {
  resetEnvironment();
  delete process.env.TMUX;
  const resolution = await resolveRadarProcessLocation(client());
  assert.equal(resolution.state, "absent", JSON.stringify(resolution));
});

test("a tmux pane the daemon's topology does not report publishes no location", async () => {
  resetEnvironment();
  process.env.TMUX_PANE = "%99";
  const resolution = await resolveRadarProcessLocation(client());
  assert.equal(resolution.state, "pending", JSON.stringify(resolution));
});

test("a daemon serving no physical backend publishes no location by fact", async () => {
  resetEnvironment();
  radarDaemon.options.backend = "none";
  radarDaemon.options.instance = null;
  const resolution = await resolveRadarProcessLocation(client());
  assert.equal(resolution.state, "absent", JSON.stringify(resolution));
});

test("a daemon that does not answer leaves the location pending, not absent", async () => {
  resetEnvironment();
  // No daemon is listening on this path at all.
  process.env.RADAR_CONTROL_SOCKET = `${process.env.TMPDIR}/absent-radar.sock`;
  const resolution = await resolveRadarProcessLocation(client());
  assert.equal(resolution.state, "pending", JSON.stringify(resolution));
});

test("the local pane and server readers never guess", () => {
  assert.equal(radarLocalPane({ TMUX_PANE: "%3" }), "%3");
  assert.equal(radarLocalPane({ TMUX_PANE: "wA:p1" }), undefined);
  assert.equal(radarLocalPane({}), undefined);
  assert.equal(tmuxServerName({ TMUX: "/tmp/tmux-1000/work,1,0" }), "work");
  assert.equal(tmuxServerName({}), undefined);
});

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
 * A canonical observation of one pane, exactly as the daemon reports it.
 *
 * These tests drive the real decoder over a real socket: the daemon's inventory
 * is the pinned canonical schema, and the fixture is only the transport.
 */
function fleetOf(options: {
  pane: string;
  workspace?: string;
  tab?: string;
  extraPanes?: Array<{ workspace_id: string; tab_id: string; pane_id: string }>;
  tabs?: Array<{ tab_id: string; workspace_id: string }>;
  workspaces?: Array<{ workspace_id: string }>;
}) {
  const workspace = options.workspace ?? WORKSPACE;
  const tab = options.tab ?? `${workspace}:t1`;
  return {
    workspaces: options.workspaces ?? [{ workspace_id: workspace }],
    tabs: options.tabs ?? [{ tab_id: tab, workspace_id: workspace }],
    panes: [
      { location: { workspace_id: workspace, tab_id: tab, pane_id: options.pane } },
      ...(options.extraPanes ?? []).map((location) => ({ location })),
    ],
    agents: [],
  };
}

function client() {
  return createRadarClient();
}

function resetEnvironment(): void {
  resetRadarState();
  delete process.env.TMUX;
  delete process.env.TMUX_PANE;
  process.env.HERDR_ENV = "1";
  process.env.HERDR_PANE_ID = "registered-pane";
  process.env.HERDR_WORKSPACE_ID = WORKSPACE;
  process.env.HERDR_TAB_ID = `${WORKSPACE}:t1`;
  delete process.env.PI_HERDSMAN_PARENT_PANE_ID;
}

test("a pane the topology reports resolves with its own canonical containment", async () => {
  resetEnvironment();
  radarDaemon.options.inventory = fleetOf({ pane: "registered-pane" });
  const resolution = await resolveRadarProcessLocation(client());
  assert.equal(resolution.state, "resolved", JSON.stringify(resolution));
  assert.deepEqual(resolution.state === "resolved" ? resolution.location : undefined, {
    backend: "herdr",
    workspace: WORKSPACE,
    tab: `${WORKSPACE}:t1`,
    pane: "registered-pane",
  });
});

test("a pane the topology does not report publishes no location", async () => {
  resetEnvironment();
  // The daemon answers, and its inventory is about other panes: this process's
  // own pane is missing, so the environment is not a substitute for topology.
  radarDaemon.options.inventory = fleetOf({ pane: "some-other-pane" });
  const resolution = await resolveRadarProcessLocation(client());
  assert.equal(resolution.state, "pending", JSON.stringify(resolution));
  assert.match(resolution.state === "pending" ? resolution.reason : "", /registered-pane/);
});

test("an unreadable topology publishes no location", async () => {
  resetEnvironment();
  radarDaemon.options.observeUnavailable = true;
  const resolution = await resolveRadarProcessLocation(client());
  assert.equal(resolution.state, "pending", JSON.stringify(resolution));
});

test("a pane reported twice is ambiguous and publishes no location", async () => {
  resetEnvironment();
  const fleet = fleetOf({ pane: "registered-pane" });
  fleet.panes.push({
    location: {
      workspace_id: WORKSPACE,
      tab_id: `${WORKSPACE}:t1`,
      pane_id: "registered-pane",
    },
  });
  radarDaemon.options.inventory = fleet;
  const resolution = await resolveRadarProcessLocation(client());
  assert.equal(resolution.state, "pending", JSON.stringify(resolution));
});

test("containment the tab row contradicts publishes no location", async () => {
  resetEnvironment();
  radarDaemon.options.inventory = {
    workspaces: [{ workspace_id: WORKSPACE }],
    tabs: [{ tab_id: `${WORKSPACE}:t1`, workspace_id: "another-workspace" }],
    panes: [
      {
        location: {
          workspace_id: WORKSPACE,
          tab_id: `${WORKSPACE}:t1`,
          pane_id: "registered-pane",
        },
      },
    ],
    agents: [],
  };
  const resolution = await resolveRadarProcessLocation(client());
  assert.equal(resolution.state, "pending", JSON.stringify(resolution));
});

test("containment this process contradicts publishes no location", async () => {
  resetEnvironment();
  radarDaemon.options.inventory = fleetOf({
    pane: "registered-pane",
    workspace: "another-workspace",
    tab: "another-workspace:t9",
  });
  const resolution = await resolveRadarProcessLocation(client());
  assert.equal(resolution.state, "pending", JSON.stringify(resolution));
});

test("a process whose environment names no pane publishes no location by fact", async () => {
  resetEnvironment();
  delete process.env.HERDR_PANE_ID;
  radarDaemon.options.inventory = fleetOf({ pane: "registered-pane" });
  const resolution = await resolveRadarProcessLocation(client());
  assert.equal(resolution.state, "absent", JSON.stringify(resolution));
});

test("a process outside its backend's pane publishes no location by fact", async () => {
  resetEnvironment();
  // A Herdr-backed daemon, and a process that is not inside a Herdr pane.
  delete process.env.HERDR_ENV;
  delete process.env.HERDR_SOCKET_PATH;
  const resolution = await resolveRadarProcessLocation(client());
  assert.equal(resolution.state, "absent", JSON.stringify(resolution));
});

test("a child in the pane its launch was created beside publishes no location", async () => {
  resetEnvironment();
  process.env.PI_HERDSMAN_PARENT_PANE_ID = "registered-pane";
  radarDaemon.options.inventory = fleetOf({ pane: "registered-pane" });
  const resolution = await resolveRadarProcessLocation(client());
  assert.equal(resolution.state, "absent", JSON.stringify(resolution));
});

test("a tmux process qualifies its own pane with the daemon's server", async () => {
  resetEnvironment();
  process.env.TMUX = "/tmp/tmux-1000/work,4242,0";
  process.env.TMUX_PANE = "%3";
  delete process.env.HERDR_PANE_ID;
  delete process.env.HERDR_WORKSPACE_ID;
  delete process.env.HERDR_TAB_ID;
  radarDaemon.options.backend = "tmux";
  radarDaemon.options.instance = "work";
  radarDaemon.options.inventory = {
    workspaces: [{ workspace_id: "tmux:work:$0" }],
    tabs: [{ tab_id: "tmux:work:@0", workspace_id: "tmux:work:$0" }],
    panes: [
      {
        location: {
          workspace_id: "tmux:work:$0",
          tab_id: "tmux:work:@0",
          pane_id: "tmux:work:%3",
        },
      },
    ],
    agents: [],
  };
  const resolution = await resolveRadarProcessLocation(client());
  assert.equal(resolution.state, "resolved", JSON.stringify(resolution));
  assert.deepEqual(resolution.state === "resolved" ? resolution.location : undefined, {
    backend: "tmux",
    instance: "work",
    workspace: "tmux:work:$0",
    tab: "tmux:work:@0",
    pane: "tmux:work:%3",
  });
});

test("a tmux process attached to another server publishes no location by fact", async () => {
  resetEnvironment();
  process.env.TMUX = "/tmp/tmux-1000/other,4242,0";
  process.env.TMUX_PANE = "%3";
  delete process.env.HERDR_PANE_ID;
  radarDaemon.options.backend = "tmux";
  radarDaemon.options.instance = "work";
  const resolution = await resolveRadarProcessLocation(client());
  assert.equal(resolution.state, "absent", JSON.stringify(resolution));
});

test("a tmux process whose own client names no server publishes no location by fact", async () => {
  resetEnvironment();
  delete process.env.TMUX;
  process.env.TMUX_PANE = "%3";
  delete process.env.HERDR_PANE_ID;
  radarDaemon.options.backend = "tmux";
  radarDaemon.options.instance = "work";
  const resolution = await resolveRadarProcessLocation(client());
  assert.equal(resolution.state, "absent", JSON.stringify(resolution));
});

test("a tmux pane the daemon's topology does not report publishes no location", async () => {
  resetEnvironment();
  process.env.TMUX = "/tmp/tmux-1000/work,4242,0";
  process.env.TMUX_PANE = "%99";
  delete process.env.HERDR_PANE_ID;
  delete process.env.HERDR_WORKSPACE_ID;
  delete process.env.HERDR_TAB_ID;
  radarDaemon.options.backend = "tmux";
  radarDaemon.options.instance = "work";
  radarDaemon.options.inventory = {
    workspaces: [{ workspace_id: "tmux:work:$0" }],
    tabs: [{ tab_id: "tmux:work:@0", workspace_id: "tmux:work:$0" }],
    panes: [
      {
        location: {
          workspace_id: "tmux:work:$0",
          tab_id: "tmux:work:@0",
          pane_id: "tmux:work:%3",
        },
      },
    ],
    agents: [],
  };
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
  assert.equal(radarLocalPane({ TMUX_PANE: "%3" }, "tmux"), "%3");
  assert.equal(radarLocalPane({ TMUX_PANE: "wA:p1" }, "tmux"), undefined);
  assert.equal(radarLocalPane({ HERDR_PANE_ID: " wA:p1 " }, "herdr"), "wA:p1");
  assert.equal(radarLocalPane({}, "herdr"), undefined);
  assert.equal(tmuxServerName({ TMUX: "/tmp/tmux-1000/work,1,0" }), "work");
  assert.equal(tmuxServerName({}), undefined);
});

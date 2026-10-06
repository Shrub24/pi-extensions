// Throwaway live check for stage 2 of herdsman-child-command: the production
// quoting helper, the newline script fallback and the direct-launch call
// sequence against the installed Herdr CLI, in throwaway tabs this script
// creates and closes.
//
// Run: cd pi-herdsman && node ../.pi-herdsman/herdsman-child-command-smoke.mjs
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";

const run = promisify(execFile);
const { childLaunchLine, childLaunchPlan, resolveChildCommand, herdrAgentAlias } =
  await import(
    "/home/saurabhj/Projects/dev/custom/pi-extensions/pi-herdsman/extension/herdr.ts"
  );

const root = "/tmp/stage2-smoke";
mkdirSync(root, { recursive: true });
const log = (...parts) => console.log(...parts);

const herdr = async (args) => {
  try {
    const { stdout } = await run("herdr", args, { maxBuffer: 8 * 1024 * 1024 });
    return { ok: true, stdout, stderr: "" };
  } catch (error) {
    return {
      ok: false,
      stdout: String(error.stdout ?? ""),
      stderr: String(error.stderr ?? ""),
    };
  }
};
const payload = (result) => {
  try {
    return JSON.parse(result.stdout)?.result;
  } catch {
    return undefined;
  }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const workspace = process.env.HERDR_WORKSPACE_ID;
if (!workspace || !process.env.HERDR_ENV)
  throw new Error("run this from the Herdr-managed session");

const command = "/home/saurabhj/.nix-profile/bin/pi-bolt-child";
process.env.PI_HERDSMAN_CHILD_COMMAND = command;
const lookup = resolveChildCommand();
log("resolved:", JSON.stringify(lookup));
if (lookup.kind !== "resolved" || lookup.command !== command)
  throw new Error("the configured command did not resolve");

const created = [];
const createTab = async (label) => {
  const result = await herdr([
    "tab",
    "create",
    "--workspace",
    workspace,
    "--cwd",
    "/tmp",
    "--label",
    label,
    "--no-focus",
  ]);
  const value = payload(result);
  const paneId = value?.root_pane?.pane_id ?? value?.pane?.pane_id;
  if (!result.ok || !paneId)
    throw new Error(`tab create failed: ${result.stdout}${result.stderr}`);
  created.push({ tabId: value?.tab?.tab_id, paneId, label });
  return { tabId: value?.tab?.tab_id, paneId };
};

// The production code proves the pane is a shell before it types anything.
const waitForShell = async (paneId) => {
  const marker = `__PI_HERDSMAN_READY_${crypto.randomUUID()}__`;
  await herdr(["pane", "run", paneId, `echo ${marker}`]);
  const waited = await herdr([
    "pane",
    "wait-output",
    paneId,
    "--regex",
    `^${marker}$`,
    "--timeout",
    "10000",
  ]);
  if (!waited.ok) throw new Error(`shell readiness failed: ${waited.stderr}`);
};

// 1. The production line is byte-exact through the pane's own shell.
writeFileSync(
  `${root}/dump.sh`,
  '#!/bin/sh\nout="$1"; shift\n: > "$out"\nfor arg in "$@"; do printf "ARG[%s]\\n" "$arg" >> "$out"; done\nprintf "COUNT=%s\\n" "$#" >> "$out"\n',
  { mode: 0o755 },
);
const tricky = [
  "a b",
  'q"uote',
  "sq'uote",
  "k=v",
  "semi;echo SPLIT",
  "meta=$(echo INJECTED)",
  "back`tick`",
  "star*glob",
];
const argvLine = childLaunchLine(`${root}/dump.sh`, [`${root}/args.out`, ...tricky]);
const argvPane = await createTab("stage2-argv");
await waitForShell(argvPane.paneId);
const typed = await herdr(["pane", "run", argvPane.paneId, argvLine]);
if (!typed.ok) throw new Error(`pane run failed: ${typed.stderr}`);
await sleep(1500);
const observed = readFileSync(`${root}/args.out`, "utf8").trim().split("\n");
const expected = [...tricky.map((value) => `ARG[${value}]`), `COUNT=${tricky.length}`];
log("argv elements observed:", JSON.stringify(observed));
log("argv elements expected:", JSON.stringify(expected));
if (JSON.stringify(observed) !== JSON.stringify(expected))
  throw new Error("the quoted line did not reach the child argv exactly");
log("P4-live: production quoting is byte-exact in the real pane shell");

// 1b. A newline-bearing argument runs from a launch script: the pane receives
// one input line, the argv stays byte-exact, the script is retired once the
// child has read it, and the pane's shell is left usable.
const newlineArgs = ["a b", "nl1\nnl2", "after"];
const plan = childLaunchPlan(`${root}/dump.sh`, [
  `${root}/newline.out`,
  ...newlineArgs,
]);
if (/[\r\n]/.test(plan.line))
  throw new Error("the newline still reaches the pane as a second input line");
const newlinePane = await createTab("stage2-newline");
await waitForShell(newlinePane.paneId);
const typedNewline = await herdr([
  "pane",
  "run",
  newlinePane.paneId,
  plan.line,
]);
if (!typedNewline.ok)
  throw new Error(`pane run failed: ${typedNewline.stderr}`);
let newlineObserved;
for (let i = 0; i < 50 && newlineObserved === undefined; i++) {
  await sleep(100);
  if (existsSync(`${root}/newline.out`))
    newlineObserved = readFileSync(`${root}/newline.out`, "utf8");
}
const newlineExpected = `${newlineArgs
  .map((value) => `ARG[${value}]`)
  .join("\n")}\nCOUNT=${newlineArgs.length}\n`;
log("newline argv observed:", JSON.stringify(newlineObserved));
log("newline argv expected:", JSON.stringify(newlineExpected));
if (newlineObserved !== newlineExpected)
  throw new Error("the launch script did not reach the child argv exactly");
const scriptPath = plan.line.slice(1, -1);
plan.cleanup();
if (existsSync(scriptPath))
  throw new Error("the spent launch script was not retired");
// A pane left holding an unterminated command cannot answer this.
await waitForShell(newlinePane.paneId);
log(
  "P4-live: the newline argv is script-borne, byte-exact, retired, and the pane shell stays usable",
);

// 2. A real child, launched and verified exactly as the production path does.
const childPane = await createTab("stage2-child");
await waitForShell(childPane.paneId);
const childLine = childLaunchLine(lookup.command, [
  "--no-extensions",
  "-e",
  "builtin:mcp",
  "-e",
  "builtin:codemode",
  "--extension",
  "/home/saurabhj/.pi/agent/extensions/herdr-agent-state.ts",
]);
const launched = await herdr(["pane", "run", childPane.paneId, childLine]);
if (!launched.ok) throw new Error(`pane run failed: ${launched.stderr}`);
let record;
let polls = 0;
const deadline = Date.now() + 30_000;
while (Date.now() < deadline) {
  const result = await herdr(["agent", "get", childPane.paneId]);
  polls++;
  const agent = payload(result)?.agent;
  if (
    agent &&
    (agent.agent_session !== undefined ||
      ["idle", "working", "blocked", "done"].includes(agent.agent_status))
  ) {
    record = agent;
    break;
  }
  await sleep(200);
}
log(`P1-live: registration observed after ${polls} polls:`, JSON.stringify(record));
if (!record) throw new Error("the child never registered with Herdr");

const alias = herdrAgentAlias(workspace, "stage2-smoke", crypto.randomUUID());
const renamed = await herdr(["agent", "rename", childPane.paneId, alias]);
if (!renamed.ok) throw new Error(`agent rename failed: ${renamed.stderr}`);
const verified = payload(await herdr(["agent", "get", alias]))?.agent;
log("P2-live: alias verification:", JSON.stringify(verified));
if (verified?.name !== alias || verified.pane_id !== childPane.paneId)
  throw new Error("the child did not take the Herdsman alias");
const listed = payload(await herdr(["agent", "list"]))?.agents ?? [];
if (!listed.some((agent) => agent.name === alias))
  throw new Error("the aliased child is missing from agent list");
log("alias is addressable and listed");

// Cleanup: close only the tabs this script created and prove they are gone.
for (const item of created) {
  const closed = await herdr(["tab", "close", item.tabId]);
  log(`closed ${item.label} (${item.tabId}) ok=${closed.ok}`);
}
await sleep(500);
const remainingPanes = (
  payload(await herdr(["pane", "list", "--workspace", workspace]))?.panes ?? []
).filter((pane) => created.some((item) => item.paneId === pane.pane_id));
const remainingAgents = (
  payload(await herdr(["agent", "list"]))?.agents ?? []
).filter((agent) => agent.name === alias);
log("leftover panes:", JSON.stringify(remainingPanes));
log("leftover agents:", JSON.stringify(remainingAgents));
if (remainingPanes.length || remainingAgents.length)
  throw new Error("cleanup is incomplete");
log("SMOKE OK");

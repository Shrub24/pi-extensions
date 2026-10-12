import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import {
  assistantResultForSession,
  chiefTreeFooter,
  chiefTreeSelectedRow,
  candidateArgs,
  chiefTreeProbeSource,
  distinctPaneCount,
  parseToolSnapshots,
  chiefTreeBranchPlan,
  continuationResultsForPrompt,
  continuationSessionEvidence,
  correlatedContinuationTask,
  initialPromptForScenario,
  inspectPaneProcesses,
  isolatedEnv,
  listedPanes,
  nestedControlEnv,
  nestedHerdrApiSocketPath,
  nestedPaneInput,
  nestedPaneText,
  submitPaneCommand,
  parseSmokeArgs,
  formatSmokeFailure,
  savedSessionHeaderEvidence,
  isolatedSessionDetails,
  preparePi,
  resolveSmokeModel,
  runScenario,
} from "../scripts/smoke.mjs";

test("missing managed session file is not ready yet", async () => {
  const piSessions = await mkdtemp(join(tmpdir(), "pi-herdsman-smoke-"));
  try {
    assert.equal(
      await isolatedSessionDetails(
        { paths: { piSessions } },
        {
          agent_session: {
            kind: "path",
            value: join(piSessions, "pending.jsonl"),
          },
        },
      ),
      undefined,
    );
  } finally {
    await rm(piSessions, { recursive: true, force: true });
  }
});

test("saved-session evidence separates header identity from continuation task instruction", () => {
  const followup = "Continue this exact saved session.";
  const contents = [
    { type: "session", id: "actual-session" },
    {
      type: "message",
      message: { role: "user", content: followup },
    },
  ]
    .map((entry) => JSON.stringify(entry))
    .join("\n");

  assert.deepEqual(savedSessionHeaderEvidence(contents, "expected-session"), {
    expectedSessionId: "expected-session",
    actualSessionId: "actual-session",
    sessionHeaderFound: true,
    sessionIdMatches: false,
  });
  assert.deepEqual(
    continuationSessionEvidence(contents, "expected-session", followup),
    {
      sessionHeaderFound: true,
      sessionIdMatches: false,
      continuationTaskFound: true,
      taskInstructionFound: true,
    },
  );
  assert.equal(
    continuationSessionEvidence(
      contents,
      "actual-session",
      "missing instruction",
    ).taskInstructionFound,
    false,
  );
});

test("continuation task evidence accepts the paraphrased task only in child user text", () => {
  const task =
    "Recall the exact package name from your previous assignment; do not reread package.json. Return PI_HERDSMAN_CONTINUATION_SECOND.";
  const rootPrompt =
    "Without rereading package.json, return the remembered package name.";
  for (const [role, content, expected] of [
    [
      "user",
      `Assignment:\n${task.toLowerCase().replaceAll(" ", "\n")}\nEnd assignment.`,
      true,
    ],
    ["user", rootPrompt, false],
    ["assistant", task, false],
  ] as const) {
    const contents = [
      { type: "session", id: "saved-session" },
      {
        type: "message",
        message: {
          role,
          content,
        },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n");
    const evidence = continuationSessionEvidence(
      contents,
      "saved-session",
      task,
    );
    assert.equal(evidence.sessionIdMatches, true);
    assert.equal(evidence.taskInstructionFound, expected);
    assert.equal(
      continuationSessionEvidence(contents, "saved-session", null)
        .taskInstructionFound,
      false,
    );
  }
});

test("continuation task parser correlates tool call, successful session result and response ancestry", () => {
  const task = "Recall the exact package name; return SECOND.";
  const prompt = "Without rereading package.json...";
  const entries = [
    {
      type: "message",
      id: "prompt",
      message: { role: "user", content: prompt },
    },
    {
      type: "message",
      id: "call",
      parentId: "prompt",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "other-call",
            name: "agent_continue",
            arguments: { task: "wrong task" },
          },
          {
            type: "toolCall",
            id: "continue-call",
            name: "agent_continue",
            arguments: { session: "/saved/child.jsonl", task },
          },
        ],
      },
    },
    {
      type: "message",
      id: "tool-result",
      parentId: "call",
      message: {
        role: "toolResult",
        toolName: "agent_continue",
        toolCallId: "continue-call",
        details: { ok: true, action: "continue", session_id: "child" },
      },
    },
    {
      type: "message",
      id: "response",
      parentId: "tool-result",
      message: {
        role: "assistant",
        stopReason: "stop",
        content: "package SECOND",
      },
    },
  ];
  const encode = (value: unknown[]) =>
    value.map((entry) => JSON.stringify(entry)).join("\n");
  assert.equal(
    correlatedContinuationTask(encode(entries), "response", "child", prompt),
    task,
  );
  assert.equal(
    correlatedContinuationTask(
      encode(entries),
      "response",
      "wrong-child",
      prompt,
    ),
    null,
  );
  assert.equal(
    correlatedContinuationTask(
      encode(entries),
      "missing-response",
      "child",
      prompt,
    ),
    null,
  );
  assert.equal(
    correlatedContinuationTask(
      encode(entries),
      "response",
      "child",
      "another prompt",
    ),
    null,
  );
  for (const mutation of [
    (copy: any[]) => {
      copy[2].message.toolCallId = "missing-call";
    },
    (copy: any[]) => {
      copy[2].message.isError = true;
    },
    (copy: any[]) => {
      copy[2].message.details.ok = false;
    },
    (copy: any[]) => {
      copy[3].parentId = "prompt";
    },
    (copy: any[]) => {
      copy.splice(3, 0, {
        type: "message",
        id: "new-prompt",
        parentId: "tool-result",
        message: { role: "user", content: prompt },
      });
      copy[4].parentId = "new-prompt";
    },
    (copy: any[]) => {
      delete copy[1].message.content[1].arguments.task;
    },
    (copy: any[]) => {
      copy[1].message.content[1].arguments.task = " ";
    },
    (copy: any[]) => {
      copy[1].message.content[1].arguments.task = "x".repeat(16 * 1024 + 1);
    },
  ]) {
    const copy = structuredClone(entries);
    mutation(copy);
    assert.equal(
      correlatedContinuationTask(encode(copy), "response", "child", prompt),
      null,
    );
  }
  const child = encode([
    { type: "session", id: "wrong-child" },
    { type: "message", message: { role: "user", content: task } },
  ]);
  const evidence = continuationSessionEvidence(child, "child", task);
  assert.equal(evidence.sessionIdMatches, false);
  assert.equal(evidence.taskInstructionFound, true);
  assert.doesNotMatch(JSON.stringify(evidence), /wrong-child|Recall/);
  assert.equal(
    continuationSessionEvidence(child, "child", null).continuationTaskFound,
    false,
  );
});

test("smoke isolates nested Herdr routing and Pi paths", () => {
  const base = {
    HERDR_ENV: "1",
    HERDR_SOCKET_PATH: "/parent.sock",
    HERDR_CLIENT_SOCKET_PATH: "/parent-client.sock",
    HERDR_SESSION: "parent",
    HERDR_WORKSPACE_ID: "parent-workspace",
    HERDR_TAB_ID: "parent-tab",
    HERDR_PANE_ID: "parent-pane",
    HERDR_CONFIG_PATH: "/parent/config",
    XDG_CONFIG_HOME: "/parent/xdg-config",
    XDG_STATE_HOME: "/parent/xdg-state",
    PI_CODING_AGENT_DIR: "/parent/pi-agent",
    PI_CODING_AGENT_SESSION_DIR: "/parent/pi-sessions",
    KEEP_ME: "yes",
  };
  const paths = {
    herdrConfig: "/smoke/herdr.toml",
    xdgConfig: "/smoke/xdg-config",
    xdgState: "/smoke/xdg-state",
    piAgent: "/smoke/pi-agent",
    piSessions: "/smoke/pi-sessions",
  };
  const expected = {
    HERDR_ENV: "1",
    HERDR_CONFIG_PATH: paths.herdrConfig,
    XDG_CONFIG_HOME: paths.xdgConfig,
    XDG_STATE_HOME: paths.xdgState,
    PI_CODING_AGENT_DIR: paths.piAgent,
    PI_CODING_AGENT_SESSION_DIR: paths.piSessions,
    KEEP_ME: "yes",
  };
  assert.deepEqual(isolatedEnv(base, paths), expected);
  assert.deepEqual(nestedControlEnv(base, paths, "smoke-123"), {
    ...expected,
    HERDR_SESSION: "smoke-123",
  });
  assert.equal(base.HERDR_SESSION, "parent");
});

test("nested Herdr hashes the API socket while checking both socket limits", () => {
  const paths = { xdgConfig: "/tmp/xdg" };
  assert.equal(
    nestedHerdrApiSocketPath(paths, "smoke"),
    join(paths.xdgConfig, "herdr", "sessions", "smoke", "herdr.sock"),
  );
  const directory = join(paths.xdgConfig, "herdr", "sessions");
  const clientOnlyTooLong = "x".repeat(
    99 -
      Buffer.byteLength(join(directory, "herdr.sock")) -
      Buffer.byteLength(sep),
  );
  assert.ok(
    Buffer.byteLength(join(directory, clientOnlyTooLong, "herdr.sock")) + 1 <=
      100,
  );
  assert.throws(
    () => nestedHerdrApiSocketPath(paths, clientOnlyTooLong),
    /herdr-client\.sock path is too long/,
  );
});

test("smoke CLI parses scenarios and one-off model overrides", async () => {
  assert.deepEqual(parseSmokeArgs([]), {
    scenario: "core",
    model: undefined,
  });
  for (const scenario of ["core", "continuation", "chief-tree"])
    assert.equal(parseSmokeArgs([scenario]).scenario, scenario);
  assert.deepEqual(
    parseSmokeArgs(["chief-tree", "--model", "provider/model:high"]),
    {
      scenario: "chief-tree",
      model: "provider/model:high",
    },
  );
  assert.deepEqual(
    parseSmokeArgs(["--model", "provider/model:xhigh", "continuation"]),
    {
      scenario: "continuation",
      model: "provider/model:xhigh",
    },
  );
  assert.throws(() => parseSmokeArgs(["core", "extra"]));
  assert.throws(() => parseSmokeArgs(["--unknown"]));
  assert.throws(() => parseSmokeArgs(["wat"]), /unknown smoke scenario/);
  await assert.rejects(runScenario({}, "wat"), /unknown smoke scenario/);
});

test("smoke failure report separates stage from error details", () => {
  assert.equal(
    formatSmokeFailure(
      new TypeError("leave wait timed out"),
      "manager-leave-output-wait",
    ),
    "stage: manager-leave-output-wait\nerror: TypeError: leave wait timed out",
  );
});

test("smoke model override wins without reading Git config", async () => {
  assert.equal(
    await resolveSmokeModel(" provider/model:high ", async () => {
      throw new Error("Git config should not be read");
    }),
    "provider/model:high",
  );
  await assert.rejects(
    resolveSmokeModel("  ", async () => {
      throw new Error("Git config should not be read");
    }),
    /smoke --model must not be empty/,
  );
});

test("smoke model falls back to effective Git config", async () => {
  const model = await resolveSmokeModel(
    undefined,
    async (file, args, options) => {
      assert.equal(file, "git");
      assert.deepEqual(args, ["config", "--get", "pi-herdsman.smoke-model"]);
      assert.ok(options.cwd);
      return { stdout: "provider/model:xhigh\n", stderr: "", pid: 1 };
    },
  );
  assert.equal(model, "provider/model:xhigh");
});

test("smoke model requires configuration when no override exists", async () => {
  const missing = Object.assign(new Error("not found"), { code: 1 });
  await assert.rejects(
    resolveSmokeModel(undefined, async () => {
      throw missing;
    }),
    /git config --local pi-herdsman\.smoke-model/,
  );
});

test("smoke model propagates Git failures", async () => {
  const failure = Object.assign(new Error("invalid Git config"), { code: 3 });
  await assert.rejects(
    resolveSmokeModel(undefined, async () => {
      throw failure;
    }),
    (error) => error === failure,
  );
});

test("smoke auth resolves credentials from the configured model", async () => {
  const paths = {
    herdrConfig: "/smoke/herdr.toml",
    xdgConfig: "/smoke/xdg-config",
    xdgState: "/smoke/xdg-state",
    piAgent: "/smoke/pi-agent",
    piSessions: "/smoke/pi-sessions",
    authLink: "/smoke/pi-agent/auth.json",
  };
  const calls = [];
  const mechanism = await preparePi(
    paths,
    "provider/model:high",
    async (file, args) => {
      calls.push([file, args]);
      return { stdout: "", stderr: "", pid: 1 };
    },
  );
  assert.equal(mechanism, "ambient");
  assert.deepEqual(calls, [
    ["pi", ["auth", "check", "--model", "provider/model:high", "--no-refresh"]],
  ]);
});

test("chief-tree startup prompt creates one ordinary Lead branch for harness controls", () => {
  const prompt = initialPromptForScenario("chief-tree", {});
  assert.equal(prompt, "Reply exactly with PI_HERDSMAN_CHIEF_TREE_STARTUP.");
  assert.doesNotMatch(prompt, /\/chief|\/tree/i);
});

test("chief-tree requires a persisted post-Chief turn and targets the pre-Chief assistant branch", () => {
  const contents = [
    { type: "session", id: "session" },
    {
      type: "message",
      id: "startup-user",
      message: { role: "user", content: "startup prompt" },
    },
    {
      type: "message",
      id: "startup-answer",
      parentId: "startup-user",
      message: {
        role: "assistant",
        stopReason: "stop",
        content: "PI_HERDSMAN_CHIEF_TREE_STARTUP",
      },
    },
    {
      type: "custom",
      id: "chief-state",
      parentId: "startup-answer",
      customType: "pi-herdsman-chief-state",
    },
    {
      type: "message",
      id: "chief-user",
      parentId: "chief-state",
      message: { role: "user", content: "post-Chief prompt" },
    },
    {
      type: "custom",
      id: "turn-metadata",
      parentId: "chief-user",
      customType: "pi-usage",
    },
    {
      type: "message",
      id: "chief-answer",
      parentId: "turn-metadata",
      message: {
        role: "assistant",
        stopReason: "stop",
        content: "PI_HERDSMAN_CHIEF_TREE_POST_CHIEF",
      },
    },
  ]
    .map((entry) => JSON.stringify(entry))
    .join("\n");
  assert.deepEqual(
    chiefTreeBranchPlan(
      contents,
      "startup prompt",
      "PI_HERDSMAN_CHIEF_TREE_STARTUP",
      "post-Chief prompt",
      "PI_HERDSMAN_CHIEF_TREE_POST_CHIEF",
    ),
    { targetId: "startup-answer" },
  );

  const noPostChiefTurn = contents.split("\n").slice(0, 3).join("\n");
  assert.match(
    chiefTreeBranchPlan(
      noPostChiefTurn,
      "startup prompt",
      "PI_HERDSMAN_CHIEF_TREE_STARTUP",
      "post-Chief prompt",
      "PI_HERDSMAN_CHIEF_TREE_POST_CHIEF",
    ).error,
    /one completed Chief turn/,
  );
  const extraTurn = `${contents}\n${JSON.stringify({
    type: "message",
    id: "unexpected-answer",
    parentId: "chief-answer",
    message: { role: "assistant", stopReason: "stop", content: "" },
  })}`;
  assert.match(
    chiefTreeBranchPlan(
      extraTurn,
      "startup prompt",
      "PI_HERDSMAN_CHIEF_TREE_STARTUP",
      "post-Chief prompt",
      "PI_HERDSMAN_CHIEF_TREE_POST_CHIEF",
    ).error,
    /unexpected completed model turn/,
  );
  const extraPrompt = `${contents}\n${JSON.stringify({
    type: "message",
    id: "unexpected-user",
    parentId: "chief-answer",
    message: { role: "user", content: "unrequested prompt" },
  })}`;
  assert.match(
    chiefTreeBranchPlan(
      extraPrompt,
      "startup prompt",
      "PI_HERDSMAN_CHIEF_TREE_STARTUP",
      "post-Chief prompt",
      "PI_HERDSMAN_CHIEF_TREE_POST_CHIEF",
    ).error,
    /unexpected user prompt/,
  );
});

test("chief-tree selector locates the unique selected preview and reads the visible footer count", () => {
  assert.deepEqual(chiefTreeFooter("tree rows\n  (7/19)\n"), {
    selected: 7,
    total: 19,
  });
  assert.equal(chiefTreeFooter("tree rows\nnot a footer"), null);
  assert.equal(chiefTreeFooter("(0/0)"), null);
  assert.equal(
    chiefTreeSelectedRow(
      "    › ├─ • assistant: PI_HERDSMAN_CHIEF_TREE_STARTUP",
      "PI_HERDSMAN_CHIEF_TREE_STARTUP",
    ),
    true,
  );
  assert.equal(
    chiefTreeSelectedRow(
      "  │  › └─ assistant: PI_HERDSMAN_CHIEF_TREE_STARTUP",
      "PI_HERDSMAN_CHIEF_TREE_STARTUP",
    ),
    true,
  );
  assert.equal(
    chiefTreeSelectedRow(
      "    ├─ • assistant: PI_HERDSMAN_CHIEF_TREE_STARTUP",
      "PI_HERDSMAN_CHIEF_TREE_STARTUP",
    ),
    false,
  );
  assert.equal(
    chiefTreeSelectedRow(
      "› assistant: PI_HERDSMAN_CHIEF_TREE_POST_CHIEF",
      "PI_HERDSMAN_CHIEF_TREE_STARTUP",
    ),
    false,
  );
  assert.equal(
    chiefTreeSelectedRow(
      [
        "› assistant: PI_HERDSMAN_CHIEF_TREE_STARTUP",
        "› assistant: PI_HERDSMAN_CHIEF_TREE_STARTUP",
      ].join("\n"),
      "PI_HERDSMAN_CHIEF_TREE_STARTUP",
    ),
    false,
  );
});

test("nested pane input returns raw Herdr output and targets the exact isolated pane", async () => {
  const ctx = {
    paths: {
      herdrConfig: "/tmp/smoke/herdr.toml",
      xdgConfig: "/tmp/smoke/xdg-config",
      xdgState: "/tmp/smoke/xdg-state",
      piAgent: "/tmp/smoke/pi-agent",
      piSessions: "/tmp/smoke/pi-sessions",
    },
    sessionName: "pi-herdsman-smoke-test",
  };
  const rawOutput = { stdout: "pane input accepted", stderr: "", pid: 123 };
  const result = await nestedPaneInput(
    ctx,
    ["pane", "send-text", "w1:p2", "/chief"],
    async (file, args, options) => {
      assert.equal(file, "herdr");
      assert.deepEqual(args, ["pane", "send-text", "w1:p2", "/chief"]);
      assert.equal(options.env.HERDR_SESSION, ctx.sessionName);
      assert.equal(options.env.HERDR_SOCKET_PATH, undefined);
      assert.equal(options.env.HERDR_WORKSPACE_ID, undefined);
      return rawOutput;
    },
  );
  assert.equal(result, rawOutput);
});

test("nested pane text reads bounded Herdr stdout without JSON parsing", async () => {
  const ctx = {
    paths: {
      herdrConfig: "/tmp/smoke/herdr.toml",
      xdgConfig: "/tmp/smoke/xdg-config",
      xdgState: "/tmp/smoke/xdg-state",
      piAgent: "/tmp/smoke/pi-agent",
      piSessions: "/tmp/smoke/pi-sessions",
    },
    sessionName: "pi-herdsman-smoke-test",
  };
  const screen = "startup Lead branch\n>";
  const text = await nestedPaneText(
    ctx,
    "w1:p2",
    "visible",
    async (file, args, options) => {
      assert.equal(file, "herdr");
      assert.deepEqual(args, [
        "pane",
        "read",
        "w1:p2",
        "--source",
        "visible",
        "--lines",
        "120",
      ]);
      assert.equal(options.env.HERDR_SESSION, ctx.sessionName);
      return { stdout: screen, stderr: "", pid: 123 };
    },
  );
  assert.equal(text, screen);
});

test("pane commands submit literal text with one explicit Enter", async () => {
  const ctx = {
    paths: {
      herdrConfig: "/tmp/smoke/herdr.toml",
      xdgConfig: "/tmp/smoke/xdg-config",
      xdgState: "/tmp/smoke/xdg-state",
      piAgent: "/tmp/smoke/pi-agent",
      piSessions: "/tmp/smoke/pi-sessions",
    },
    sessionName: "pi-herdsman-smoke-test",
  };
  const calls = [];
  await submitPaneCommand(ctx, "w1:p2", "/chief", async (file, args) => {
    calls.push([file, args]);
    return { stdout: "", stderr: "", pid: 123 };
  });
  assert.deepEqual(calls, [
    ["herdr", ["pane", "send-text", "w1:p2", "/chief"]],
    ["herdr", ["pane", "send-keys", "w1:p2", "enter"]],
  ]);
});

test("Chief tree probe is opt-in, last in root extension order, and validates three tool snapshots", () => {
  const config = {
    candidateExtension: "/candidate/dist/index.js",
    herdrStateExtension: "/isolated/herdr-agent-state.ts",
    model: "provider/model:high",
  };
  assert.deepEqual(candidateArgs(config), [
    "--approve",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--extension",
    config.candidateExtension,
    "--extension",
    config.herdrStateExtension,
    "--model",
    config.model,
  ]);
  const args = candidateArgs({
    ...config,
    chiefTreeProbeExtension: "/isolated/chief-tree-tools.mjs",
  });
  assert.deepEqual(args.slice(args.indexOf("--extension")), [
    "--extension",
    config.candidateExtension,
    "--extension",
    config.herdrStateExtension,
    "--extension",
    "/isolated/chief-tree-tools.mjs",
    "--model",
    config.model,
  ]);
  const resultPath = "/tmp/pi-herdsman-smoke/chief-tree-tools.json";
  const source = chiefTreeProbeSource(resultPath);
  assert.match(source, /getActiveTools/);
  assert.match(source, /session_tree/);
  assert.match(source, /smoke-tools/);
  const snapshots = parseToolSnapshots(
    [
      '{"label":"lead","tools":["chief","agent"]}',
      '{"label":"chief","tools":["staff"]}',
      '{"label":"tree","tools":["staff"]}',
    ].join("\n"),
  );
  assert.deepEqual(snapshots.get("lead"), ["agent", "chief"]);
  assert.notDeepEqual(snapshots.get("chief"), snapshots.get("lead"));
  assert.deepEqual(snapshots.get("tree"), snapshots.get("chief"));
  assert.throws(() =>
    parseToolSnapshots(
      '{"label":"lead","tools":[]}\n{"label":"lead","tools":[]}',
    ),
  );
});

test("core requires the prompt-correlated root assistant marker, not root status", () => {
  const prompt = "delegate the task";
  const marker = "PI_HERDSMAN_SMOKE_OK pi-herdsman@0.16.0";
  const contents = [
    { type: "message", id: "user", message: { role: "user", content: prompt } },
    {
      type: "message",
      id: "answer",
      parentId: "user",
      message: { role: "assistant", stopReason: "stop", content: marker },
    },
  ]
    .map((entry) => JSON.stringify(entry))
    .join("\n");

  for (const status of ["idle", "done"])
    assert.equal(
      assistantResultForSession({ status, contents: "" }, prompt, marker),
      null,
    );
  assert.equal(
    assistantResultForSession({ contents }, prompt, marker)?.id,
    "answer",
  );
});

test("continuation accepts a prefixed marker only in the stopped response descended from its exact prompt", () => {
  const prompt = "continue the saved session";
  const marker = "PI_HERDSMAN_CONTINUATION_SECOND";
  const contents = [
    {
      type: "message",
      id: "other-user",
      message: { role: "user", content: "unrelated prompt" },
    },
    {
      type: "message",
      id: "other-answer",
      parentId: "other-user",
      message: {
        role: "assistant",
        stopReason: "stop",
        content: `pi-herdsman ${marker}`,
      },
    },
    {
      type: "message",
      id: "followup",
      message: { role: "user", content: prompt },
    },
    {
      type: "message",
      id: "response",
      parentId: "followup",
      message: {
        role: "assistant",
        stopReason: "stop",
        content: `pi-herdsman ${marker}`,
      },
    },
    {
      type: "message",
      id: "unfinished",
      parentId: "followup",
      message: { role: "assistant", stopReason: "toolUse", content: marker },
    },
  ]
    .map((entry) => JSON.stringify(entry))
    .join("\n");

  assert.deepEqual(
    continuationResultsForPrompt(contents, prompt, marker).map(
      (entry) => entry.id,
    ),
    ["response"],
  );
  assert.equal(assistantResultForSession({ contents }, prompt, marker), null);
});

test("core counts distinct non-root candidate processes without role labels", async () => {
  assert.equal(
    distinctPaneCount([
      { paneId: "same", pid: 1 },
      { paneId: "same", pid: 2 },
    ]),
    1,
  );
  assert.equal(
    distinctPaneCount([
      { paneId: "child", pid: 1 },
      { paneId: "scout", pid: 2 },
    ]),
    2,
  );
  const panes = listedPanes({
    result: {
      panes: [
        { pane_id: "root", definition: "lead" },
        { pane_id: "child-pane" },
        { pane_id: "grandchild-pane" },
        { pane_id: "unrelated-pane" },
      ],
    },
  });
  const response = {
    "child-pane": {
      process_info: {
        foreground_processes: [
          {
            pid: 11,
            argv: ["pi", "--extension", "/candidate/dist/index.js"],
          },
          { pid: 11, cmdline: "duplicate same process" },
        ],
      },
    },
    "grandchild-pane": {
      process_info: {
        foreground_processes: [
          {
            pid: 21,
            cmdline:
              "pi --extension /candidate/dist/index.js --extension /isolated/herdr-agent-state.ts",
          },
        ],
      },
    },
    "unrelated-pane": {
      process_info: {
        foreground_processes: [
          { pid: 31, cmdline: "pi --extension /unrelated/dist/index.js" },
        ],
      },
    },
  };
  const result = await inspectPaneProcesses(
    panes,
    "root",
    async (paneId) => response[paneId],
    "/candidate/dist/index.js",
  );
  assert.deepEqual(
    result.verified.map(({ paneId, pid }) => [paneId, pid]),
    [
      ["child-pane", 11],
      ["grandchild-pane", 21],
    ],
  );
  assert.equal(result.verified.length, 2);
  assert.ok(
    result.verified.every(
      (record) => !("identity" in record) && !("definition" in record),
    ),
  );
});

test("process evidence requires the candidate extension and excludes root pane", async () => {
  const result = await inspectPaneProcesses(
    ["root", "missing-extension", "missing-pane"],
    "root",
    async (paneId) => {
      if (paneId === "missing-pane") throw new Error("pane disappeared");
      return {
        process_info: {
          foreground_processes: [
            { pid: 42, cmdline: "pi --extension /unrelated/dist/index.js" },
          ],
        },
      };
    },
    "/candidate/dist/index.js",
  );
  assert.deepEqual(result.verified, []);
  assert.deepEqual(
    result.records.map(({ paneId, processMatch, error }) => [
      paneId,
      processMatch,
      error,
    ]),
    [
      ["missing-extension", false, null],
      ["missing-pane", false, "pane disappeared"],
    ],
  );
});

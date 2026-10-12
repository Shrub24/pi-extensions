import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveChildCommand } from "./child-command.ts";

test("the configured child command resolves or is refused", () => {
  const environment = globalThis.process.env;
  const previous = {
    command: environment.PI_HERDSMAN_CHILD_COMMAND,
    path: environment.PATH,
  };
  const directory = mkdtempSync(join(tmpdir(), "pi-herdsman-child-command-"));
  const executable = join(directory, "pi-bolt-child");
  writeFileSync(executable, "#!/bin/sh\n", { mode: 0o755 });
  const plain = join(directory, "not-executable");
  writeFileSync(plain, "", { mode: 0o644 });
  environment.PATH = directory;
  try {
    delete environment.PI_HERDSMAN_CHILD_COMMAND;
    assert.deepEqual(resolveChildCommand(), { kind: "unset" });
    environment.PI_HERDSMAN_CHILD_COMMAND = "";
    assert.deepEqual(resolveChildCommand(), { kind: "unset" });
    environment.PI_HERDSMAN_CHILD_COMMAND = executable;
    assert.deepEqual(resolveChildCommand(), {
      kind: "resolved",
      command: executable,
    });
    environment.PI_HERDSMAN_CHILD_COMMAND = "pi-bolt-child";
    assert.deepEqual(resolveChildCommand(), {
      kind: "resolved",
      command: executable,
    });
    for (const value of ["relative/child", plain, "not-a-command"]) {
      environment.PI_HERDSMAN_CHILD_COMMAND = value;
      const lookup = resolveChildCommand();
      assert.equal(lookup.kind, "invalid", value);
      assert.match(
        lookup.kind === "invalid" ? lookup.reason : "",
        /PI_HERDSMAN_CHILD_COMMAND/,
      );
    }
  } finally {
    if (previous.command === undefined)
      delete environment.PI_HERDSMAN_CHILD_COMMAND;
    else environment.PI_HERDSMAN_CHILD_COMMAND = previous.command;
    if (previous.path === undefined) delete environment.PATH;
    else environment.PATH = previous.path;
    rmSync(directory, { recursive: true, force: true });
  }
});

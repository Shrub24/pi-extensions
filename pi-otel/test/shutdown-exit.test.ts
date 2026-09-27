import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";

/**
 * A collector that accepts the connection and never responds keeps its socket
 * referenced, which keeps Node's event loop (and the whole pi process) alive
 * until the exporter's own — potentially much longer — request timeout fires.
 * Shutdown must abort in-flight exports at the configured budget so the
 * process exits by draining.
 *
 * This asserts on the child PROCESS exiting, not on a promise resolving:
 * the unit suites already cover the latter and cannot catch a blocked event
 * loop.
 */
test("a hanging collector cannot keep the process alive past the shutdown deadline", { timeout: 20_000 }, async () => {
  // Hanging OTLP receiver: accepts the request, drains the body, never responds.
  const server = createServer((req, res) => {
    req.resume();
    void res;
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;

  const child = spawn(
    process.execPath,
    ["--import", "jiti/register", "test/fixtures/shutdown-exit-child.mts"],
    {
      cwd: path.join(import.meta.dirname, ".."),
      env: { ...process.env, PI_OTEL_TEST_SINK_PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.on("data", (c: Buffer) => {
    stderr += c.toString("utf8");
  });

  const code = await new Promise<number | null>((resolve) => {
    const killer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(null);
    }, 10_000);
    child.on("exit", (c) => {
      clearTimeout(killer);
      resolve(c);
    });
  });

  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));

  assert.notEqual(
    code,
    null,
    `child process was still alive after 10s: the hanging export kept the event loop open. stderr: ${stderr}`,
  );
  assert.equal(code, 0, `child exited with an error. stderr: ${stderr}`);
});

import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PI_CODING_AGENT_DIR = join(
  tmpdir(),
  `pi-herdsman-test-${process.pid}`,
);

// The operator's own pi-bolt launcher exports the configured child command into
// every session, along with its worker extensions, so a gate run started from
// one would otherwise take the configured path in suites that assume the
// unconfigured one. Tests that exercise a configured path set the variable
// themselves.
delete process.env.PI_HERDSMAN_CHILD_COMMAND;
delete process.env.PI_HERDSMAN_CHILD_EXTENSIONS;

// An operator's live Herdsman data root must never become the test root: the
// config suite removes its root recursively, so an inherited value would delete
// live state. Suites that need a data root set PI_HERDSMAN_DATA_DIR themselves.
delete process.env.PI_HERDSMAN_DATA_DIR;

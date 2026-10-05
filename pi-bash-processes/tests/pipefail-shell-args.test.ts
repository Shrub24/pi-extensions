import { afterEach, expect, test } from "bun:test";

import { clearPackageConfigCache } from "../extensions/package-config.js";
import { pipefailShellArgs } from "../extensions/settings.js";

afterEach(() => clearPackageConfigCache());

test("bash and zsh get pipefail ahead of the shell's own args", () => {
	expect(pipefailShellArgs("/usr/bin/bash", ["-c"])).toEqual(["-o", "pipefail", "-c"]);
	expect(pipefailShellArgs("zsh", ["-c"])).toEqual(["-o", "pipefail", "-c"]);
});

test("a shell not known to accept -o pipefail is left alone", () => {
	expect(pipefailShellArgs("/bin/sh", ["-c"])).toEqual(["-c"]);
	expect(pipefailShellArgs("fish", ["-c"])).toEqual(["-c"]);
});

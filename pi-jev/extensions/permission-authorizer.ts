/*
 * pi-jev: semantic permission decisions from Jev, for the permission system's
 * authorizer chain.
 *
 * This file is the Pi entry point and nothing else: the wiring lives in
 * `wiring.ts`, where it can run against a fake bus, and the decision path lives
 * in `authorizer-runtime.ts`, where it runs against a fake judge. What is here
 * is the one line Pi calls.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { wirePermissionAuthorizer } from "./wiring.js";

export default function piJev(pi: ExtensionAPI): void {
	wirePermissionAuthorizer(pi);
}

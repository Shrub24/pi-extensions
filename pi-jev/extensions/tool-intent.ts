/*
 * pi-jev's second consumer: the intent nudge.
 *
 * Loaded separately from the permission link on purpose. A consumer is policy —
 * it names its questions, decides what the readings mean, and does something with
 * the result — so it registers, warns, and fails on its own. Both entries reach the
 * same core through the registry, which is what keeps one action's questions in
 * one request instead of two.
 *
 * This file is the Pi entry point and nothing else; the wiring lives in
 * `intent.ts`, where it runs against a fake bus.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { wireIntentConsumer } from "./intent.js";

export default function toolIntent(pi: ExtensionAPI): void {
	wireIntentConsumer(pi);
}

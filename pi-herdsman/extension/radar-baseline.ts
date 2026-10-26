import { fileURLToPath } from "node:url";

// Set by a build that stages pi-radar at a fixed path (nix/plugins.nix). A
// Bun-compiled executable cannot resolve packages from its own location, so the
// compiled build supplies the path rather than letting the lookup run.
const BUILD_BASELINE_PATH: string | undefined = undefined;

/**
 * The file a child loads for Radar's baseline: the pi-radar entry Pi discovers
 * itself, so its normal path deduplication still holds when a child also finds
 * it another way. Resolved on demand, never at module load: a throw there would
 * take the whole extension down before any launch, which is the failure a
 * compiled build without the override hit.
 *
 * Returns undefined when no path can be determined; a launch then refuses
 * rather than starting a child that cannot register.
 */
export function radarBaselineExtensionPath(): string | undefined {
  if (BUILD_BASELINE_PATH !== undefined) return BUILD_BASELINE_PATH;
  try {
    // pi-radar's `./client` export is dist/extension/radar-client.js; the
    // baseline entry is its sibling source file in the published package.
    return fileURLToPath(
      new URL("../../extension/baseline.ts", import.meta.resolve("pi-radar/client")),
    );
  } catch {
    return undefined;
  }
}

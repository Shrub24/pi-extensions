/**
 * Revision counter for render caches that key on settings.
 *
 * The renderer caches rendered lines per component (chrome, user-message cards)
 * because a frame that changes nothing else should not re-wrap the same text.
 * A settings edit is the one input those caches cannot see in their own keys:
 * the text, theme and width are all unchanged, but `toolChrome` or
 * `assistantMessageStyle` moved. So the revision is read into each cache entry
 * and `invalidateRenderCaches` bumps it from the settings-change listener.
 *
 * `package-config`'s own memo cannot serve here: it invalidates on a settings
 * *read*, which is exactly what a cached render never performs.
 */
let revision = 0;

export function renderSettingsRevision(): number {
	return revision;
}

export function invalidateRenderCaches(): void {
	revision++;
}

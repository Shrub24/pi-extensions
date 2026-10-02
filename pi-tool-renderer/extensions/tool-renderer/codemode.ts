import { codemodePurpose } from "./intent.js";

/**
 * Root codemode row presentation: the script's leading `// intent: ...` purpose
 * (see `parseCodemodePurpose`) is shown as the row's intent, in the same
 * `codemode — phrase` shape the other rows use for a declared intent.
 *
 * The native renderer keeps owning the row: this only attaches the purpose to
 * the title it already renders, so the code preview, the nested-call result
 * list, the output truncation and the script diagnostics stay Pi's. Nothing
 * here evaluates the script; the purpose comes from the leading comment only.
 */

interface TitleText {
	text: string;
	setText: (text: string) => void;
}

/** The row's title `Text`, when the native component still has one. */
function titleLine(component: any): TitleText | undefined {
	const children = Array.isArray(component?.children) ? component.children : undefined;
	const first = children?.[0];
	if (first && typeof first.setText === "function" && typeof first.text === "string") return first as TitleText;
	return undefined;
}

/** ` — phrase`, styled as the other rows' declared intent. */
function purposeSuffix(theme: any, purpose: string): string {
	return `${theme.fg("dim", " — ")}${theme.fg("accent", purpose)}`;
}

/**
 * Attach a codemode call's declared purpose to its rendered row. Returns the
 * native component unchanged when the script declared no purpose.
 */
export function attachCodemodePurpose(component: any, args: any, theme: any): any {
	const purpose = codemodePurpose(args);
	if (!purpose) return component;
	const suffix = purposeSuffix(theme, purpose);
	const title = titleLine(component);
	// An unrecognized row shape keeps Pi's row exactly as it is: the purpose is
	// still the script's first line, and guessing at another component's
	// internals would be worse than leaving the native presentation alone.
	if (!title) return component;
	title.setText(`${title.text}${suffix}`);
	return component;
}

/** Wrap Pi's native codemode call renderer with the purpose presentation. */
export function withCodemodePurpose(renderCall: (args: any, theme: any, context: any) => any) {
	return function renderCodemodeCallWithPurpose(this: any, args: any, theme: any, context: any): any {
		return attachCodemodePurpose(renderCall.call(this, args, theme, context), args, theme);
	};
}

/**
 * CC thinking rendering, aligned with CC v2.1.234.
 *
 * Collapsed thinking leaves no transcript line in CC: its only traces are the
 * spinner byline (`thought for Ns`, spinner.ts) and the collapsed group summary
 * (grouping.ts). pi's own hide path can't do that — hideThinkingBlock renders
 * one Text(hiddenThinkingLabel) row unconditionally, so even an empty label
 * leaves a blank row (the host wraps it in ANSI, defeating Text's empty-string
 * check).
 *
 * So this module owns the collapse on the expanded path:
 *   - hideThinkingBlock=false, so pi renders thinking through our transformer;
 *   - the transformer returns "" while collapsed, which Markdown renders as zero
 *     rows — collapsed thinking is truly invisible;
 *   - alt+t flips a module-level flag and calls setHiddenThinkingLabel, which
 *     makes the host rebuild every AssistantMessageComponent and the streaming
 *     one, re-running the transformer with the new state. (ctrl+t is
 *     host-reserved; ctrl+shift+t is taken by rpiv-todo.)
 *
 * The hidden label stays "": it is never rendered while hideThinkingBlock is
 * false, and if the setting is ever hand-edited back the fallback is a blank row
 * rather than a stray "Thinking..." line.
 *
 * That label is global — it rewrites every history component — so it must never
 * carry per-block data such as a duration. The live `thought for Xs` byline
 * belongs to spinner.ts.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { dim, italic } from "./palette.js";

const THINKING_TITLE = "∴ Thinking…";
/** Kept empty: CC has no collapsed-thinking line (see header). */
const HIDDEN_LABEL_THINKING = "";

/** Session-scoped: CC's transcript view is transient too. */
let thinkingExpanded = false;

/** Test hook / read by other modules. */
export function isThinkingExpanded(): boolean {
	return thinkingExpanded;
}

export function registerThinking(pi: ExtensionAPI): void {
	// --- 1. The collapse itself: empty while collapsed, titled body expanded --
	pi.registerMarkdownTransformer((markdown, { messageType }) => {
		if (messageType !== "assistant-thinking") return markdown;
		if (!thinkingExpanded) return "";
		const body = markdown.trim();
		if (!body) return markdown;
		// Title on its own line — prefixing the body's first line corrupts markdown
		// when the block starts with `# ` or `- `.
		return `${dim(italic(THINKING_TITLE))}\n\n${body}`;
	});

	// --- 2. Keep the global hidden label empty ----------------------------
	// pi resets the label to "Thinking..." on session invalidate, so re-assert it.
	const assertLabel = (ctx: { hasUI: boolean; ui: { setHiddenThinkingLabel?: (l: string) => void } }): void => {
		if (!ctx.hasUI) return;
		try {
			ctx.ui.setHiddenThinkingLabel?.(HIDDEN_LABEL_THINKING);
		} catch {
			/* older pi without setHiddenThinkingLabel */
		}
	};
	pi.on("session_start", async (_event, ctx) => assertLabel(ctx));
	pi.on("turn_start", async (_event, ctx) => assertLabel(ctx));

	// --- 3. Expand/collapse toggle ----------------------------------------
	const toggle = async (ctx: Parameters<Parameters<typeof pi.registerShortcut>[1]["handler"]>[0]) => {
		thinkingExpanded = !thinkingExpanded;
		if (!ctx.hasUI) return;
		try {
			// Same-value set: the host still walks every AssistantMessageComponent,
			// calls updateContent() and rebuilds the Markdown children, re-running the
			// transformer with the flipped state.
			ctx.ui.setHiddenThinkingLabel?.(HIDDEN_LABEL_THINKING);
		} catch {
			/* best-effort */
		}
		ctx.ui.notify(`Thinking: ${thinkingExpanded ? "expanded" : "hidden"}`, "info");
	};
	// Key choice: ctrl+t is app.thinking.toggle, which the host reserves for itself
	// and rejects for extensions; ctrl+shift+t loses to @juicesharp/rpiv-todo.
	// alt+t is free, and ESC-prefixed chords decode on every terminal. Note pi's
	// own ctrl+t still flips hideThinkingBlock — with our empty label that only
	// adds a blank row, and pressing it again undoes it.
	pi.registerShortcut("alt+t", {
		description: "Toggle thinking visibility (CC-style)",
		handler: toggle,
	});

	// The spinner-row thinking display (byline and abort fallback) is owned by
	// spinner.ts's 50ms repaint loop.
}

/**
 * Runtime patches on host classes. Remove once pi ships the same fixes.
 *
 * `AssistantMessageComponent` and `InteractiveMode` are public exports of
 * @earendil-works/pi-coding-agent, and pi's loader aliases that specifier to the
 * host's running module — so wrapping prototype methods here patches the live
 * classes the host renders with. No host files are modified.
 *
 * 1. AssistantMessageComponent.render — drop stray blank rows.
 *    updateContent predicts spacing from raw message data, so a thinking block
 *    that renders zero rows (our collapsed transformer) still earns a top
 *    Spacer; thinking+toolCall messages can leave several blank rows in a row.
 *    An all-blank render becomes []; a run of leading blanks collapses to one
 *    (the first row may carry the OSC133 copy-zone mark).
 *
 * 2. InteractiveMode.showStatus — drop the exact "Tool output: expanded |
 *    collapsed" notice. showStatus appends a permanent row to the transcript,
 *    while CC's ctrl+o leaves no trace: the expansion is the feedback.
 *
 * Both wrappers delegate to the original and are Symbol-flag guarded, so they
 * stay idempotent across reloads and multiple extension instances.
 */
import { AssistantMessageComponent, InteractiveMode } from "@earendil-works/pi-coding-agent";

// CSI + OSC (BEL or ST terminated) + charset selects. OSC matters because the
// host wraps a message's first/last row in OSC133 zone marks, which the
// all-blank check must see through.
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][AB0]/g;

function isBlankRow(line: unknown): boolean {
	return typeof line === "string" && line.replace(ANSI_RE, "").trim() === "";
}

const BLANK_RENDER_FLAG = Symbol.for("pi-claude-tui:assistant-blank-render");
const STATUS_FLAG = Symbol.for("pi-claude-tui:tool-output-status");

/** The host notice dropped by patch 2 (interactive-mode.js setToolsExpanded). */
const TOOL_OUTPUT_STATUS_RE = /^Tool output: (?:expanded|collapsed)$/;

/**
 * The prototype surface the patches touch. They reach past the classes' own
 * types (one member is `private` in the host), so they go through this narrow
 * structural view instead of `any`; the symbol index carries the idempotence
 * flags.
 */
interface HostPrototype {
	render?: (this: unknown, width: number) => string[];
	showStatus?: (this: unknown, message: unknown) => unknown;
	[key: symbol]: unknown;
}

export function installHostPatches(): void {
	const amProto = AssistantMessageComponent.prototype as unknown as HostPrototype;
	if (!amProto[BLANK_RENDER_FLAG] && typeof amProto.render === "function") {
		const originalRender = amProto.render;
		amProto.render = function ccUiBlankMessageRender(this: unknown, width: number): string[] {
			const lines = originalRender.call(this, width);
			if (!Array.isArray(lines) || lines.length === 0) return lines;
			let blank = 0;
			while (blank < lines.length && isBlankRow(lines[blank])) blank++;
			if (blank === lines.length) return [];
			// Collapse leading blanks but keep lines[0] — it may carry the OSC133
			// zone-start mark.
			if (blank > 1) lines.splice(1, blank - 1);
			return lines;
		};
		amProto[BLANK_RENDER_FLAG] = true;
	}

	const imProto = InteractiveMode.prototype as unknown as HostPrototype;
	if (!imProto[STATUS_FLAG] && typeof imProto.showStatus === "function") {
		const originalShowStatus = imProto.showStatus;
		imProto.showStatus = function ccUiFilteredShowStatus(this: unknown, message: unknown): unknown {
			if (typeof message === "string" && TOOL_OUTPUT_STATUS_RE.test(message)) return undefined;
			return originalShowStatus.call(this, message);
		};
		imProto[STATUS_FLAG] = true;
	}
}

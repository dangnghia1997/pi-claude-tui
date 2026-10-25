/**
 * Context-window meter for the CC status line.
 *
 * CC keeps its gauge textual (`Context left until auto-compact: N%` in the
 * transcript, a dim `ctx` read-out in the bar); pi's footer prints `34.2%/200k`.
 * A bare percentage is easy to miss until auto-compact fires, so this draws the
 * same budget as a meter: `ctx ████▌░░░░░ 45%`.
 *
 * The bar uses block elements rather than a CC glyph — CC has no meter to copy,
 * and the block fill survives every terminal pi targets. Filled cells carry a
 * level color and the empty track stays dim, so headroom reads at a glance.
 *
 * Layout: pure builders first (cells, thresholds, formatting), then the mode
 * state that /cc-context writes and status-line.ts reads.
 */

/**
 * Fill color tier, four steps: green while there is headroom, amber from 50%,
 * orange from 75%, pink from 90%. These thresholds are the single source of
 * truth for the ladder (status-colors.ts only supplies the hues), so the bar and
 * the percentage can never disagree about the active tier.
 */
export type ContextLevel = "healthy" | "warning" | "high" | "critical";

/** `bar` = meter + percent, `text` = the old `ctx 12%`, `off` = no segment. */
export type ContextBarMode = "bar" | "text" | "off";

export const CONTEXT_BAR_MODES: readonly ContextBarMode[] = ["bar", "text", "off"];
export const DEFAULT_CONTEXT_BAR_MODE: ContextBarMode = "bar";
export const DEFAULT_CONTEXT_BAR_WIDTH = 10;
/** Below 4 cells a meter stops reading as a proportion; above 40 it crowds out
 *  cwd/branch/cost on an 80-column terminal. */
export const MIN_CONTEXT_BAR_WIDTH = 4;
export const MAX_CONTEXT_BAR_WIDTH = 40;

const FILL = "█";
const TRACK = "░";
/**
 * Left-aligned eighths for the head cell, so a narrow bar still moves between
 * whole percentages instead of jumping a full cell. Index = eighths filled
 * (0 = no partial cell).
 */
const HEAD = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"] as const;

function clampWidth(width: number): number {
	if (!Number.isFinite(width)) return DEFAULT_CONTEXT_BAR_WIDTH;
	return Math.min(MAX_CONTEXT_BAR_WIDTH, Math.max(MIN_CONTEXT_BAR_WIDTH, Math.round(width)));
}

export function contextLevel(percent: number): ContextLevel {
	if (percent >= 90) return "critical";
	if (percent >= 75) return "high";
	if (percent >= 50) return "warning";
	return "healthy";
}

/** CC-style compact token count: 847 → "847", 5400 → "5.4k", 25600 → "26k". */
export function formatContextTokens(n: number): string {
	if (n < 1000) return String(Math.round(n));
	if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
	if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
	return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

export interface ContextBarCells {
	/** Whole cells to paint in the level color. */
	filled: number;
	/** Partial head cell ("▏"…"▉"), or "" when the fill lands on a boundary. */
	head: string;
	/** Empty cells to paint as the dim track. */
	empty: number;
}

/**
 * Split a percentage into fixed-width cells. Always returns exactly `width`
 * cells (filled + head + empty), so the meter never reflows as the session grows.
 */
export function contextBarCells(percent: number, width: number): ContextBarCells {
	const w = clampWidth(width);
	const safe = Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 0;
	// Round to eighths of a cell so tiny fractions still leave a visible sliver.
	const eighths = Math.round((safe / 100) * w * 8);
	const filled = Math.min(w, Math.floor(eighths / 8));
	const partial = filled >= w ? 0 : eighths % 8;
	return { filled, head: HEAD[partial] ?? "", empty: w - filled - (partial > 0 ? 1 : 0) };
}

/**
 * Color functions for the segment, resolved from the live palette on each
 * render. Keeps this module free of hex values.
 */
export interface ContextPaint {
	/** Muted text: the `?` placeholder, token counts, details. */
	dim(text: string): string;
	/** The `ctx` label. */
	label(text: string): string;
	/** The empty track behind the fill. */
	track(text: string): string;
	healthy(text: string): string;
	warning(text: string): string;
	high(text: string): string;
	critical(text: string): string;
}

export interface ContextMeterInput {
	/** pi's ContextUsage.tokens. `undefined` = no gauge at all (no model, or a
	 *  model with no context window); `null` = usage exists but the estimate is
	 *  not trustworthy right after compaction. */
	tokens: number | null | undefined;
	/** Model context window; 0 when the model exposes none. */
	window: number;
	mode: ContextBarMode;
	/** Bar width in cells (clamped); ignored in text mode. */
	width: number;
	/** `extra detail` toggle — append `used/window` tokens to the segment. */
	detailed: boolean;
}

/**
 * Build one status-line segment, or null when there is nothing to say (mode
 * off, no model window, or a fresh session with no context used). Unknown usage
 * after compaction renders `ctx ?` rather than a stale `0%`: pi drops the
 * pre-compaction estimate, and zero would claim headroom we cannot vouch for.
 */
export function renderContextSegment(input: ContextMeterInput, paint: ContextPaint): string | null {
	if (input.mode === "off") return null;
	if (input.tokens === undefined) return null;
	const label = paint.label("ctx");
	// null = pi has no trustworthy estimate (right after compaction); NaN/Infinity
	// can only come from a broken usage payload — both read as "unknown".
	if (input.tokens === null || !Number.isFinite(input.tokens)) return `${label} ${paint.dim("?")}`;
	if (input.tokens <= 0) return null;
	// No window: the model advertises none, so there is no denominator for a meter
	// or a percentage — fall back to the absolute count.
	if (!(input.window > 0)) return `${label} ${paint.dim(formatContextTokens(input.tokens))}`;

	const percent = (input.tokens / input.window) * 100;
	const level = contextLevel(percent);
	const levelPaint = paint[level];
	// Floor the printed number so a not-quite-full context never reads "100%".
	const shown = percent >= 100 ? 100 : Math.floor(percent);

	let meter = "";
	if (input.mode === "bar") {
		const cells = contextBarCells(percent, input.width);
		const filled = FILL.repeat(cells.filled) + cells.head;
		const track = TRACK.repeat(cells.empty);
		// Fill and track stay contiguous — a gap here would read as a second bar.
		meter = (filled ? levelPaint(filled) : "") + (track ? paint.track(track) : "");
		if (meter) meter += " ";
	}

	// The number carries the same tier color as the fill, so the tier reads in
	// text mode and where a partial cell is invisible.
	const parts = [levelPaint(`${shown}%`)];
	if (input.detailed) {
		parts.push(paint.dim(`(${formatContextTokens(input.tokens)}/${formatContextTokens(input.window)})`));
	}
	return `${label} ${meter}${parts.join(" ")}`;
}

// ---------------------------------------------------------------------------
// Mode state (owned here so status-line.ts and commands.ts stay acyclic)
// ---------------------------------------------------------------------------

let mode: ContextBarMode = DEFAULT_CONTEXT_BAR_MODE;
let width = DEFAULT_CONTEXT_BAR_WIDTH;
let onChange: (() => void) | null = null;

export function getContextBarMode(): ContextBarMode {
	return mode;
}

export function getContextBarWidth(): number {
	return width;
}

/**
 * status-line.ts registers its repaint here; /cc-context calls the setters so
 * the line updates on the next frame instead of waiting for an unrelated redraw.
 */
export function onContextBarChange(fn: (() => void) | null): void {
	onChange = fn;
}

export function setContextBarMode(value: ContextBarMode): void {
	if (!CONTEXT_BAR_MODES.includes(value) || mode === value) return;
	mode = value;
	onChange?.();
}

export function setContextBarWidth(value: number): void {
	const next = clampWidth(value);
	if (next === width) return;
	width = next;
	onChange?.();
}

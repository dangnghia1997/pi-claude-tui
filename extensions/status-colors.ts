/**
 * Coral/teal palette for the status line.
 *
 * CC keeps its status bar deliberately dim, which leaves the one always-visible
 * row flat. Here each datum gets a hue — coral model, teal branch, a
 * lime→amber→orange→pink context ladder, blue cost — while chrome (separators,
 * cwd, totals) stays muted so the colors read as signal.
 *
 * Hexes go through palette.ts's `fg`, so 256color terminals get the
 * downconverted cube index. Values target a `#102F35` canvas; on a light theme
 * statusPainter darkens them to keep their contrast on white.
 */
import { fg as paletteFg, shadeHex } from "./palette.js";

export const piCoralTeal = {
	background: "#102F35",
	surface: "#183D42",
	separator: "#62878A",

	text: {
		primary: "#E8F1F2",
		muted: "#8EAFB0",
	},

	accent: {
		coral: "#FF7B72",
		teal: "#54D6C5",
		lime: "#D7F171",
		amber: "#FFCA70",
		orange: "#FF9F68",
		error: "#FF6B8A",
		blue: "#8BB8FF",
		dimTeal: "#62878A",
	},

	semantic: {
		model: "#FF7B72",
		agent: "#FF7B72",
		branch: "#54D6C5",
		running: "#54D6C5",
		success: "#D7F171",
		warning: "#FFCA70",
		error: "#FF6B8A",
		cost: "#8BB8FF",
		duration: "#8EAFB0",
	},

	context: {
		healthy: "#D7F171",
		warning: "#FFCA70",
		high: "#FF9F68",
		critical: "#FF6B8A",
	},
} as const;

/**
 * How far a hue is mixed toward black on a light theme. The palette is tuned
 * for a deep teal canvas; undarkened, lime and amber wash out on white.
 */
const LIGHT_SHADE = 0.42;

/** A theme-resolved painter: `paint(hex)(text)` → colored text. */
export type StatusPainter = (hex: string) => (text: string) => string;

/**
 * Build the painter for a color scheme. Creating one per render is cheap: it
 * only closes over the shade function, and hex→SGR conversion happens per call
 * in palette.ts (which downconverts for 256color terminals).
 */
export function statusPainter(scheme: "dark" | "light"): StatusPainter {
	const shade = (hex: string): string => (scheme === "light" ? shadeHex(hex, LIGHT_SHADE) : hex);
	return (hex) => {
		const color = shade(hex);
		return (text) => paletteFg(color, text);
	};
}

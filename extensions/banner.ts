/**
 * Welcome banner: CC's welcome box with pi branding, grouped by resource type.
 *
 * Wide (>=76): the two-column LogoV2 box, wordmark in the top border, welcome +
 * pi mark + model/cwd on the left, `Extensions` and `Skills` under their own
 * titles on the right.
 *   ╭─── pi agent vX.Y.Z ─────────────────────────────╮
 *   │ Welcome back!        │ Extensions                │
 *   │      pi logo         │ ext-a, ext-b              │
 *   │      pi logo         │ ───────────────────────── │
 *   │ model / cwd          │ Skills                    │
 *   ╰──────────────────────────────────────────────────╯
 * Boxed (40..75): one rounded box hugging the pi mark and the identity stack,
 * with the welcome line and grouped Extensions/Skills as a trailer.
 *   ╭───────────────────────────────╮
 *   │ ██████    pi agent vX.Y.Z     │
 *   │ ██  ██    model               │
 *   │ ████  ██  ~/cwd               │
 *   │ ██    ██  resumed 85d19568    │
 *   ╰───────────────────────────────╯
 *    Welcome back!
 *    Extensions
 *    ext-a, ext-b
 *    Skills
 *    skill-a, skill-b
 * Compact (<40): centered single-column box with one grouped line each for
 * Extensions and Skills underneath.
 *
 * On resume/fork the session id (first 8 chars) and name render as a dim
 * `resumed <id> · <title>` identity line.
 */
import { basename, dirname } from "node:path";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { DefaultPackageManager, getAgentDir, SettingsManager, VERSION } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { fg as paletteFg, resolveThemePalette } from "./palette.js";
import { tildeHome } from "./status-line.js";

const SKILLS_MAX_ROWS = 6;
/** Below this render width the banner degrades to the centered compact box. */
const MIN_BOXED_WIDTH = 40;
/** From this width up the two-column wide box renders. */
const FULL_MIN_WIDTH = 76;
const MAX_LEFT_WIDTH = 50;
const MIN_LEFT_WIDTH = 20;
const RIGHT_MIN_WIDTH = 20;

/** CC brand orange for the banner chrome. The theme's `accent` maps to CC's
 *  suggestion blue, so resolve the CC palette directly (memoized per theme). */
function ccAccent(theme: Theme): (s: string) => string {
	const pal = resolveThemePalette(theme);
	return (s) => paletteFg(pal.cc.claude, s);
}

/**
 * pi brand mark — the geometric P+i logo (pi.dev/logo-auto.svg), on the SVG's
 * 4x4 cell lattice:
 *
 *   c c c .      c = coral top bar + right side of the P bowl
 *   b . c .      b = blue P stem / descender
 *   b b . y      y = yellow i block
 *   b . . y      . = empty
 *
 * Same grid pi renders (easter-egg-3d.js PI_LOGO_PIXELS), so the mark matches
 * the glyph pi uses everywhere else.
 */
const PI_LOGO_PIXELS: readonly string[] = ["ccc.", "b.c.", "bb.y", "b..y"];

/** The three fills of logo-auto.svg, in logo order. */
const PI_LOGO_COLORS = { c: "#F09082", b: "#4D9ABF", y: "#F1BE58" } as const;
type LogoColor = keyof typeof PI_LOGO_COLORS;

/** Cells per pixel: a terminal cell is ~2:1 tall, so 2 cells keep pixels square. */
const PI_LOGO_PIXEL_CELLS = 2;
const PI_LOGO_WIDTH = Math.max(...PI_LOGO_PIXELS.map((row) => row.length)) * PI_LOGO_PIXEL_CELLS;
const PI_LOGO_HEIGHT = PI_LOGO_PIXELS.length;

function isLogoColor(pixel: string): pixel is LogoColor {
	return pixel === "c" || pixel === "b" || pixel === "y";
}

/**
 * The mark, one string per row, every row PI_LOGO_WIDTH wide (empty pixels stay
 * as spaces so the identity column never shifts). Adjacent pixels of the same
 * color merge into one SGR span.
 */
function paintLogo(theme: Theme): string[] {
	// Memoized per (theme, color mode); also syncs palette.ts's color mode so `fg`
	// downconverts these hexes to the same 256-cube index pi would pick.
	resolveThemePalette(theme);
	return PI_LOGO_PIXELS.map((row) => {
		let out = "";
		for (let i = 0; i < row.length; ) {
			const pixel = row[i] as string;
			let end = i + 1;
			while (end < row.length && row[end] === pixel) end += 1;
			const block = (isLogoColor(pixel) ? "█" : " ").repeat((end - i) * PI_LOGO_PIXEL_CELLS);
			out += isLogoColor(pixel) ? paletteFg(PI_LOGO_COLORS[pixel], block) : block;
			i = end;
		}
		return out;
	});
}

export interface BannerInfo {
	model: () => string | undefined;
	cwd: string;
	resumed: string | undefined;
	title: () => string | undefined;
	welcome?: string;
	/** Extensions pi actually loads in this session (see {@link discoverResources}). */
	extensions?: readonly string[];
	/** Skills pi actually loads in this session (see {@link discoverResources}). */
	skills?: readonly string[];
}

function center(text: string, width: number): string {
	const w = visibleWidth(text);
	if (w >= width) return truncateToWidth(text, width, "");
	const left = Math.floor((width - w) / 2);
	return " ".repeat(left) + text + " ".repeat(width - w - left);
}

function padRight(text: string, width: number): string {
	const w = visibleWidth(text);
	if (w >= width) return truncateToWidth(text, width, "");
	return text + " ".repeat(width - w);
}

/** Middle-truncate a path: keep first/…/last so the useful tail survives, like
 * CC's `<first>/…/<last>`. An absolute path keeps a single leading `/`, and a
 * trailing slash is dropped so `last` is the real tail segment. */
export function truncatePath(path: string, maxLen: number): string {
	if (visibleWidth(path) <= maxLen) return path;
	const sep = "/";
	const ellipsis = "…";
	// Drop trailing separators so `last` is the real tail, not "" → `…/`.
	const trimmed = path.length > 1 ? path.replace(/\/+$/, "") : path;
	const parts = trimmed.split(sep);
	if (parts.length <= 1) return truncateToWidth(trimmed, maxLen, ellipsis);
	const first = parts[0]; // "" when the path is absolute (leading slash)
	const last = parts[parts.length - 1] || "";
	// `<first>/…/<last>`; for an absolute path first is "" so this is `/…/last`
	// (one leading slash), and for `~/a/b` it is `~/…/b`.
	const candidate = `${first}${sep}${ellipsis}${sep}${last}`;
	if (visibleWidth(candidate) <= maxLen) return candidate;
	// Not enough room even for that: keep the head + a truncated tail.
	const head = `${first}${sep}${ellipsis}${sep}`;
	const lastMax = maxLen - visibleWidth(head);
	if (lastMax > 0) return `${head}${truncateToWidth(last, lastMax, ellipsis)}`;
	return truncateToWidth(trimmed, maxLen, ellipsis);
}

/** Path segments that carry no identity when naming an extension entry. */
const GENERIC_SEGMENTS = new Set(["index", "main", "extension", "extensions", "src", "dist", "lib", ".", ".."]);

/** Human name for a settings entry: `npm:pi-web-access` → pi-web-access,
 *  `/…/pi-claude-tui/extensions/index.ts` → pi-claude-tui. */
export function extensionDisplayName(entry: string): string {
	const spec = entry.replace(/^(npm|git|file):/, "");
	const segments = spec.split("/").filter(Boolean);
	for (let i = segments.length - 1; i >= 0; i--) {
		const base = segments[i]!.replace(/\.(ts|js)$/, "");
		if (!GENERIC_SEGMENTS.has(base)) return base;
	}
	return spec;
}

/**
 * `--no-extensions` / `-ne` turns discovery off, and `-e` / `--extension` adds
 * explicit extensions. Both are CLI args, so argv is the only place an extension
 * can see them; the splash would otherwise list extensions this run refuses to
 * load.
 */
function cliExtensionArgs(argv: readonly string[] = process.argv.slice(2)): { noExtensions: boolean; paths: string[] } {
	const paths: string[] = [];
	let noExtensions = false;
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--") break;
		if (arg === "--no-extensions" || arg === "-ne") {
			noExtensions = true;
			continue;
		}
		// pi's parser takes the next argv entry verbatim, so mirror that.
		if ((arg === "--extension" || arg === "-e") && i + 1 < argv.length) {
			paths.push(argv[i + 1] as string);
			i += 1;
		}
	}
	return { noExtensions, paths };
}

/** The resource groups the splash shows, as display names ready for `packNames`. */
export interface LoadedResources {
	extensions: string[];
	skills: string[];
}

/**
 * The extensions and skills pi actually loads in this session.
 *
 * pi does not expose its loaded-resource lists to extensions, so ask pi's own
 * resolver: `DefaultPackageManager.resolve()` is the call the resource loader
 * makes before loading, so it applies every rule that decides whether a resource
 * runs — merged agent + project settings, `-`/`!` override patterns, `+`
 * re-enables, package `filter`s, project trust, and on-disk existence. Entries
 * that failed to install, are disabled by a pattern, or sit in an untrusted
 * project therefore never show up as "loaded".
 *
 * `onMissing` returns "skip" so resolution stays read-only: a configured but
 * absent package is reported missing, not installed at startup. Built-in
 * extensions are dropped (pi marks them `hidden`). Never throws — the splash
 * degrades to empty lists.
 */
async function discoverResources(cwd: string, projectTrusted: boolean): Promise<LoadedResources> {
	const cli = cliExtensionArgs();
	const extensions = new Set<string>();
	// `-ne` turns extension discovery off, so only explicit `-e` paths load.
	// Resolving them would try to install an `-e npm:…` source, which a
	// display-only call must not do, so they are named as given. Skills are
	// unaffected by `-ne` and still resolve normally.
	if (cli.noExtensions) {
		for (const path of cli.paths) {
			if (!path.startsWith("builtin:")) extensions.add(extensionDisplayName(path));
		}
	}
	try {
		const agentDir = getAgentDir();
		const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted });
		const packages = new DefaultPackageManager({ cwd, agentDir, settingsManager });
		const resolved = await packages.resolve(async () => "skip");
		if (!cli.noExtensions) {
			for (const resource of resolved.extensions) {
				if (!resource.enabled || resource.path.startsWith("builtin:")) continue;
				extensions.add(
					resource.metadata.origin === "package"
						? extensionDisplayName(resource.metadata.source)
						: extensionDisplayName(resource.path),
				);
			}
			// `-e` paths load in addition to discovery, even alongside settings.
			for (const path of cli.paths) extensions.add(extensionDisplayName(path));
		}
		// A skill resource is its `SKILL.md`; the directory holding it is the name
		// pi lists (and falls back to when the frontmatter has no name).
		const skills = new Set<string>();
		for (const resource of resolved.skills) {
			if (!resource.enabled) continue;
			const name = basename(dirname(resource.path));
			if (name.length > 0) skills.add(name);
		}
		return { extensions: [...extensions].sort(), skills: [...skills].sort() };
	} catch {
		return { extensions: [...extensions].sort(), skills: [] };
	}
}

/** Pack names into comma-separated rows that fit `width`, with a "+N more" tail. */
function packNames(names: readonly string[], width: number, maxRows: number): string[] {
	if (names.length === 0) return [];
	const joined = (parts: readonly string[]): string => parts.join(", ");
	const rows: string[] = [];
	let row: string[] = [];
	let placed = 0;
	for (const name of names) {
		if (row.length === 0 || visibleWidth(joined([...row, name])) <= width) {
			row.push(name);
			placed += 1;
			continue;
		}
		if (rows.length + 1 === maxRows) break;
		rows.push(joined(row));
		row = [name];
		placed += 1;
	}
	let hidden = names.length - placed;
	if (hidden > 0) {
		while (row.length > 0 && visibleWidth(joined([...row, `+${hidden} more`])) > width) {
			row.pop();
			hidden += 1;
		}
		row.push(`+${hidden} more`);
	}
	rows.push(joined(row));
	return rows;
}

export class BannerComponent {
	private revealWidth: number | undefined;
	// Render cache: the TUI re-renders the header every frame, and the box is
	// static once the session is up. Keyed on every input that affects output;
	// invalidate() drops it.
	private cacheKey: string | undefined;
	private cacheTheme: Theme | undefined;
	private cacheLines: string[] | undefined;

	constructor(private readonly info: BannerInfo) {}

	setRevealWidth(width: number | undefined): void {
		if (width === this.revealWidth) return;
		this.revealWidth = width;
		this.invalidate();
	}

	invalidate(): void {
		this.cacheKey = undefined;
		this.cacheTheme = undefined;
		this.cacheLines = undefined;
	}

	render(width: number, theme: Theme): string[] {
		// Key on every input the output depends on. model/title/resumed are
		// dynamic getters; a mode/session change flips the key and recomputes.
		const key = [
			width,
			this.revealWidth ?? -1,
			typeof theme.getColorMode === "function" ? theme.getColorMode() : "",
			this.info.model() ?? "",
			this.info.title() ?? "",
			this.info.resumed ?? "",
		].join("\u0000");
		if (this.cacheLines && this.cacheKey === key && this.cacheTheme === theme) {
			return this.cacheLines;
		}
		// CC's bordered banner always: two-column box when there is room, a single
		// box below that, the compact box on narrow terminals.
		const rows =
			width >= FULL_MIN_WIDTH
				? this.renderWide(width, theme)
				: width >= MIN_BOXED_WIDTH
					? this.renderBoxed(width, theme)
					: this.renderCompact(width, theme);
		const reveal = this.revealWidth;
		const out = reveal === undefined ? rows : rows.map((row) => truncateToWidth(row, reveal, ""));
		this.cacheKey = key;
		this.cacheTheme = theme;
		this.cacheLines = out;
		return out;
	}

	private border(theme: Theme, text: string): string {
		return ccAccent(theme)(text);
	}

	/** The `resumed <id8> · <title>` identity line, or undefined on a fresh session. */
	private resumedLine(): string | undefined {
		if (this.info.resumed === undefined) return undefined;
		const title = this.info.title();
		return `resumed ${this.info.resumed}${title ? ` · ${title}` : ""}`;
	}

	/**
	 * CC's boxed logo (LogoV2): one rounded border hugging the pi mark on the left
	 * and the identity stack on the right. Used by the single-box tier; its
	 * Extensions/Skills sections render as a trailer under the box.
	 */
	private renderLogoBox(width: number, theme: Theme): string[] {
		const dim = (s: string): string => theme.fg("dim", s);
		const accent = ccAccent(theme);

		const model = this.info.model() ?? "";
		const cwd = truncatePath(this.info.cwd, MAX_LEFT_WIDTH - 4);
		const resumed = this.resumedLine();

		// Identity stack right of the logo; the wordmark leads (dsh-tui: wordmark
		// is the first in-box line, not spliced into the border).
		const lines: string[] = [
			`${accent("pi agent")} ${dim(`v${VERSION}`)}`,
			...(model ? [dim(model)] : []),
			dim(cwd),
			...(resumed ? [dim(resumed)] : []),
		];
		const logo = paintLogo(theme);
		const logoWidth = PI_LOGO_WIDTH;
		// Chrome beyond logo + text: 2 borders + 2 padding + 2 gap.
		const overhead = logoWidth + 6;
		// The box hugs its widest identity line (a badge, not a layout region).
		const textWidth = Math.min(Math.max(...lines.map((line) => visibleWidth(line))), Math.max(1, width - overhead));
		const boxWidth = overhead + textWidth;

		const rows: string[] = [this.border(theme, `╭${"─".repeat(boxWidth - 2)}╮`)];
		const height = Math.max(PI_LOGO_HEIGHT, lines.length);
		for (let i = 0; i < height; i++) {
			const art = logo[i] ?? " ".repeat(logoWidth);
			const text = i < lines.length ? truncateToWidth(lines[i], textWidth, "") : "";
			const pad = " ".repeat(Math.max(0, textWidth - visibleWidth(text)));
			rows.push(`${this.border(theme, "│")} ${art}  ${text}${pad} ${this.border(theme, "│")}`);
		}
		rows.push(this.border(theme, `╰${"─".repeat(boxWidth - 2)}╯`));
		return rows;
	}

	/**
	 * Boxed tier (40..75 cols, dsh-tui renderBoxed): the logo box plus the
	 * Extensions/Skills feeds as a borderless trailer under it.
	 */
	private renderBoxed(width: number, theme: Theme): string[] {
		return [...this.renderLogoBox(width, theme), ...this.renderBoxedTrailer(width, theme)];
	}

	/**
	 * Single-line resource feed: ` Extensions  a, b, +N more` under the compact box
	 * so a narrow terminal still groups by title; `packNames` clamps overflow.
	 */
	private renderFeedLine(width: number, theme: Theme, label: string, names: readonly string[]): string[] {
		if (names.length === 0) return [];
		const labelText = theme.bold(ccAccent(theme)(label));
		// 1 leading space + label + 2 gap = the list's available width.
		const listWidth = Math.max(1, width - visibleWidth(labelText) - 3);
		const [packed = ""] = packNames(names, listWidth, 1);
		return [truncateToWidth(` ${labelText} ${theme.fg("dim", packed)}`, Math.max(1, width), "")];
	}

	/**
	 * The left panel: welcome, the pi mark, then the identity stack, matching
	 * CC's LogoV2 (welcome on the first row, model/cwd pinned to the bottom).
	 */
	private renderWide(width: number, theme: Theme): string[] {
		const dim = (s: string): string => theme.fg("dim", s);
		const accent = ccAccent(theme);
		const bold = (s: string): string => theme.bold(s);

		const welcome = this.info.welcome ?? "Welcome back!";
		const model = this.info.model() ?? "";
		const cwd = truncatePath(this.info.cwd, MAX_LEFT_WIDTH - 4);
		const resumed = this.resumedLine();

		// Left panel width (CC: max(content, 20) + 4, capped at 50)
		const leftWidth = Math.min(
			Math.max(
				visibleWidth(welcome),
				visibleWidth(cwd),
				visibleWidth(model),
				visibleWidth(resumed ?? ""),
				MIN_LEFT_WIDTH,
			) + 4,
			MAX_LEFT_WIDTH,
		);
		const boxWidth = width; // adaptive: full terminal width
		// 7 = 2 borders + 2 paddingX + 1 divider + 2 gaps
		const rightWidth = boxWidth - leftWidth - 7;
		// Fall back to the boxed tier, not compact.
		if (rightWidth < RIGHT_MIN_WIDTH) return this.renderBoxed(width, theme);

		// Identity lines share one left edge: individually centering lines of very
		// different length gives a ragged edge that reads as misalignment.
		const identity: string[] = [...(model ? [dim(model)] : []), dim(cwd), ...(resumed ? [dim(resumed)] : [])];
		const identityLead = Math.max(
			0,
			Math.floor((leftWidth - Math.max(...identity.map((l) => visibleWidth(l)), 0)) / 2),
		);

		// Left panel (space-between: welcome / logo / identity stack). The welcome
		// opens the panel on the same row as the right column's first section
		// title, and model/cwd sit at the bottom (CC LogoV2).
		const leftRows: string[] = [
			center(bold(welcome), leftWidth),
			"",
			...paintLogo(theme).map((row) => center(row, leftWidth)),
			"",
			...identity.map((l) => " ".repeat(identityLead) + truncateToWidth(l, leftWidth - 2, "")),
		];

		// Right panel: Extensions + Skills feeds, live from disk.
		const rightRows: string[] = [];
		const exts = this.info.extensions ?? [];
		const skills = this.info.skills ?? [];
		if (exts.length > 0) {
			rightRows.push(bold(accent("Extensions")));
			for (const line of packNames(exts, rightWidth, 2)) {
				rightRows.push(truncateToWidth(line, rightWidth, ""));
			}
		}
		if (skills.length > 0) {
			if (rightRows.length > 0) rightRows.push(accent("─".repeat(rightWidth)));
			rightRows.push(bold(accent("Skills")));
			for (const line of packNames(skills, rightWidth, SKILLS_MAX_ROWS)) {
				rightRows.push(truncateToWidth(line, rightWidth, ""));
			}
		}

		const height = Math.max(leftRows.length, rightRows.length);
		const rows: string[] = [];

		// Top border with embedded title: ╭─── pi agent vX.Y.Z ──fill──╮
		const titlePlain = `pi agent v${VERSION}`;
		const titleColored = `${accent("pi agent")} ${dim(`v${VERSION}`)}`;
		const fillLen = boxWidth - 1 - 3 - 1 - visibleWidth(titlePlain) - 1 - 1;
		rows.push(
			`${this.border(theme, "╭───")} ${titleColored} ${this.border(theme, `${"─".repeat(Math.max(0, fillLen))}╮`)}`,
		);

		// Content rows: │ left │ right │
		for (let i = 0; i < height; i++) {
			const left = i < leftRows.length ? leftRows[i] : "";
			const right = i < rightRows.length ? rightRows[i] : "";
			rows.push(
				`${this.border(theme, "│")} ${padRight(left, leftWidth)} ${this.border(theme, "│")} ${padRight(right, rightWidth)} ${this.border(theme, "│")}`,
			);
		}

		// Bottom border
		rows.push(this.border(theme, `╰${"─".repeat(boxWidth - 2)}╯`));
		return rows;
	}

	/** Borderless welcome + Extensions/Skills feeds under the boxed banner, indented 1. */
	private renderBoxedTrailer(width: number, theme: Theme): string[] {
		const dim = (s: string): string => theme.fg("dim", s);
		const accent = ccAccent(theme);
		const bold = (s: string): string => theme.bold(s);
		const usable = Math.max(1, width - 2);
		// dsh-tui: the trailer opens with the welcome line, same source as the
		// wide/compact tiers.
		const rows: string[] = [` ${dim(this.info.welcome ?? "Welcome back!")}`];
		const section = (label: string, names: readonly string[], maxRows: number): void => {
			if (names.length === 0) return;
			rows.push("");
			rows.push(` ${bold(accent(label))}`);
			for (const line of packNames(names, usable, maxRows)) {
				rows.push(` ${dim(truncateToWidth(line, usable, ""))}`);
			}
		};
		section("Extensions", this.info.extensions ?? [], 2);
		section("Skills", this.info.skills ?? [], SKILLS_MAX_ROWS);
		return rows;
	}

	private renderCompact(width: number, theme: Theme): string[] {
		const dim = (s: string): string => theme.fg("dim", s);
		const accent = ccAccent(theme);
		const bold = (s: string): string => theme.bold(s);

		const welcome = this.info.welcome ?? "Welcome back!";
		const model = this.info.model() ?? "";
		const resumed = this.resumedLine();

		const contentWidth = Math.max(
			PI_LOGO_WIDTH,
			visibleWidth(welcome),
			visibleWidth(model),
			visibleWidth(resumed ?? ""),
			MIN_LEFT_WIDTH,
		);
		const boxWidth = Math.min(contentWidth + 4, Math.max(0, width - 2));
		// The titled top border `╭── pi agent ──╮` is a fixed 14-column scaffold;
		// below 14 cols its fill length goes negative (`"─".repeat(negative)` →
		// RangeError) and the border overflows the box. Degrade to a borderless
		// centered stack instead of crashing.
		if (boxWidth < 14) return this.renderCompactPlain(width, theme);
		const inner = boxWidth - 4;
		const cwd = truncatePath(this.info.cwd, inner);

		const rows: string[] = [];
		// Top border with compact title: ╭── pi agent ──╮
		const titlePlain = "pi agent";
		const fillLen = boxWidth - 1 - 2 - 1 - visibleWidth(titlePlain) - 1 - 1;
		rows.push(
			`${this.border(theme, "╭──")} ${accent(titlePlain)} ${this.border(theme, `${"─".repeat(Math.max(0, fillLen))}╮`)}`,
		);
		rows.push(`${this.border(theme, "│")} ${center(bold(welcome), inner)} ${this.border(theme, "│")}`);
		for (const artRow of paintLogo(theme)) {
			rows.push(`${this.border(theme, "│")} ${center(artRow, inner)} ${this.border(theme, "│")}`);
		}
		if (model) rows.push(`${this.border(theme, "│")} ${center(dim(model), inner)} ${this.border(theme, "│")}`);
		rows.push(`${this.border(theme, "│")} ${center(dim(cwd), inner)} ${this.border(theme, "│")}`);
		if (resumed) rows.push(`${this.border(theme, "│")} ${center(dim(resumed), inner)} ${this.border(theme, "│")}`);
		rows.push(this.border(theme, `╰${"─".repeat(boxWidth - 2)}╯`));
		// The Extensions/Skills sections survive the narrow tier as one line each,
		// still grouped by title (`+N more` when a list overflows).
		rows.push(...this.renderFeedLine(width, theme, "Extensions", this.info.extensions ?? []));
		rows.push(...this.renderFeedLine(width, theme, "Skills", this.info.skills ?? []));
		return rows;
	}

	/**
	 * Borderless fallback for terminals too narrow to hold the compact box
	 * (< 14 cols). A centered title/welcome/cwd stack clamped to the available
	 * width — no box chrome, so no negative repeat.
	 */
	private renderCompactPlain(width: number, theme: Theme): string[] {
		const dim = (s: string): string => theme.fg("dim", s);
		const accent = ccAccent(theme);
		const bold = (s: string): string => theme.bold(s);
		const w = Math.max(1, width);
		const welcome = this.info.welcome ?? "Welcome back!";
		const model = this.info.model() ?? "";
		const resumed = this.resumedLine();
		const cwd = truncatePath(this.info.cwd, w);
		const rows: string[] = [center(accent("pi agent"), w), center(bold(welcome), w)];
		if (model) rows.push(center(dim(model), w));
		rows.push(center(dim(cwd), w));
		if (resumed) rows.push(center(dim(resumed), w));
		return rows;
	}
}

export function registerBanner(pi: ExtensionAPI): void {
	pi.on("session_start", async (event, ctx) => {
		if (ctx.mode !== "tui") return;
		const resumed =
			event.reason === "resume" || event.reason === "fork"
				? (ctx.sessionManager.getSessionId() ?? "").slice(0, 8) || undefined
				: undefined;
		// Extensions + skills for this session, resolved with pi's own rules.
		const loaded = await discoverResources(ctx.cwd, ctx.isProjectTrusted());
		const info: BannerInfo = {
			model: () => ctx.model?.id,
			// tildeHome guards the HOME-unset and non-prefix cases; reuse it here.
			cwd: tildeHome(ctx.cwd),
			resumed,
			title: () => ctx.sessionManager.getSessionName(),
			// Resolved before the header renders, so the splash lists what pi is
			// actually running — not just what settings.json mentions.
			...loaded,
		};
		const banner = new BannerComponent(info);
		ctx.ui.setHeader((_tui, theme) => ({
			render(width: number): string[] {
				return banner.render(width, theme);
			},
			invalidate() {
				banner.invalidate();
			},
		}));
	});
}

/**
 * Commands: /cc-tools, /cc-theme, /cc-context, /cc-spinner (names kept from the
 * previous extension so migration is free). Extra detail has no keyboard
 * shortcut — CC only flips verbose from /config — so /cc-tools detail is the only
 * way in, and the status line shows `detail` while it is on.
 *
 * The group and extra-detail toggles persist to ~/.pi/settings.json so they
 * survive restarts; grouping.ts reads `groupToolCalls` from the same file.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	CONTEXT_BAR_MODES,
	type ContextBarMode,
	getContextBarMode,
	getContextBarWidth,
	MAX_CONTEXT_BAR_WIDTH,
	MIN_CONTEXT_BAR_WIDTH,
	setContextBarMode,
	setContextBarWidth,
} from "./context-bar.js";
import { setExtraDetail } from "./tools/builtins.js";
import { bustGroupingSettingsCache, repaintGroupedRows } from "./tools/grouping.js";

const SETTINGS_KEY_GROUP = "groupToolCalls";
const SETTINGS_KEY_EXTRA_DETAIL = "ccToolsExtraDetail";
const SETTINGS_KEY_CC_THEME = "ccTheme";
const SETTINGS_KEY_CONTEXT_BAR = "ccContextBar";
const SETTINGS_KEY_CONTEXT_BAR_WIDTH = "ccContextBarWidth";

// Merged cwd + home settings, cached briefly (pi settings change rarely).
let settingsCache: { value: Record<string, unknown>; timestamp: number } | null = null;
const SETTINGS_CACHE_TTL_MS = 5_000;

function readSettings(): Record<string, unknown> {
	const now = Date.now();
	if (settingsCache && now - settingsCache.timestamp < SETTINGS_CACHE_TTL_MS) {
		return settingsCache.value;
	}
	const merged: Record<string, unknown> = {};
	for (const path of [join(process.cwd(), ".pi", "settings.json"), join(homedir(), ".pi", "settings.json")]) {
		try {
			if (!path || !existsSync(path)) continue;
			const raw = JSON.parse(readFileSync(path, "utf8"));
			if (raw && typeof raw === "object") Object.assign(merged, raw);
		} catch {
			// ignore invalid settings files
		}
	}
	settingsCache = { value: merged, timestamp: now };
	return merged;
}

/** Write one key to ~/.pi/settings.json. Uses homedir() — the same source
 *  readSettings uses, so the toggle survives even when HOME is unset. */
function writeSettingsKey(key: string, value: unknown): void {
	settingsCache = null; // invalidate cache on write
	const dir = join(homedir(), ".pi");
	const path = join(dir, "settings.json");
	let settings: Record<string, unknown> = {};
	try {
		if (existsSync(path)) settings = JSON.parse(readFileSync(path, "utf8")) ?? {};
	} catch {
		/* start fresh */
	}
	if (value === undefined) {
		delete settings[key];
	} else {
		settings[key] = value;
	}
	try {
		mkdirSync(dir, { recursive: true });
		writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
	} catch {
		/* best effort */
	}
}

// Initial state from settings: grouping defaults on, extra detail defaults off.
let groupingEnabled = readSettings()[SETTINGS_KEY_GROUP] !== false;
let extraDetail = readSettings()[SETTINGS_KEY_EXTRA_DETAIL] === true;

// Context meter: context-bar.ts owns the state (status-line.ts reads it every
// frame), so seed it from settings here. An unknown persisted mode (downgrade,
// hand-edited settings) falls back to the module default rather than throwing.
const persistedContextBar = readSettings()[SETTINGS_KEY_CONTEXT_BAR];
if (typeof persistedContextBar === "string" && (CONTEXT_BAR_MODES as readonly string[]).includes(persistedContextBar)) {
	setContextBarMode(persistedContextBar as ContextBarMode);
}
const persistedContextBarWidth = readSettings()[SETTINGS_KEY_CONTEXT_BAR_WIDTH];
if (typeof persistedContextBarWidth === "number") {
	setContextBarWidth(persistedContextBarWidth);
}

export function isGroupingEnabled(): boolean {
	return groupingEnabled;
}

export function isExtraDetail(): boolean {
	return extraDetail;
}

export function registerCommands(pi: ExtensionAPI): void {
	// builtins.ts keeps its own module-level flag that only setExtraDetail()
	// writes. Without a replay at startup the status line could say "on" while
	// builtins still rendered the short preview, and the first /cc-tools detail
	// toggle then set both halves to off. Sync once here so the builtins flag, the
	// persisted value, and the status line agree from frame one.
	setExtraDetail(extraDetail);

	// Restore the CC theme if pi fell back to its built-in default at startup:
	// when the CC theme package is not registered yet as pi applies the saved
	// theme, initTheme silently falls back to "dark" and the user's /cc-theme
	// choice would be lost for the session.
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		const saved = readSettings()[SETTINGS_KEY_CC_THEME];
		if (typeof saved !== "string" || !saved.startsWith("claude-code-")) return;
		const current = ctx.ui.theme?.name;
		// Only re-apply when the theme fell back to pi's built-in default. This does
		// override an intentional /settings switch to dark/light, but a CC-extension
		// user who picked a CC theme expects it to stick across projects.
		if (current === "dark" || current === "light") {
			ctx.ui.setTheme(saved);
		}
	});

	const setDetail = (v: boolean) => {
		extraDetail = v;
		setExtraDetail(v);
		writeSettingsKey(SETTINGS_KEY_EXTRA_DETAIL, v);
	};

	const setGrouping = (v: boolean) => {
		groupingEnabled = v;
		writeSettingsKey(SETTINGS_KEY_GROUP, v);
		// grouping.ts caches the setting for 2s; bust it so the toggle is instant.
		bustGroupingSettingsCache();
		// A toggle must change the rows already on screen, not just future renders:
		// hidden members redraw as standalone rows and leaders drop their summary.
		// repaintGroupedRows() pushes both current and archived turns.
		repaintGroupedRows();
	};

	// /cc-tools — control tool UI: grouping, extra detail.
	pi.registerCommand("cc-tools", {
		description: "Control CC tool UI: grouping, extra detail",
		async handler(args, ctx) {
			const parts = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
			const sub = parts[0] ?? "status";

			if (sub === "status") {
				if (ctx.hasUI) {
					ctx.ui.notify(
						[
							`Tool grouping: ${groupingEnabled ? "on" : "off"}`,
							`Extra detail: ${extraDetail ? "on" : "off"} (/cc-tools detail on|off|toggle)`,
							"  /cc-tools group on|off|toggle",
							"  /cc-tools detail on|off|toggle",
						].join("\n"),
						"info",
					);
				}
				return;
			}

			if (sub === "group") {
				const v = parts[1];
				if (v === "on" || v === "off") {
					setGrouping(v === "on");
					if (ctx.hasUI) ctx.ui.notify(`Tool grouping: ${v}`, "info");
				} else {
					setGrouping(!groupingEnabled);
					if (ctx.hasUI) ctx.ui.notify(`Tool grouping: ${groupingEnabled ? "on" : "off"}`, "info");
				}
				return;
			}

			if (sub === "detail" || sub === "extra") {
				const v = parts[1];
				if (v === "on" || v === "off") {
					setDetail(v === "on");
					if (ctx.hasUI) ctx.ui.notify(`Extra detail: ${v}`, "info");
				} else {
					setDetail(!extraDetail);
					if (ctx.hasUI) ctx.ui.notify(`Extra detail: ${extraDetail ? "on" : "off"}`, "info");
				}
				return;
			}

			if (ctx.hasUI) {
				ctx.ui.notify(`Unknown option "${sub}". Try /cc-tools status.`, "error");
			}
		},
	});

	// /cc-theme — pick one of the shipped CC themes; pi persists the choice via its
	// setTheme path (settings.json `theme`). Theme switching otherwise lives in
	// /settings, so this panel is the fast path for the CC variants.
	pi.registerCommand("cc-theme", {
		description: "Pick a Claude Code theme",
		async handler(_args, ctx) {
			if (!ctx.hasUI) return;
			const themes = ["claude-code-dark", "claude-code-light"];
			const current = ctx.ui.theme?.name;
			const choice = await ctx.ui.select(
				current ? `Claude Code theme (current: ${current})` : "Claude Code theme",
				themes,
			);
			if (!choice) return;
			const result = ctx.ui.setTheme(choice) as { success?: boolean; error?: string } | boolean | undefined;
			const failed = result === false || (typeof result === "object" && result !== null && result.success === false);
			if (failed) {
				const err = typeof result === "object" && result !== null ? result.error : undefined;
				ctx.ui.notify(`Theme switch failed: ${err ?? choice}`, "error");
				return;
			}
			ctx.ui.notify(`Theme: ${choice}`, "info");
			// Persist to the extension's own settings file too. pi's setTheme writes
			// ~/.pi/agent/settings.json, but if the CC theme package is not registered
			// yet at startup pi falls back to "dark" and never recovers; the
			// session_start handler above restores it.
			writeSettingsKey(SETTINGS_KEY_CC_THEME, choice);
		},
	});

	// /cc-context — context meter in the status line. `bar` (default) draws the
	// meter, `text` keeps the `ctx 12%` read-out, `off` hides it. Persists to
	// ~/.pi/settings.json like the tool toggles above.
	pi.registerCommand("cc-context", {
		description: "Context meter: bar | text | off, width N",
		async handler(args, ctx) {
			const parts = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
			const sub = parts[0] ?? "status";

			const applyMode = (mode: ContextBarMode) => {
				setContextBarMode(mode);
				writeSettingsKey(SETTINGS_KEY_CONTEXT_BAR, mode);
			};

			if (sub === "status") {
				if (ctx.hasUI) {
					ctx.ui.notify(
						[
							`Context meter: ${getContextBarMode()}${getContextBarMode() === "bar" ? ` (width ${getContextBarWidth()})` : ""}`,
							"  /cc-context bar | text | off",
							"  /cc-context width 4-40",
						].join("\n"),
						"info",
					);
				}
				return;
			}

			// `percent` is the friendlier alias for the old text read-out.
			if (sub === "bar" || sub === "text" || sub === "percent" || sub === "off") {
				const mode: ContextBarMode = sub === "percent" ? "text" : sub;
				applyMode(mode);
				if (ctx.hasUI) ctx.ui.notify(`Context meter: ${getContextBarMode()}`, "info");
				return;
			}

			if (sub === "toggle") {
				const current = getContextBarMode();
				const next = current === "bar" ? "text" : current === "text" ? "off" : "bar";
				applyMode(next);
				if (ctx.hasUI) ctx.ui.notify(`Context meter: ${next}`, "info");
				return;
			}

			if (sub === "width") {
				const raw = parts[1];
				const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
				if (!Number.isFinite(parsed)) {
					if (ctx.hasUI) {
						ctx.ui.notify(`Usage: /cc-context width ${MIN_CONTEXT_BAR_WIDTH}-${MAX_CONTEXT_BAR_WIDTH}`, "error");
					}
					return;
				}
				setContextBarWidth(parsed);
				writeSettingsKey(SETTINGS_KEY_CONTEXT_BAR_WIDTH, getContextBarWidth());
				if (ctx.hasUI) ctx.ui.notify(`Context bar width: ${getContextBarWidth()}`, "info");
				return;
			}

			if (ctx.hasUI) {
				ctx.ui.notify(`Unknown option "${sub}". Try /cc-context status.`, "error");
			}
		},
	});

	// /cc-spinner — show spinner configuration.
	pi.registerCommand("cc-spinner", {
		description: "Show the CC spinner configuration",
		async handler(_args, ctx) {
			if (!ctx.hasUI) return;
			ctx.ui.notify("Spinner: CC frames (· ✢ ✳ ✶ ✻ ✽), 120ms, ~190 fun verbs", "info");
		},
	});

	// CC has no verbose keyboard shortcut (only the /config panel), and
	// single-modifier chords are easy to hit by accident: one stray keypress could
	// flood the screen with no indication. So /cc-tools is the only entry point;
	// the status line's `detail` segment keeps the state visible.
}

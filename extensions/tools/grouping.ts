/**
 * Tool grouping + collapsed summary.
 *
 * Event-driven port of dsh-tui's collapse grouping: consecutive read-only tool
 * calls within an agent run form a group. The group's first tool renders the
 * whole group (a summary row collapsed, glance lines with branch connectors
 * expanded); the other members render nothing.
 *
 * Also owns the pending status-dot blink and thinking-duration attribution.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { bold, dim, fg, italic, type ResolvedPalette } from "../palette.js";
import {
	type CollapseClassification,
	type CollapseHint,
	classifyToolCall,
	collapsedSummary,
	formatCollapseHint,
} from "./collapse.js";

export type ToolStatus = "pending" | "success" | "error";

export interface ToolRecord {
	toolCallId: string;
	toolName: string;
	args: unknown;
	status: ToolStatus;
	startedAt: number;
	classification: CollapseClassification | undefined;
	result: unknown;
	isError: boolean;
}

export interface GroupInfo {
	id: number;
	members: ToolRecord[];
	thinkingMs: number;
	running: boolean;
	active: boolean;
	failed: boolean;
	searchCount: number;
	readCount: number;
	listCount: number;
	bashCount: number;
	mcpCallCount: number;
	mcpServers: string[];
	/** Last time a member started/finished — drives the MAX 5 blink budget. */
	lastActiveAt: number;
	/** 700ms min-display state for the in-flight ⎿ hint line. */
	hintState: HintState;
	/** The leader's invalidate callback, so the group refreshes on member updates. */
	invalidator: (() => void) | undefined;
	/** Archived groups only: every member's last render invalidate, kept so a
	 *  later `/cc-tools group off` can push hidden PAST-turn members to redraw as
	 *  standalone rows. */
	memberInvalidators?: Map<string, () => void>;
	/** Thinking text from a segment that completed mid-group, shown on the ⎿ hint
	 *  line. Timestamped so latestHint() can arbitrate against member hints. */
	thinkingHint?: { value: string; at: number };
	/** Assistant body text started after this group's tools — CC's
	 *  hasContentAfter: the group settles (past tense) even though the
	 *  generation is still running. */
	contentAfter?: boolean;
}

/**
 * Per-group hint hold state (CC useMinDisplayTime): each distinct hint stays
 * visible for at least 700ms before a newer one replaces it, so fast-finishing
 * reads and greps stay readable instead of flickering past.
 */
export interface HintState {
	displayed: string | undefined;
	shownAt: number;
	pending: string | undefined;
	timer: ReturnType<typeof setTimeout> | null;
}

function createHintState(): HintState {
	return { displayed: undefined, shownAt: 0, pending: undefined, timer: null };
}

function clearHintTimer(st: HintState): void {
	if (st.timer) {
		clearTimeout(st.timer);
		st.timer = null;
	}
	st.pending = undefined;
}

// ---------------------------------------------------------------------------
// Tracker state (module-level singleton, wired per session)
// ---------------------------------------------------------------------------

let tools = new Map<string, ToolRecord>();
/** Sentinel id in the run order marking "assistant body text here" — breaks
 *  group aggregation at that point (CC: body text interrupts collapsing). */
const GROUP_BREAK = "\u0000group-break";
/** Tool-call ids (plus GROUP_BREAK sentinels) in arrival order for the current
 *  RUN (one user request, agent_start..agent_end) — grouping is run-scoped. */
let turnToolOrder: string[] = [];
let groups: GroupInfo[] = [];
// Settled groups from PAST runs, kept so a global Ctrl+O re-render (pi re-renders
// every historical tool component) still resolves each member's group. Without
// them, groupOf() returns undefined for old runs → hidden members draw their own
// rows and leaders lose their summary. These are LIGHT shells: member results are
// stripped, so nothing accumulates across the session; counts and args are enough
// to redraw the settled summary and glance lines.
let archivedGroups: GroupInfo[] = [];
// Hard cap on archived groups so a very long session can't grow unbounded even
// with stripped results. Oldest evicted first.
const MAX_ARCHIVED_GROUPS = 500;
let nextGroupId = 1;
let pendingThinkingMs = 0;
let thinkingOpenSince: number | undefined;
// The most recent completed thinking segment's text (whitespace-collapsed),
// waiting to be attached to a group as its ⎿ thinking hint.
let pendingThinkingText: { value: string; at: number } | undefined;
let blinkTimer: ReturnType<typeof setInterval> | null = null;
let blinkPhase = true;
// Ids in this tick's blink budget. Out-of-budget rows are not re-rendered each
// tick, so they must not resolve to the off-phase blank (that would freeze the
// dot away). The phase helpers force a solid dot for anyone outside the budget
// while in-budget rows keep blinking.
let blinkBudgetGroups = new Set<number>();
let blinkBudgetStandalone = new Set<string>();
let activeSession = false;
// Non-grouped tools' running dots: armBlink registers their invalidate so the
// same tick drives their blink. Keyed by toolCallId, dropped on exit.
const standaloneBlinkers = new Map<string, () => void>();
// Latest render invalidate for EVERY tool this run, keyed by toolCallId and
// captured on every renderCall/renderResult. When a later member joins and forms
// a group whose leader already settled (so g.invalidator is undefined),
// invalidateGroups() can still promote the leader and refresh the group.
const toolInvalidators = new Map<string, () => void>();

// Blink watchdog (ported from pi-claude-code-ui): one global timer blinks all
// active groups; four safeguards keep it honest.
const MAX_BLINKING_GROUPS = 5;
// CC useBlink: one fixed 600ms rhythm for every pending dot.
const BLINK_INTERVAL_MS = 600;
// CC MIN_HINT_DISPLAY_MS — each distinct ⎿ hint stays visible at least this long
// before a newer one replaces it.
const HINT_MIN_DISPLAY_MS = 700;
// Safety net ONLY for leaked entries after the agent run stopped. Quiet
// long-running tools (sleep, sparse builds) legitimately emit no updates for
// minutes — the agent heartbeat keeps those blinking; this reclaims rows whose
// run died without firing agent_end.
const BLINK_STALE_TIMEOUT_MS = 15_000;
let lastBlinkActivity = 0;
// Depth of live agent runs (one agent_start/agent_end pair per loop run,
// including retries and nested subagent loops). While > 0, the tick is a
// heartbeat: quiet tools keep blinking because the run is still alive.
let agentDepth = 0;

function markBlinkActivity(): void {
	lastBlinkActivity = Date.now();
}

function reset(): void {
	tools = new Map();
	turnToolOrder = [];
	clearAllHintTimers();
	groups = [];
	archivedGroups = [];
	standaloneBlinkers.clear();
	toolInvalidators.clear();
	blinkBudgetGroups = new Set();
	blinkBudgetStandalone = new Set();
	pendingThinkingMs = 0;
	thinkingOpenSince = undefined;
	pendingThinkingText = undefined;
	agentDepth = 0;
	stopBlink();
}

function clearAllHintTimers(): void {
	for (const g of groups) clearHintTimer(g.hintState);
}

function stopBlink(): void {
	if (blinkTimer) {
		clearInterval(blinkTimer);
		blinkTimer = null;
	}
}

/**
 * Settle groups whose members never received tool_execution_end (the run died
 * without agent_end). Display-only reclamation: we don't own the real tool
 * state, we just stop claiming it is still running.
 */
function settleLeakedGroups(): void {
	let changed = false;
	for (const g of groups) {
		for (const m of g.members) {
			if (m.status === "pending") {
				// A pending member here means tool_execution_end was never observed (the
				// run died abnormally). Clean Esc-interrupts are NOT this case — the agent
				// loop emits tool_execution_end{isError:true}, so they settle as "error"
				// through the normal path. An unobserved completion is not a confirmed
				// success, so mark it "error" rather than painting a false green dot.
				m.status = "error";
				m.isError = true;
				changed = true;
			}
		}
		if (g.active) {
			g.running = false;
			g.active = false;
			g.failed = g.members.some((m) => m.isError);
			changed = true;
		}
		clearHintTimer(g.hintState);
	}
	standaloneBlinkers.clear();
	if (changed) invalidateGroups();
}

function blinkTick(): void {
	const now = Date.now();
	if (agentDepth > 0) {
		// Agent run live: quiet tools are still in flight — heartbeat keeps the
		// blink alive so sparse/no-output commands never look stale mid-run.
		lastBlinkActivity = now;
	} else if (lastBlinkActivity !== 0 && now - lastBlinkActivity > BLINK_STALE_TIMEOUT_MS) {
		// No run live and no progress for 15s: leftover pending members are
		// leaks. Reclaim them and stop the re-render storm.
		settleLeakedGroups();
		stopBlink();
		return;
	}
	blinkPhase = !blinkPhase;
	// Invalidate at most MAX_BLINKING_GROUPS leaders per tick, most recent first.
	const active = groups.filter((g) => g.active).sort((a, b) => b.lastActiveAt - a.lastActiveAt);
	const budgetGroups = active.slice(0, MAX_BLINKING_GROUPS);
	// Record who is in this tick's blink budget. Rows OUTSIDE it are not
	// re-rendered, so they freeze on their last painted frame; if that was the
	// "off" (space) phase the dot would vanish for good. The phase helpers consult
	// these sets so out-of-budget rows always resolve to the solid dot.
	blinkBudgetGroups = new Set(budgetGroups.map((g) => g.id));
	for (const g of budgetGroups) {
		if (g.invalidator) {
			try {
				g.invalidator();
			} catch {
				/* noop */
			}
		}
	}
	// Standalone (non-grouped) running dots — same rhythm, same budget, most
	// recently armed first.
	const standaloneEntries = [...standaloneBlinkers.entries()].slice(-MAX_BLINKING_GROUPS);
	blinkBudgetStandalone = new Set(standaloneEntries.map(([id]) => id));
	for (const [, invalidate] of standaloneEntries) {
		try {
			invalidate();
		} catch {
			/* noop */
		}
	}
	if (active.length === 0 && standaloneBlinkers.size === 0) stopBlink();
}

function ensureBlink(): void {
	if (blinkTimer) return;
	blinkTimer = setInterval(blinkTick, BLINK_INTERVAL_MS);
	blinkTimer.unref?.();
}

// ---------------------------------------------------------------------------
// Group construction
// ---------------------------------------------------------------------------

function buildGroup(members: ToolRecord[], id: number): GroupInfo {
	let searchCount = 0;
	let readCount = 0;
	let listCount = 0;
	const bashCount = 0;
	let mcpCallCount = 0;
	const mcpServers: string[] = [];
	let running = false;
	let failed = false;
	let lastActiveAt = 0;
	const readPaths = new Set<string>();
	let readNoPath = 0;
	for (const m of members) {
		if (m.status === "pending") running = true;
		if (m.isError) failed = true;
		if (m.startedAt > lastActiveAt) lastActiveAt = m.startedAt;
		// A read-only bash command counts as read/search/list, not "ran N bash
		// commands". CC routes read-only bash by classification; only non-read-only
		// bash becomes bashCount. In pi such a call has no classification, so it
		// already breaks the group and never reaches here.
		const c = m.classification;
		if (!c) continue;
		switch (c.kind) {
			case "search":
				searchCount += 1;
				break;
			case "list":
				listCount += 1;
				break;
			case "mcp":
				mcpCallCount += 1;
				if (c.server && !mcpServers.includes(c.server)) mcpServers.push(c.server);
				break;
			default:
				// read: track unique file paths (real Read calls carry a path); bash
				// reads like `cat`/`head` have no path, so count the operation.
				if (c.path) readPaths.add(c.path);
				else readNoPath += 1;
				break;
		}
	}
	readCount = readPaths.size + readNoPath;
	return {
		id,
		members,
		thinkingMs: 0,
		running,
		active: running,
		failed,
		searchCount,
		readCount,
		listCount,
		bashCount,
		mcpCallCount,
		mcpServers,
		lastActiveAt,
		hintState: createHintState(),
		invalidator: undefined,
	};
}

/** Recompute groups from the current turn's tool order. */
function rebuildGroups(): void {
	const newGroups: GroupInfo[] = [];
	let run: ToolRecord[] = [];
	const flush = () => {
		// A single collapsible tool use is still a group (CC builds one for a lone
		// read/search/list: "Read 1 file (ctrl+o to expand)").
		if (run.length >= 1) {
			const g = buildGroup(run, nextGroupId++);
			// Absorb any pending thinking into the new group.
			if (pendingThinkingMs > 0) {
				g.thinkingMs = pendingThinkingMs;
				pendingThinkingMs = 0;
			}
			// The preceding thinking segment travels with the group as its ⎿
			// thinking-text hint; latestHint() lets a newer tool hint win.
			if (pendingThinkingText !== undefined) {
				g.thinkingHint = pendingThinkingText;
				pendingThinkingText = undefined;
			}
			newGroups.push(g);
		}
		run = [];
	};
	for (const id of turnToolOrder) {
		// Assistant body text between tool batches breaks aggregation: the
		// sentinel closes the current run so later tools start a new group.
		if (id === GROUP_BREAK) {
			flush();
			continue;
		}
		const t = tools.get(id);
		if (!t) continue;
		if (t.classification) {
			run.push(t);
		} else {
			flush();
		}
	}
	flush();
	// Preserve invalidators, hint hold-state, thinking duration and contentAfter
	// across rebuilds: leaders may already be rendering, and buildGroup zeroes
	// thinkingMs (pendingThinkingMs is already spent by the second rebuild).
	for (const ng of newGroups) {
		const old = groups.find((g) => g.members[0]?.toolCallId === ng.members[0]?.toolCallId);
		if (old) {
			ng.invalidator = old.invalidator;
			ng.hintState = old.hintState;
			ng.thinkingMs += old.thinkingMs;
			ng.thinkingHint = ng.thinkingHint ?? old.thinkingHint;
			ng.contentAfter = old.contentAfter;
		}
	}
	groups = newGroups;
}

function groupOf(toolCallId: string): GroupInfo | undefined {
	return (
		groups.find((g) => g.members.some((m) => m.toolCallId === toolCallId)) ??
		// Also resolve members of PAST runs' settled groups so a global Ctrl+O
		// re-render keeps them collapsed instead of exploding.
		archivedGroups.find((g) => g.members.some((m) => m.toolCallId === toolCallId))
	);
}

/** Cap retained arg strings for archived members: glance lines truncate to ~72
 *  chars, so a 512-char ceiling loses nothing visible and keeps a huge command
 *  or path from staying resident for the session. */
function capArgs(args: unknown): unknown {
	if (typeof args !== "object" || args === null) return args;
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
		out[k] = typeof v === "string" && v.length > 512 ? v.slice(0, 512) : v;
	}
	return out;
}

/** Move the current run's settled groups into the archive as light shells (member
 *  results stripped) so a later global Ctrl+O still resolves and collapses them. */
function archiveCurrentGroups(): void {
	for (const g of groups) {
		// Strip heavy per-member results so nothing large persists, but keep each
		// member's render invalidate so `/cc-tools group off` can redraw past-turn
		// hidden members as standalone rows.
		const invalidators = new Map<string, () => void>();
		for (const m of g.members) {
			m.result = undefined;
			m.status = m.status === "pending" ? "success" : m.status;
			// Cap retained arg strings — glance lines only need a short summary, and
			// a bash command / long path could otherwise pin megabytes per turn.
			m.args = capArgs(m.args);
			const inv = toolInvalidators.get(m.toolCallId);
			if (inv) invalidators.set(m.toolCallId, inv);
		}
		g.running = false;
		g.active = false;
		g.invalidator = undefined;
		g.memberInvalidators = invalidators;
		g.thinkingHint = undefined; // hint only ever shows while active
		clearHintTimer(g.hintState);
		archivedGroups.push(g);
	}
	if (archivedGroups.length > MAX_ARCHIVED_GROUPS) {
		archivedGroups = archivedGroups.slice(archivedGroups.length - MAX_ARCHIVED_GROUPS);
	}
}

/** Bump a group's recency so the MAX 5 blink budget favors the latest work. */
function touchGroup(toolCallId: string): void {
	const g = groupOf(toolCallId);
	if (g) g.lastActiveAt = Date.now();
}

function isLeader(toolCallId: string): boolean {
	const g = groupOf(toolCallId);
	return !!g && g.members[0]?.toolCallId === toolCallId;
}

// ---------------------------------------------------------------------------
// /cc-tools group on|off — persisted in ~/.pi/settings.json under
// `groupToolCalls` (commands.ts writes the same key).
// ---------------------------------------------------------------------------

const SETTINGS_CACHE_TTL_MS = 2_000;
let settingsCache: { value: boolean; timestamp: number } | null = null;

function readGroupToolCalls(): boolean {
	// Default ON; only an explicit `false` disables grouping.
	let enabled = true;
	// commands.ts writes the toggle via homedir(); read it from the same source so
	// the round-trip works when HOME is unset.
	const paths = [`${process.cwd()}/.pi/settings.json`, `${homedir()}/.pi/settings.json`];
	for (const path of paths) {
		try {
			if (!path || !existsSync(path)) continue;
			const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
			if (typeof raw.groupToolCalls === "boolean") enabled = raw.groupToolCalls;
		} catch {
			/* keep previous value on parse error */
		}
	}
	return enabled;
}

/**
 * Push every row this module has influenced to re-render — current-run tools
 * (leaders and hidden members), current groups, and archived past-run groups.
 * Called by /cc-tools group on|off so hidden members redraw as standalone rows
 * and leaders drop or regain their summary row immediately.
 */
export function repaintGroupedRows(): void {
	const seen = new Set<() => void>();
	const push = (inv: (() => void) | undefined): void => {
		if (!inv || seen.has(inv)) return;
		seen.add(inv);
		try {
			inv();
		} catch {
			/* noop */
		}
	};
	for (const inv of toolInvalidators.values()) push(inv);
	for (const g of groups) push(g.invalidator);
	for (const g of archivedGroups) {
		push(g.invalidator);
		if (g.memberInvalidators) for (const inv of g.memberInvalidators.values()) push(inv);
	}
}

/** Whether collapsed tool grouping is enabled (reads settings.json, 2s cache). */
export function isGroupingEnabled(): boolean {
	const now = Date.now();
	if (settingsCache && now - settingsCache.timestamp < SETTINGS_CACHE_TTL_MS) {
		return settingsCache.value;
	}
	const value = readGroupToolCalls();
	settingsCache = { value, timestamp: now };
	return value;
}

/** Drop the settings cache so a /cc-tools group toggle applies immediately. */
export function bustGroupingSettingsCache(): void {
	settingsCache = null;
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

export function registerGrouping(pi: ExtensionAPI): void {
	pi.on("session_start", async () => {
		reset();
		activeSession = true;
	});

	pi.on("session_shutdown", async () => {
		reset();
		activeSession = false;
	});

	pi.on("turn_start", async () => {
		// A pi "turn" is one LLM call within the agent loop: a single user request
		// emits turn_start before every iteration, including those between a tool
		// batch and the thinking/tools that follow. Grouping is therefore
		// RUN-scoped (agent_start..agent_end): archiving here killed a group before
		// its "Thinking for Xs" window and broke cross-iteration aggregation.
		markBlinkActivity();
	});

	// Agent heartbeat: agent_start/agent_end pair per loop run (retries and nested
	// subagent loops included), so depth counts them correctly. While depth > 0 the
	// blink tick is a heartbeat — quiet long-running tools keep blinking.
	pi.on("before_agent_start", async () => {
		markBlinkActivity();
	});

	pi.on("agent_start", async () => {
		agentDepth += 1;
		if (agentDepth === 1) {
			// New run (one user request): archive the previous run's groups and reset
			// run-scoped state. Full ToolRecords therefore live at most one run,
			// which bounds memory across a long session.
			archiveCurrentGroups();
			tools = new Map();
			turnToolOrder = [];
			clearAllHintTimers();
			groups = [];
			toolInvalidators.clear();
			pendingThinkingMs = 0;
			thinkingOpenSince = undefined;
			pendingThinkingText = undefined;
		}
		markBlinkActivity();
	});

	pi.on("agent_end", async () => {
		agentDepth = Math.max(0, agentDepth - 1);
		// Defer so a sibling agent_start (retry/continuation) in the same
		// window re-arms the depth before we decide the run is over.
		queueMicrotask(() => {
			if (agentDepth === 0) {
				// Run finished: settle any leaked pending members (tool_end lost)
				// and stop blink. Do NOT clear on turn_end — a turn ends when the
				// assistant message finishes, BEFORE its tools run.
				settleLeakedGroups();
				stopBlink();
			}
		});
	});

	pi.on("message_start", async (event) => {
		if (event.message.role === "user") markBlinkActivity();
	});

	// Track thinking spans for the collapsed summary's "Thought for Xs".
	pi.on("message_update", async (event) => {
		markBlinkActivity();
		// CC v2.1.234 — a COMPLETED thinking segment's text becomes the active
		// group's ⎿ hint (non-streaming: it appears once the segment ends). The
		// thinking_end stream event carries the full segment text.
		const ame = (event as { assistantMessageEvent?: { type?: string; content?: string } }).assistantMessageEvent;
		if (ame?.type === "thinking_end" && typeof ame.content === "string") {
			const flat = ame.content.replace(/\s+/g, " ").trim();
			if (flat.length > 0) {
				const hint = { value: flat, at: Date.now() };
				const g = groups[groups.length - 1];
				if (g?.active) {
					g.thinkingHint = hint;
					invalidateGroups();
				} else {
					// No active group yet — travels with the next group built
					// (rebuildGroups flush), like pendingThinkingMs.
					pendingThinkingText = hint;
				}
			}
		}
		// Assistant BODY text after a group's tools settles the group (past tense)
		// even mid-generation, and breaks the aggregation window: later tools start
		// a fresh group. Thinking does NOT settle it — "Thinking for Xs, searching…"
		// keeps the present tense.
		if (ame?.type === "text_start") {
			const g = groups[groups.length - 1];
			if (g && !g.running && g.active) {
				g.contentAfter = true;
				g.active = false;
				clearHintTimer(g.hintState);
				invalidateGroups();
			} else if (g) {
				g.contentAfter = true;
			}
			// Sentinel in the run order: rebuildGroups flushes the current group
			// run here, so later tools never merge across the body text.
			if (turnToolOrder.length > 0 && turnToolOrder[turnToolOrder.length - 1] !== GROUP_BREAK) {
				turnToolOrder.push(GROUP_BREAK);
			}
		}
		const content = (event as { message?: { content?: unknown } })?.message?.content;
		if (!Array.isArray(content) || content.length === 0) return;
		// Decide open/close by the LAST (currently-streaming) block, not by "any
		// non-thinking block present". content is the cumulative streaming array, so
		// a text block before a second thinking block would otherwise close and
		// re-open the span in the same tick. Anthropic streams thinking → text →
		// toolCall in order, so the last element is the block being written now.
		const last = content[content.length - 1] as { type?: string };
		const lastIsThinking = last?.type === "thinking";
		if (lastIsThinking) {
			if (thinkingOpenSince === undefined) thinkingOpenSince = Date.now();
		} else if (thinkingOpenSince !== undefined) {
			pendingThinkingMs += Date.now() - thinkingOpenSince;
			thinkingOpenSince = undefined;
		}
	});

	pi.on("message_end", async (event) => {
		if (event.message?.role !== "assistant") return;
		if (thinkingOpenSince !== undefined) {
			pendingThinkingMs += Date.now() - thinkingOpenSince;
			thinkingOpenSince = undefined;
		}
	});

	pi.on("tool_execution_start", async (event) => {
		const record: ToolRecord = {
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			args: event.args,
			status: "pending",
			startedAt: Date.now(),
			classification: undefined,
			result: undefined,
			isError: false,
		};
		// Classify read-only calls for collapse grouping.
		try {
			record.classification = classifyToolCall(event.toolName, event.args);
		} catch {
			record.classification = undefined;
		}
		tools.set(event.toolCallId, record);
		turnToolOrder.push(event.toolCallId);
		rebuildGroups();
		// A still-open thinking span counts toward the group this call joins.
		if (thinkingOpenSince !== undefined) {
			pendingThinkingMs += Date.now() - thinkingOpenSince;
			thinkingOpenSince = undefined;
		}
		markBlinkActivity();
		touchGroup(event.toolCallId);
		invalidateGroups();
		if (record.classification) ensureBlink();
	});

	// Partial tool output is the main long-running signal (bash streams for
	// minutes) — keep the blink watchdog's activity clock fresh.
	pi.on("tool_execution_update", async (event) => {
		markBlinkActivity();
		touchGroup(event.toolCallId);
	});

	pi.on("tool_execution_end", async (event) => {
		const t = tools.get(event.toolCallId);
		standaloneBlinkers.delete(event.toolCallId);
		if (!t) return;
		t.status = event.isError ? "error" : "success";
		t.isError = event.isError;
		t.result = event.result;
		// Refresh group running/active/failed flags.
		const g = groupOf(event.toolCallId);
		if (g) {
			g.running = g.members.some((m) => m.status === "pending");
			g.failed = g.members.some((m) => m.isError);
			// CC's isActiveGroup = hasAnyToolInProgress || (isLoading && !hasContentAfter).
			// The second term keeps the LATEST group in present tense between tool
			// batches — through thinking pauses — until the run ends, body text lands
			// after it, or the next run archives it.
			g.active = g.running || (agentDepth > 0 && groups[groups.length - 1] === g && !g.contentAfter);
			g.lastActiveAt = Date.now();
		}
		markBlinkActivity();
		invalidateGroups();
	});
}

function invalidateGroups(): void {
	for (const g of groups) {
		// Prefer the leader's registered invalidator; fall back to its last-captured
		// render invalidate, because a group formed after its leader already settled
		// has no g.invalidator yet.
		const leaderId = g.members[0]?.toolCallId;
		const invalidate = g.invalidator ?? (leaderId ? toolInvalidators.get(leaderId) : undefined);
		if (invalidate) {
			try {
				invalidate();
			} catch {
				/* noop */
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Render helpers (called from builtins.ts renderCall/renderResult)
// ---------------------------------------------------------------------------

/** Register the leader's invalidate so the group refreshes on member updates.
 *  Called by every member's renderCall/renderResult; every tool's latest
 *  invalidate is recorded so a settled leader can be promoted when a later
 *  member turns its standalone row into a group. */
export function registerGroupInvalidator(toolCallId: string, invalidate: () => void): void {
	toolInvalidators.set(toolCallId, invalidate);
	const g = groupOf(toolCallId);
	if (g && isLeader(toolCallId)) g.invalidator = invalidate;
}

/** Whether this tool should render zero lines (a non-leader group member). */
export function isHiddenGroupMember(toolCallId: string): boolean {
	if (!isGroupingEnabled()) return false;
	const g = groupOf(toolCallId);
	return !!g && !isLeader(toolCallId);
}

export interface GroupRenderInfo {
	group: GroupInfo;
	leader: boolean;
	phase: "collapsed" | "preview";
}

export function getGroupRenderInfo(toolCallId: string, expanded: boolean): GroupRenderInfo | undefined {
	if (!isGroupingEnabled()) return undefined;
	const g = groupOf(toolCallId);
	if (!g || !isLeader(toolCallId)) return undefined;
	return { group: g, leader: true, phase: expanded ? "preview" : "collapsed" };
}

// CC figures.ts: BLACK_CIRCLE = darwin ? '⏺' : '●'.
const BLACK_CIRCLE = process.platform === "darwin" ? "⏺" : "●";

// Glance-line bash command budget; truncation appends `…`.
const GLANCE_COMMAND_MAX = 72;

function statusDot(status: ToolStatus, theme: Theme): string {
	switch (status) {
		case "success":
			return theme.fg("success", BLACK_CIRCLE);
		case "error":
			return theme.fg("error", BLACK_CIRCLE);
		default:
			// CC ToolUseLoader: while unresolved, dim and blinking. No foreground
			// read one notch brighter than every other pending dot.
			return blinkPhase ? theme.fg("dim", BLACK_CIRCLE) : " ";
	}
}

/**
 * The latest hint for the ⎿ line. CC prefers the running operation's hint, then
 * the last hinted call in the group. Here: newest pending member with a hint
 * wins; otherwise the newest member with any hint. undefined (e.g. an all-ls
 * group) blanks the line, matching CC's `incomingHint === undefined`.
 */
function latestHint(g: GroupInfo): CollapseHint | undefined {
	let member: ToolRecord | undefined;
	for (let i = g.members.length - 1; i >= 0; i--) {
		const m = g.members[i]!;
		if (m.status === "pending" && m.classification?.hint) {
			member = m;
			break;
		}
	}
	if (!member) {
		for (let i = g.members.length - 1; i >= 0; i--) {
			const m = g.members[i]!;
			if (m.classification?.hint) {
				member = m;
				break;
			}
		}
	}
	// A thinking segment completed AFTER the newest hinted tool call shows its
	// text on the ⎿ line until the next tool starts; arbitrate by timestamp.
	const th = g.thinkingHint;
	if (th && (!member || th.at > member.startedAt)) {
		return { kind: "thinking", value: th.value };
	}
	return member?.classification?.hint;
}

/**
 * The in-flight hint line for a group: `  ⎿  ` + the latest operation's
 * path/pattern/command, dim, held ≥700ms per distinct value so fast-finishing
 * calls stay readable. Only shown while active.
 */
function hintLineFor(g: GroupInfo, theme: Theme, displayPath: (p: string) => string): string {
	if (!g.active) {
		clearHintTimer(g.hintState);
		g.hintState.displayed = undefined;
		return "";
	}
	// CC derives the live hint from the LATEST hinted operation, not the first
	// pending member: walk newest-first and take the first that carries a hint.
	const raw = latestHint(g);
	const incoming = raw ? formatCollapseHint(raw, displayPath) : undefined;
	const st = g.hintState;
	if (incoming === undefined) {
		clearHintTimer(st);
		st.displayed = undefined;
		return "";
	}
	const now = Date.now();
	if (st.displayed === undefined) {
		st.displayed = incoming;
		st.shownAt = now;
	} else if (incoming !== st.displayed) {
		const elapsed = now - st.shownAt;
		if (elapsed >= HINT_MIN_DISPLAY_MS) {
			clearHintTimer(st);
			st.displayed = incoming;
			st.shownAt = now;
		} else if (st.pending !== incoming) {
			// Newer hint waits its turn; switch when the current one has aged out.
			st.pending = incoming;
			if (st.timer === null) {
				st.timer = setTimeout(() => {
					st.timer = null;
					if (st.pending !== undefined) {
						st.displayed = st.pending;
						st.pending = undefined;
						st.shownAt = Date.now();
					}
					if (g.invalidator) {
						try {
							g.invalidator();
						} catch {
							/* noop */
						}
					}
				}, HINT_MIN_DISPLAY_MS - elapsed);
				st.timer.unref?.();
			}
		}
	}
	// CC indents continuation lines to column 5 (2 lead + ⎿ + 2 gap) so a
	// multi-line command hint reads as one block, not column-0 ragged lines.
	const body = st.displayed.split("\n").join("\n     ");
	return st.displayed !== undefined ? `\n  ${theme.fg("dim", `⎿  ${body}`)}` : "";
}

/** The collapsed summary row (dsh-tui CollapsedGroupComponent). */
export function renderCollapsedSummary(
	info: GroupRenderInfo,
	theme: Theme,
	palette: ResolvedPalette,
	displayPath: (p: string) => string,
): string {
	const g = info.group;
	// CC wraps every count in <Bold>; bold's 22m closes only intensity, so it
	// survives the settled line's dim foreground.
	const summary = collapsedSummary(g, (count) => bold(String(count)));
	// Settled groups render a bare 2-space gutter (no glyph, even on error);
	// active groups render the loader dot, whose error state is dim red and static
	// (a resolved error shows its state, not the pending blink).
	const blinkGutter = (): string => {
		ensureBlink();
		return groupBlinkVisible(g.id) ? `${theme.fg("dim", BLACK_CIRCLE)} ` : "  ";
	};
	const gutter = !g.active ? "  " : g.failed ? `${dim(fg(palette.cc.error, BLACK_CIRCLE))} ` : blinkGutter();
	const text = g.active ? summary : theme.fg("dim", summary);
	// CC CtrlOToExpand: dim "(ctrl+o to expand)", always rendered.
	const hint = italic(theme.fg("dim", "(ctrl+o to expand)"));
	const hintLine = hintLineFor(g, theme, displayPath);
	return `${gutter}${text} ${hint}${hintLine}`;
}

/** Branch prefix for a member's glance line (bare ├/└, no horizontal arm). */
function branchPrefix(index: number, total: number, theme: Theme): string {
	if (index === total - 1) return `${theme.fg("dim", "└")} `;
	return `${theme.fg("dim", "├")} `;
}

function branchContinuation(theme: Theme): string {
	return `${theme.fg("dim", "│")} `;
}

/** Continuation under the LAST member (drawn with `└`): the tree is closed, so
 *  the vertical rail stops. Two spaces keep the result body aligned in the
 *  column `│` would have occupied. */
function branchClosedContinuation(_theme: Theme): string {
	return "  ";
}

/** A member's glance line: `├ ⏺ Read(path)` or `└ ⏺ Bash(cmd)` (CC name/summary colors). */
function glanceLine(
	m: ToolRecord,
	index: number,
	total: number,
	theme: Theme,
	displayPath: (p: string) => string,
): string {
	const prefix = branchPrefix(index, total, theme);
	const dot = statusDot(m.status, theme);
	const label = toolLabel(m.toolName);
	const summary = toolSummary(m, displayPath);
	// CC AssistantToolUseMessage: bold default-color name + (summary) in parens, default color.
	const summaryText = summary ? `(${summary})` : "";
	return `${prefix}${dot} ${theme.bold(label)}${summaryText}`;
}

function toolLabel(name: string): string {
	switch (name) {
		case "read":
			return "Read";
		case "bash":
			return "Bash";
		case "grep":
			// The standalone row calls this tool "Search" (CC userFacingName), so
			// the expanded glance line must use the same name.
			return "Search";
		case "find":
			return "Find";
		case "ls":
			return "List";
		case "edit":
			return "Edit";
		case "write":
			return "Write";
		default:
			return name.startsWith("mcp__") ? "MCP" : name;
	}
}

function toolSummary(m: ToolRecord, displayPath: (p: string) => string): string {
	const args = (m.args ?? {}) as Record<string, unknown>;
	const sp = (v: unknown) => (typeof v === "string" ? displayPath(v) : "");
	switch (m.toolName) {
		case "read":
			return sp(args.path ?? args.file_path);
		case "bash": {
			if (typeof args.command !== "string") return "";
			// Collapse whitespace, then truncate WITH an ellipsis so a long command
			// reads as truncated rather than as ending at 72 chars.
			const flat = args.command.replace(/\s+/g, " ").trim();
			return flat.length > GLANCE_COMMAND_MAX ? `${flat.slice(0, GLANCE_COMMAND_MAX - 1)}…` : flat;
		}
		case "grep":
		case "find": {
			const pattern = typeof args.pattern === "string" ? `"${args.pattern}"` : "";
			const path = sp(args.path);
			return path ? `${pattern} in ${path}` : pattern;
		}
		case "ls":
			return sp(args.path ?? ".");
		default:
			return "";
	}
}

/**
 * The preview-phase group body: glance lines for each member + result previews.
 * Rendered by the leader only.
 */
export function renderGroupPreview(
	info: GroupRenderInfo,
	theme: Theme,
	displayPath: (p: string) => string,
	renderResultLine: (m: ToolRecord) => string,
): string {
	const g = info.group;
	const lines: string[] = [];
	for (let i = 0; i < g.members.length; i++) {
		const m = g.members[i]!;
		const isLast = i === g.members.length - 1;
		lines.push(glanceLine(m, i, g.members.length, theme, displayPath));
		const resultLine = renderResultLine(m);
		if (resultLine) {
			// The last member's glance line uses `└` (the closer), so its result
			// continuation must not re-draw the vertical rail; non-last members
			// continue with `│`.
			const cont = isLast ? branchClosedContinuation(theme) : branchContinuation(theme);
			for (const rl of resultLine.split("\n")) {
				lines.push(`${cont}${rl}`);
			}
		}
	}
	return lines.join("\n");
}

/** Re-export for builtins to classify a tool on demand. */
export { classifyToolCall };

/**
 * Whether a group leader's pending dot is visible this frame. In-budget groups
 * follow the global blink phase; out-of-budget groups (not re-rendered every
 * tick) always show the solid dot so they never freeze on the blank phase.
 */
function groupBlinkVisible(groupId: number): boolean {
	return blinkBudgetGroups.has(groupId) ? blinkPhase : true;
}

/** The blink phase for a non-grouped tool's status dot. Out-of-budget standalone
 *  tools resolve to visible so their dot never freezes blank; in-budget ones
 *  follow the global phase. */
export function currentBlinkPhase(toolCallId?: string): boolean {
	if (toolCallId !== undefined && !blinkBudgetStandalone.has(toolCallId)) return true;
	return blinkPhase;
}

/** Ensure the blink timer runs while a pending tool is visible, and register
 *  the tool's own invalidate so its dot toggles (group leaders use
 *  g.invalidator; standalone tools need their own entry). */
export function armBlink(toolCallId: string, invalidate: () => void): void {
	if (!activeSession) return;
	standaloneBlinkers.set(toolCallId, invalidate);
	ensureBlink();
}

export function makeText(last: unknown, text: string): Text {
	// Reuse `last` only when it really is a Text: an expand toggle may leave a
	// DiffCardComponent (write/edit) behind, and calling setText on it throws.
	const t = last instanceof Text ? last : new Text("", 0, 0);
	t.setText(text);
	return t;
}

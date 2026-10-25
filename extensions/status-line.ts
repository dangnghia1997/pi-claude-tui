/**
 * CC status line: model (+ thinking level) / cwd / git branch / context meter /
 * cost / session totals, via setFooter. Fields mirror CC's StatusLine; the
 * coloring does not — CC stays on dim/muted tokens, while this line gives each
 * datum its own hue from the coral/teal palette (status-colors.ts) and keeps
 * only chrome (separators, cwd, totals) muted. The context segment is a meter
 * (context-bar.ts) rather than CC's bare number, so headroom is legible before
 * auto-compact fires.
 */

import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { isExtraDetail } from "./commands.js";
import { getContextBarMode, getContextBarWidth, onContextBarChange, renderContextSegment } from "./context-bar.js";
import { bold, resolveThemePalette } from "./palette.js";
import { piCoralTeal, statusPainter } from "./status-colors.js";

/**
 * Collapse a home-dir prefix to `~`, CC-style (getDisplayPath): only when the
 * path is actually under home, guarded by a `home + "/"` boundary. A bare
 * `cwd.replace(HOME ?? "", "~")` injects a stray leading `~` when HOME is
 * unset, because `replace("", "~")` matches at index 0.
 */
export function tildeHome(cwd: string): string {
	const home = homedir();
	if (!home) return cwd;
	if (cwd === home) return "~";
	if (cwd.startsWith(`${home}/`)) return `~${cwd.slice(home.length)}`;
	return cwd;
}

// Loose type for the assistant message usage we sum (avoids a direct pi-ai dependency).
interface AssistantUsage {
	usage: { cost: { total: number } };
}

/** <60s "Ns", <1h "Mm Ss", else "Hh Mm Ss". */
function formatDuration(ms: number): string {
	const totalSec = Math.floor(ms / 1000);
	if (totalSec < 60) return `${totalSec}s`;
	const hours = Math.floor(totalSec / 3600);
	const mins = Math.floor((totalSec % 3600) / 60);
	const secs = totalSec % 60;
	if (hours < 1) return `${mins}m ${secs}s`;
	return `${hours}h ${mins}m ${secs}s`;
}

export function registerStatusLine(pi: ExtensionAPI): void {
	// Repaint hook for the context meter: /cc-context and compaction both change
	// what the segment should show, and neither necessarily triggers a redraw on
	// its own. Assigned when the footer factory runs, cleared on dispose.
	let repaint: () => void = () => {};

	// After compaction pi reports tokens as null (it refuses to trust the
	// pre-compaction estimate), so repaint to `ctx ?` immediately rather than
	// keeping the stale percentage until the next message.
	pi.on("session_compact", async () => repaint());

	// The thinking level is session mode, not a per-message value: repaint when it
	// changes so the badge beside the model never shows the old level.
	pi.on("thinking_level_select", async () => repaint());

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		// Session totals: wall-clock plus a user-turn counter. Cost, duration and
		// turns must share one baseline — CC seeds them together on resume
		// (setCostStateForRestore adjusts startTime = Date.now() - lastDuration).
		// Seeding cost from history but starting the clock at the resume moment makes
		// the same line contradict itself, so on resume seed turns from the user
		// messages already in the branch and anchor the clock to the earliest entry.
		//
		// message_end with role "user" fires once per submitted prompt, not per LLM
		// turn, so it isn't inflated by tools, retries, or compaction.
		let cost = 0;
		let turns = 0;
		let earliestMs = Date.now();
		for (const e of ctx.sessionManager.getBranch()) {
			if (e.type === "message" && e.message.role === "assistant") {
				cost += (e.message as unknown as AssistantUsage).usage.cost.total;
			}
			if (e.type === "message" && e.message.role === "user") {
				turns += 1;
			}
			// SessionEntryBase.timestamp is an ISO string.
			if (typeof e.timestamp === "string") {
				const t = Date.parse(e.timestamp);
				if (Number.isFinite(t) && t < earliestMs) earliestMs = t;
			}
		}
		const sessionStartMs = earliestMs;

		pi.on("message_end", async (event) => {
			// Optional-chain the whole path: a failure-path assistant message may
			// carry no usage, and handlers must not throw in the event bus.
			if (event.message?.role === "assistant") {
				cost += (event.message as { usage?: { cost?: { total?: number } } }).usage?.cost?.total ?? 0;
			} else if (event.message?.role === "user") {
				turns += 1;
			}
			// The context estimate moves with every settled reply; without this the
			// meter and the cost/turn totals could sit stale until an unrelated redraw.
			repaint();
		});

		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsub = footerData.onBranchChange(() => tui.requestRender());
			repaint = () => tui.requestRender();
			onContextBarChange(repaint);
			return {
				dispose: () => {
					unsub();
					onContextBarChange(null);
					repaint = () => {};
				},
				invalidate() {},
				render(width: number): string[] {
					const model = ctx.model?.id ?? "no-model";
					// Thinking level rides next to the model like pi's own footer: only for
					// reasoning models, and "off" is shown rather than hidden so the current
					// mode is never ambiguous. Read it from pi, not `ctx` — the context
					// captures the level at session_start and would go stale after a
					// shift+tab / /thinking change.
					const thinking = ctx.model?.reasoning === true ? pi.getThinkingLevel() : undefined;
					const cwd = tildeHome(ctx.cwd);
					const branch = footerData.getGitBranch();
					const usage = ctx.getContextUsage();
					// getContextUsage resolves the model's window; the explicit fallback
					// covers the pre-model frame where it returns undefined.
					const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;

					// One painter per render: resolveThemePalette syncs palette.ts's color
					// mode (256color terminals get cube indices), and the scheme picks the
					// raw hues or their light-theme shade.
					const tint = statusPainter(resolveThemePalette(theme).scheme);
					const muted = tint(piCoralTeal.text.muted);
					const separator = tint(piCoralTeal.separator);

					// Depends only on session state, so it is computed once per render.
					const contextSegment = renderContextSegment(
						{
							tokens: usage?.tokens,
							window: contextWindow,
							mode: getContextBarMode(),
							width: getContextBarWidth(),
							detailed: isExtraDetail(),
						},
						{
							dim: muted,
							label: tint(piCoralTeal.accent.dimTeal),
							track: separator,
							healthy: tint(piCoralTeal.context.healthy),
							warning: tint(piCoralTeal.context.warning),
							high: tint(piCoralTeal.context.high),
							critical: tint(piCoralTeal.context.critical),
						},
					);

					const assemble = (withCwd: boolean, withBranch: boolean, withThinking: boolean): string => {
						// The model is the line's anchor: bold + coral, so it reads first.
						const parts: string[] = [bold(tint(piCoralTeal.semantic.model)(model))];
						if (withThinking && thinking !== undefined) {
							// `thinking` stays quiet; the level itself carries the teal accent.
							const level = thinking === "off" ? muted("off") : tint(piCoralTeal.accent.teal)(thinking);
							parts.push(`${tint(piCoralTeal.accent.dimTeal)("thinking")} ${level}`);
						}
						if (withCwd) parts.push(muted(cwd));
						if (withBranch && branch) parts.push(tint(piCoralTeal.semantic.branch)(`⎇ ${branch}`));
						if (contextSegment) parts.push(contextSegment);
						if (cost > 0) parts.push(tint(piCoralTeal.semantic.cost)(`$${cost.toFixed(2)}`));
						// Session totals; hidden on a fresh session before the first turn
						// completes.
						if (turns > 0) {
							const total = formatDuration(Date.now() - sessionStartMs);
							parts.push(muted(`${total} · ${turns} ${turns === 1 ? "turn" : "turns"}`));
						}
						// extra detail (≈ CC verbose) can flood the screen with thousands of lines
						// per frame, so the status line must show it; otherwise the user cannot tell
						// where the flood comes from. CC has no verbose segment here — this is ours,
						// kept on the quiet dim-teal accent because the ladder hues mean "act".
						if (isExtraDetail()) parts.push(tint(piCoralTeal.accent.dimTeal)("detail"));

						return parts.join(separator(" · "));
					};

					// Narrow terminals: shed cwd, then the branch, then the thinking badge,
					// before truncating. A line cut at the tail loses exactly the meter this
					// extension adds (plus cost and totals) — the context segment is what a
					// squeezed terminal still needs to see.
					let line = assemble(true, true, true);
					if (visibleWidth(line) > width) line = assemble(false, true, true);
					if (visibleWidth(line) > width) line = assemble(false, false, true);
					if (visibleWidth(line) > width) line = assemble(false, false, false);
					return [truncateToWidth(line, width, "")];
				},
			};
		});
	});
}

/**
 * CC turn footer: `✻ Worked for 45s`, dim, printed after every request that
 * took at least a second. Persisted via appendEntry so it survives reload and
 * resume.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

// CC's past-tense turn verbs (dsh-tui transcript.ts TURN_COMPLETION_VERBS).
const TURN_COMPLETION_VERBS = [
	"Baked",
	"Brewed",
	"Churned",
	"Cogitated",
	"Cooked",
	"Crunched",
	"Sautéed",
	"Worked",
] as const;

// CC v2.1.234 prints the footer for every request, so the old 30s threshold is
// gone. Only sub-second turns are skipped: a "0s" footer is noise CC never shows.
const TURN_FOOTER_MIN_MS = 1_000;

// `45s`, `1m 23s`, `2h 5m 1s` (dsh-tui formatTurnDuration).
export function formatTurnDuration(ms: number): string {
	const elapsed = Math.max(0, ms);
	if (elapsed < 60_000) return `${Math.floor(elapsed / 1000)}s`;
	let seconds = Math.round((elapsed % 60_000) / 1000);
	let minutes = Math.floor((elapsed % 3_600_000) / 60_000);
	let hours = Math.floor(elapsed / 3_600_000);
	if (seconds === 60) {
		seconds = 0;
		minutes += 1;
	}
	if (minutes === 60) {
		minutes = 0;
		hours += 1;
	}
	return hours > 0 ? `${hours}h ${minutes}m ${seconds}s` : `${minutes}m ${seconds}s`;
}

function sampleTurnVerb(): string {
	return TURN_COMPLETION_VERBS[Math.floor(Math.random() * TURN_COMPLETION_VERBS.length)] ?? "Worked";
}

interface TurnFooterData {
	ms: number;
	verb: string;
}

export function registerTurnFooter(pi: ExtensionAPI): void {
	// CC's footer is per request, not per LLM call: it appends one line when the
	// query completes. A pi `turn` is a single agent-loop iteration (one reply
	// plus its tools), so one request spans many turn_start/turn_end pairs — keying
	// the footer on turn_end printed one line per iteration.
	//
	// The request boundary is agent_start … agent_settled: the session runs the
	// initial prompt plus any retries, compaction, or queued follow-ups, then fires
	// a single agent_settled in its finally. Start the clock on the first
	// agent_start and settle exactly once, matching CC's one-line-per-request
	// semantics.
	let requestStartMs = 0;

	pi.on("agent_start", async () => {
		// Continuation runs keep the original start time, like CC's
		// loadingStartTimeRef, so the duration covers the whole request.
		if (!requestStartMs) requestStartMs = Date.now();
	});

	pi.on("agent_settled", async () => {
		if (!requestStartMs) return;
		const duration = Date.now() - requestStartMs;
		requestStartMs = 0;
		if (duration < TURN_FOOTER_MIN_MS) return;
		// CC samples a fresh random verb when it creates the completion message.
		pi.appendEntry<TurnFooterData>("cc-turn-footer", { ms: duration, verb: sampleTurnVerb() });
	});

	pi.registerEntryRenderer<TurnFooterData>("cc-turn-footer", (entry, _options, theme) => {
		const data = entry.data ?? { ms: 0, verb: "Worked" };
		// One leading space puts the ✻ in the same column as the assistant bullet
		// (dsh-tui GUTTER).
		return new Text(theme.fg("dim", ` ✻ ${data.verb} for ${formatTurnDuration(data.ms)}`), 0, 0);
	});
}

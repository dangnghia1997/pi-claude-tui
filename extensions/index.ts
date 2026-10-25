/**
 * pi-claude-tui — Claude Code's visual identity for pi.
 *
 *   themes/   CC color themes (JSON, loaded by pi)
 *   chrome    banner, spinner, status line, turn footer, prompt pointer
 *   tools/    CC-style tool rendering (builtins, diff, grouping)
 *   thinking  CC-style thinking title, collapsed body, spinner byline
 *
 * Everything here uses pi's public extension API. host-patches.ts adds two
 * prototype patches on public pi exports to fix host-side rendering; see its
 * header for scope. Per-module headers map each surface to its CC source.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerBanner } from "./banner.js";
import { registerCommands } from "./commands.js";
import { installHostPatches } from "./host-patches.js";
import { registerPromptPointer } from "./prompt-editor.js";
import { registerSpinner } from "./spinner.js";
import { registerStatusLine } from "./status-line.js";
import { registerThinking } from "./thinking.js";
import { registerBuiltins } from "./tools/builtins.js";
import { registerGrouping } from "./tools/grouping.js";
import { registerTurnFooter } from "./turn-footer.js";

export default function (pi: ExtensionAPI) {
	// Host patches must land before the first render.
	installHostPatches();

	// Chrome
	registerSpinner(pi);
	registerTurnFooter(pi);
	registerBanner(pi);
	registerStatusLine(pi);
	registerPromptPointer(pi);

	// Tool rendering
	registerGrouping(pi);
	registerBuiltins(pi);

	// Thinking: markdown transformer, hidden label, spinner byline
	registerThinking(pi);

	// Commands + shortcuts
	registerCommands(pi);
}

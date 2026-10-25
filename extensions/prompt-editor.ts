/**
 * CC prompt pointer: the `❯ ` at the head of the input box.
 *
 * We extend pi's CustomEditor rather than the bare pi-tui Editor so app
 * keybindings and extension shortcuts keep working, then paint the pointer into
 * the left padding of the first content row. It uses the editor's border color,
 * so pi's bash-mode border swap recolors it with the rest of the frame.
 */
import type { ExtensionAPI, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";

/** Width of the `❯ ` pointer in columns. */
const PROMPT_COL = 2;

export class PromptEditor extends CustomEditor {
	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
		super(tui, theme, keybindings, { paddingX: PROMPT_COL });
	}

	/** The host copies the default editor's paddingX onto a custom editor after
	 *  construction; keep at least the pointer width so `❯` never overwrites text. */
	override setPaddingX(padding: number): void {
		super.setPaddingX(Math.max(padding, PROMPT_COL));
	}

	override render(width: number): string[] {
		const rows = super.render(width);
		// rows[0] is the top border; rows[1] starts with paddingX spaces. Narrow
		// widths can clamp that padding below 2 — skip painting rather than eat a
		// column.
		const first = rows[1];
		if (first?.startsWith("  ")) {
			rows[1] = `${this.borderColor("❯")} ${first.slice(2)}`;
		}
		return rows;
	}
}

export function registerPromptPointer(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setEditorComponent((tui, theme, keybindings) => new PromptEditor(tui, theme, keybindings));
	});
}

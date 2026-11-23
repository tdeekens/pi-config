// Footer segments that replace powerline's built-in `thinking` and `path`:
//
//   thinking-dots:  ●●●○○            (hidden for models without reasoning)
//   smart-path:      pi-config › extensions/budget
//
// Published as extension statuses; place them with powerline customItems (selfColorize: true).
// The folder icon is shown only when POWERLINE_NERD_FONTS=1, matching powerline's own icons.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { FOLDER_ICON, type Painter, renderPath, renderThinking } from "./render.ts";

const THINKING_KEY = "thinking-dots";
const PATH_KEY = "smart-path";

/** Nearest ancestor (or self) containing `.git` (directory, or file for worktrees/submodules). */
function findRepoRoot(start: string): string | undefined {
	let dir = start;
	for (;;) {
		if (existsSync(join(dir, ".git"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

export default function footerSegments(pi: ExtensionAPI) {
	const repoCache = new Map<string, string | undefined>();

	const repoRootFor = (cwd: string): string | undefined => {
		if (!repoCache.has(cwd)) repoCache.set(cwd, findRepoRoot(cwd));
		return repoCache.get(cwd);
	};

	const painterFor = (ctx: ExtensionContext): Painter => {
		const theme = ctx.ui.theme;
		return { fg: (color, text) => theme.fg(color, text), bold: (text) => theme.bold(text) };
	};

	const update = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		try {
			const painter = painterFor(ctx);

			const reasoning = ctx.model?.reasoning === true;
			ctx.ui.setStatus(THINKING_KEY, reasoning ? renderThinking(pi.getThinkingLevel(), painter) : undefined);

			const icon = process.env.POWERLINE_NERD_FONTS === "1" ? FOLDER_ICON : "";
			const cwd = ctx.cwd;
			ctx.ui.setStatus(PATH_KEY, renderPath({ cwd, home: homedir(), repoRoot: repoRootFor(cwd) }, painter, icon));
		} catch {
			// Never break the session over a footer.
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		repoCache.clear();
		update(ctx);
	});
	pi.on("model_select", async (_event, ctx) => update(ctx));
	pi.on("thinking_level_select", async (_event, ctx) => update(ctx));
	// A repo may be created or the cwd changed (/cd) mid-session.
	pi.on("turn_end", async (_event, ctx) => {
		repoCache.delete(ctx.cwd);
		update(ctx);
	});
}

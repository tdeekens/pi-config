// Pure rendering for two footer segments: thinking dots and a smart path.
// No Pi imports, so the test script can run it directly with Node.

export type Color =
	| "dim"
	| "muted"
	| "text"
	| "accent"
	| "thinkingOff"
	| "thinkingMinimal"
	| "thinkingLow"
	| "thinkingMedium"
	| "thinkingHigh"
	| "thinkingXhigh"
	| "thinkingMax";

export interface Painter {
	fg(color: Color, text: string): string;
	bold(text: string): string;
}

export const plainPainter: Painter = { fg: (_c, t) => t, bold: (t) => t };

// ---------------------------------------------------------------------------
// Thinking dots: ●●●○○
// ---------------------------------------------------------------------------

export const DOTS = 5;

const FILLED: Record<string, number> = { off: 0, minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5, max: 5 };

const LEVEL_COLOR: Record<string, Color> = {
	minimal: "thinkingMinimal",
	low: "thinkingLow",
	medium: "thinkingMedium",
};

/** Cool-to-warm sequence used per dot for high, xhigh and max (the "rainbow" levels). */
const GRADIENT: Color[] = ["thinkingLow", "thinkingMedium", "thinkingHigh", "thinkingXhigh", "thinkingMax"];

export function filledDots(level: string): number {
	return FILLED[level] ?? 0;
}

export function renderThinking(level: string, p: Painter): string {
	const filled = filledDots(level);
	const rainbow = level === "high" || level === "xhigh" || level === "max";
	let out = "";
	for (let i = 0; i < DOTS; i++) {
		if (i >= filled) {
			out += p.fg("dim", "○");
			continue;
		}
		const color = rainbow ? GRADIENT[i] : (LEVEL_COLOR[level] ?? "thinkingOff");
		out += p.fg(color, "●");
	}
	// xhigh and max both fill every dot; max is set apart by bold.
	return level === "max" ? p.bold(out) : out;
}

// ---------------------------------------------------------------------------
// Smart path: ~ · repo › sub/dir · ~/abbreviated/path
// ---------------------------------------------------------------------------

export const SUBPATH_MAX = 30;
export const OUTSIDE_MAX = 40;
export const FOLDER_ICON = "\uF07B"; // nf-fa-folder

/** Shorten a /-separated path from the left, keeping whole trailing segments: `…/components/table`. */
export function shortenLeft(path: string, max: number): string {
	if (path.length <= max) return path;
	const parts = path.split("/");
	let kept = parts[parts.length - 1] ?? path;
	for (let i = parts.length - 2; i >= 0; i--) {
		const next = `${parts[i]}/${kept}`;
		if (next.length + 2 > max) break;
		kept = next;
	}
	const result = `…/${kept}`;
	// A single very long last segment: hard-cut it.
	return result.length > max ? `…${path.slice(-(max - 1))}` : result;
}

export interface PathInfo {
	cwd: string;
	home: string | undefined;
	/** Absolute path of the enclosing git repository root, if any. */
	repoRoot: string | undefined;
}

function relativeTo(root: string, path: string): string {
	if (path === root) return "";
	return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}

function basename(path: string): string {
	const trimmed = path.replace(/\/+$/, "");
	return trimmed.slice(trimmed.lastIndexOf("/") + 1) || trimmed;
}

export function renderPath(info: PathInfo, p: Painter, icon: string): string {
	const prefix = icon ? `${p.fg("accent", icon)} ` : "";
	const { cwd, home, repoRoot } = info;

	if (home && cwd === home) return `${prefix}${p.fg("text", "~")}`;

	if (repoRoot) {
		const name = p.bold(p.fg("text", basename(repoRoot)));
		const sub = relativeTo(repoRoot, cwd);
		if (!sub) return `${prefix}${name}`;
		return `${prefix}${name} ${p.fg("muted", "›")} ${p.fg("muted", shortenLeft(sub, SUBPATH_MAX))}`;
	}

	const display = home && cwd.startsWith(`${home}/`) ? `~/${cwd.slice(home.length + 1)}` : cwd;
	return `${prefix}${p.fg("text", shortenLeft(display, OUTSIDE_MAX))}`;
}

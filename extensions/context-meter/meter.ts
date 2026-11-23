// Pure logic for the context meter: compaction point, scaling, cell allocation and rendering.
// No Pi imports, so the test script can run it directly with Node.

export type Color = "accent" | "success" | "warning" | "error" | "muted" | "dim" | "text" | "syntaxKeyword" | "mdLink" | "borderAccent";

/** Minimal theme surface used for rendering; an identity painter gives plain text. */
export interface Painter {
	fg(color: Color, text: string): string;
	bold(text: string): string;
}

export const plainPainter: Painter = { fg: (_c, t) => t, bold: (t) => t };

export interface Category {
	id: string;
	label: string;
	color: Color;
	tokens: number;
}

export interface Compaction {
	enabled: boolean;
	/** Token count above which automatic compaction starts (window - reserve). */
	threshold: number;
	reserve: number;
}

export const DEFAULT_RESERVE = 16384;

function nonNegativeInt(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Resolve compaction settings for a model: model override, then ordinary setting, then default. */
export function resolveCompaction(window: number, settings: unknown, modelKey: string | undefined): Compaction {
	const compaction = (settings as { compaction?: Record<string, unknown> } | undefined)?.compaction ?? {};
	const overrides = compaction.modelOverrides as Record<string, Record<string, unknown>> | undefined;
	const override = modelKey && overrides && typeof overrides === "object" ? overrides[modelKey] : undefined;
	const reserve = nonNegativeInt(override?.reserveTokens) ?? nonNegativeInt(compaction.reserveTokens) ?? DEFAULT_RESERVE;
	const enabled = compaction.enabled !== false;
	return { enabled, reserve, threshold: Math.max(0, window - reserve) };
}

/** Scale category estimates so they sum to the real total. Returns the factor used. */
export function scaleToTotal(categories: Category[], total: number): { categories: Category[]; factor: number } {
	const sum = categories.reduce((acc, c) => acc + c.tokens, 0);
	if (sum <= 0) return { categories: categories.map((c) => ({ ...c, tokens: 0 })), factor: 1 };
	const factor = total / sum;
	return { categories: categories.map((c) => ({ ...c, tokens: Math.round(c.tokens * factor) })), factor };
}

export function isRough(factor: number): boolean {
	return factor < 0.5 || factor > 2;
}

/**
 * Split `cells` across values proportionally (largest remainder).
 * Every non-zero value gets at least one cell, as long as there are enough cells.
 */
export function allocateCells(values: number[], cells: number): number[] {
	const total = values.reduce((acc, v) => acc + Math.max(0, v), 0);
	const result = values.map(() => 0);
	if (total <= 0 || cells <= 0) return result;

	const ideal = values.map((v) => (Math.max(0, v) / total) * cells);
	for (let i = 0; i < values.length; i++) {
		result[i] = Math.floor(ideal[i]);
		if (values[i] > 0 && result[i] === 0) result[i] = 1;
	}

	let assigned = result.reduce((a, b) => a + b, 0);
	// Too few: hand out remaining cells by largest remainder.
	const byRemainder = values
		.map((_, i) => i)
		.filter((i) => values[i] > 0)
		.sort((a, b) => ideal[b] - result[b] - (ideal[a] - result[a]));
	for (let k = 0; assigned < cells && byRemainder.length > 0; k++) {
		result[byRemainder[k % byRemainder.length]]++;
		assigned++;
	}
	// Too many (minimum-one rule overflowed): take from the largest allocations, keeping one each.
	while (assigned > cells) {
		let largest = -1;
		for (let i = 0; i < result.length; i++) {
			if (result[i] > 1 && (largest === -1 || result[i] > result[largest])) largest = i;
		}
		if (largest === -1) {
			// Every value already has one cell; drop the smallest values.
			let smallest = -1;
			for (let i = 0; i < result.length; i++) {
				if (result[i] > 0 && (smallest === -1 || values[i] < values[smallest])) smallest = i;
			}
			result[smallest]--;
		} else {
			result[largest]--;
		}
		assigned--;
	}
	return result;
}

export function formatTokens(n: number): string {
	const v = Math.max(0, Math.round(n));
	if (v < 1000) return String(v);
	if (v < 1_000_000) {
		const k = v / 1000;
		return k < 10 ? `${trim(k.toFixed(1))}k` : `${Math.round(k)}k`;
	}
	return `${trim((v / 1_000_000).toFixed(1))}M`;
}

function trim(s: string): string {
	return s.endsWith(".0") ? s.slice(0, -2) : s;
}

export function formatPercent(part: number, whole: number): string {
	if (whole <= 0 || part <= 0) return "0%";
	const pct = (part / whole) * 100;
	if (pct < 0.1) return "<0.1%";
	return `${pct.toFixed(1)}%`;
}

export type Level = "normal" | "warn" | "error";

/** Warning level measured against the compaction point, or the full window if compaction is off. */
export function levelFor(used: number, window: number, compaction: Compaction): Level {
	const limit = compaction.enabled ? compaction.threshold : window;
	if (limit <= 0) return "normal";
	const ratio = used / limit;
	if (ratio >= 0.9) return "error";
	if (ratio >= 0.7) return "warn";
	return "normal";
}

const LEVEL_COLOR: Record<Level, Color> = { normal: "accent", warn: "warning", error: "error" };

export interface Snapshot {
	used: number;
	/** True when the total is an estimate (Pi reported it as unknown). */
	estimated: boolean;
	window: number;
	compaction: Compaction;
}

export const BAR_CELLS = 10;

/** Footer: `▰▰▰▱▱▱▱▱▱┆ 25k/1M · ⇥984k` */
export function renderFooter(s: Snapshot, p: Painter): string {
	if (s.window <= 0) return "";
	const level = levelFor(s.used, s.window, s.compaction);
	const color = LEVEL_COLOR[level];
	const frac = Math.min(1, s.used / s.window);
	const filled = s.used > 0 ? Math.max(1, Math.round(frac * BAR_CELLS)) : 0;
	const markerIdx = s.compaction.enabled
		? Math.min(BAR_CELLS - 1, Math.floor((s.compaction.threshold / s.window) * BAR_CELLS))
		: -1;

	let bar = "";
	for (let i = 0; i < BAR_CELLS; i++) {
		if (i === markerIdx) bar += p.fg(i < filled ? color : "muted", "┆");
		else if (i < filled) bar += p.fg(color, "▰");
		else bar += p.fg("dim", "▱");
	}

	const usedText = `${s.estimated ? "~" : ""}${formatTokens(s.used)}/${formatTokens(s.window)}`;
	const text = level === "normal" ? p.fg("muted", usedText) : p.fg(color, usedText);
	const marker = s.compaction.enabled ? p.fg("dim", ` · ⇥${formatTokens(s.compaction.threshold)}`) : "";
	return `${bar} ${text}${marker}`;
}

export const GRID_COLS = 10;
export const GRID_ROWS = 5;

export interface GridCell {
	kind: "category" | "free" | "buffer";
	color: Color;
}

/** Lay out grid cells: used categories, then free space, then the compaction buffer. */
export function layoutGrid(categories: Category[], s: Snapshot): GridCell[] {
	const used = categories.reduce((acc, c) => acc + c.tokens, 0);
	const limit = s.compaction.enabled ? s.compaction.threshold : s.window;
	const free = Math.max(0, limit - used);
	const buffer = s.compaction.enabled ? Math.max(0, s.window - Math.max(used, s.compaction.threshold)) : 0;

	const values = [...categories.map((c) => c.tokens), free, buffer];
	const counts = allocateCells(values, GRID_COLS * GRID_ROWS);
	const cells: GridCell[] = [];
	categories.forEach((c, i) => {
		for (let k = 0; k < counts[i]; k++) cells.push({ kind: "category", color: c.color });
	});
	for (let k = 0; k < counts[categories.length]; k++) cells.push({ kind: "free", color: "dim" });
	for (let k = 0; k < counts[categories.length + 1]; k++) cells.push({ kind: "buffer", color: "dim" });
	return cells;
}

export interface Breakdown {
	categories: Category[];
	snapshot: Snapshot;
	rough: boolean;
}

function padEnd(text: string, width: number, visible: (s: string) => number): string {
	return text + " ".repeat(Math.max(0, width - visible(text)));
}

/** Overlay body lines: grid on the left, header and legend on the right. */
export function renderOverlay(b: Breakdown, p: Painter, visible: (s: string) => number = (s) => s.length): string[] {
	const { snapshot: s } = b;
	const shown = b.categories.filter((c) => c.tokens > 0);
	const cells = layoutGrid(shown, s);

	const gridLines: string[] = [];
	for (let r = 0; r < GRID_ROWS; r++) {
		let line = "";
		for (let c = 0; c < GRID_COLS; c++) {
			const idx = r * GRID_COLS + c;
			const cell = cells[idx];
			const sep = cell?.kind === "buffer" && cells[idx - 1]?.kind !== "buffer" ? p.fg("muted", "┆") : " ";
			const glyph = !cell ? " " : cell.kind === "category" ? p.fg(cell.color, "■") : cell.kind === "free" ? p.fg("dim", "□") : p.fg("dim", "░");
			line += (c === 0 ? "" : sep) + glyph;
		}
		gridLines.push(line);
	}

	const used = shown.reduce((acc, c) => acc + c.tokens, 0);
	const approx = s.estimated ? "~" : "";
	let header = `${p.bold(`${approx}${formatTokens(used)} / ${formatTokens(s.window)}`)} ${p.fg("muted", `(${formatPercent(used, s.window)})`)}`;
	if (s.compaction.enabled) header += p.fg("muted", ` · compacts at ${formatTokens(s.compaction.threshold)}`);
	if (b.rough) header += p.fg("warning", " (rough)");

	const labelWidth = Math.max(18, ...shown.map((c) => c.label.length + 2));
	const row = (glyph: string, label: string, tokens: string, pct: string) =>
		`${glyph} ${label.padEnd(labelWidth)}${tokens.padStart(7)}  ${pct}`;

	const legend: string[] = [header, ""];
	for (const c of shown) {
		legend.push(row(p.fg(c.color, "■"), c.label, `≈${formatTokens(c.tokens)}`, p.fg("muted", formatPercent(c.tokens, s.window).padStart(6))));
	}
	const limit = s.compaction.enabled ? s.compaction.threshold : s.window;
	const free = Math.max(0, limit - used);
	legend.push(row(p.fg("dim", "□"), "Free", formatTokens(free), p.fg("muted", formatPercent(free, s.window).padStart(6))));
	if (s.compaction.enabled) {
		const buffer = Math.max(0, s.window - Math.max(used, s.compaction.threshold));
		legend.push(row(p.fg("dim", "░"), "Compaction buffer", formatTokens(buffer), p.fg("muted", formatPercent(buffer, s.window).padStart(6))));
	}

	const gridWidth = GRID_COLS * 2 - 1;
	const lines: string[] = [];
	const rows = Math.max(gridLines.length, legend.length);
	for (let i = 0; i < rows; i++) {
		lines.push(`${padEnd(gridLines[i] ?? "", gridWidth, visible)}     ${legend[i] ?? ""}`.trimEnd());
	}
	if (s.compaction.enabled) lines.push("", p.fg("dim", "┆ marks where automatic compaction starts"));
	return lines;
}

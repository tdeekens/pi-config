// Pure rendering for the budget footer and the /budget overlay.
// No Pi imports, so the test script can run it directly with Node.

export type Color = "success" | "warning" | "error" | "muted" | "dim" | "text" | "accent";

export interface Painter {
	fg(color: Color, text: string): string;
	bold(text: string): string;
}

export const plainPainter: Painter = { fg: (_c, t) => t, bold: (t) => t };

export interface Period {
	key: "d" | "w" | "m";
	label: string;
	spent: number;
	limit: number;
	/** Next reset, epoch ms (UTC). */
	resetsAt: number;
}

export interface Totals {
	periods: Period[];
	session: number;
}

export type Level = "normal" | "warn" | "error";

/** Same thresholds as the context meter: yellow from 70%, red from 90% of the limit. */
export function levelFor(spent: number, limit: number): Level {
	if (limit <= 0) return spent > 0 ? "error" : "normal";
	const ratio = spent / limit;
	if (ratio >= 0.9) return "error";
	if (ratio >= 0.7) return "warn";
	return "normal";
}

const LEVEL_COLOR: Record<Level, Color> = { normal: "success", warn: "warning", error: "error" };

export function levelColor(spent: number, limit: number): Color {
	return LEVEL_COLOR[levelFor(spent, limit)];
}

/** Filled cells for a bar: at least one once anything is spent, all of them at or over the limit. */
export function filledCells(spent: number, limit: number, cells: number): number {
	if (spent <= 0) return 0;
	if (limit <= 0 || spent >= limit) return cells;
	return Math.min(cells, Math.max(1, Math.round((spent / limit) * cells)));
}

export function bar(spent: number, limit: number, cells: number, p: Painter): string {
	const filled = filledCells(spent, limit, cells);
	return p.fg(levelColor(spent, limit), "▰".repeat(filled)) + p.fg("dim", "▱".repeat(cells - filled));
}

/** Compact euro amount: one decimal below €10, whole euros above. */
export function shortEur(value: number): string {
	const v = Math.max(0, value);
	if (v < 10) {
		const s = v.toFixed(1);
		return s.endsWith(".0") ? s.slice(0, -2) : s;
	}
	return String(Math.round(v));
}

export const FOOTER_CELLS = 3;

/** Footer: `~€ d ▰▱▱ 18/50  w ▰▱▱ 24/150  m ▱▱▱ 25/600 · s 3.60` */
export function renderFooter(t: Totals, p: Painter): string {
	const parts = t.periods.map((period) => {
		const color = levelColor(period.spent, period.limit);
		const amount = p.fg(color, shortEur(period.spent)) + p.fg("muted", `/${shortEur(period.limit)}`);
		return `${p.fg("muted", period.key)} ${bar(period.spent, period.limit, FOOTER_CELLS, p)} ${amount}`;
	});
	const session = `${p.fg("muted", "s")} ${p.fg("text", t.session.toFixed(2))}`;
	return `${p.fg("muted", "~€")} ${parts.join("  ")} ${p.fg("dim", "·")} ${session}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function describeReset(period: Period): string {
	const d = new Date(period.resetsAt);
	if (period.key === "d") return "resets 00:00 UTC";
	if (period.key === "w") return `resets ${DAYS[d.getUTCDay()]}`;
	return `resets ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

function percent(spent: number, limit: number): string {
	if (limit <= 0) return "—";
	return `${Math.round((spent / limit) * 100)}%`;
}

export const OVERLAY_CELLS = 10;

/** Overlay body lines for /budget. */
export function renderOverlay(t: Totals, p: Painter): string[] {
	const lines: string[] = [];
	for (const period of t.periods) {
		const color = levelColor(period.spent, period.limit);
		const money = `€${period.spent.toFixed(2)} / €${period.limit}`.padEnd(17);
		lines.push(
			`${period.label.padEnd(8)}${bar(period.spent, period.limit, OVERLAY_CELLS, p)}  ${p.fg(color, money)}${p.fg(color, percent(period.spent, period.limit).padStart(4))}  ${p.fg("muted", describeReset(period))}`,
		);
	}
	lines.push(`${"Session".padEnd(8)}${" ".repeat(OVERLAY_CELLS)}  ${p.fg("text", `€${t.session.toFixed(2)}`)}`);
	return lines;
}

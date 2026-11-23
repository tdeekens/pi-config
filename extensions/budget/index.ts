// example budget estimator.
// Estimates EUR spend from token usage on this machine and shows it in the footer:
//   budget day €X/€40 · week €Y/€92 · month €Z/€400 (est)
//
// Configuration: ~/.pi/agent/budget.json (optional). Missing or invalid values fall back
// to the defaults below. The file is re-read on each session start and each assistant reply.
//
// Estimates only: spend from other machines is not counted, and example's own accounting
// is the source of truth.

import { appendFileSync, existsSync, mkdirSync, readFileSync, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "budget";
const AGENT_DIR = join(homedir(), ".pi", "agent");
const CONFIG_FILE = join(AGENT_DIR, "budget.json");
const LEDGER = join(AGENT_DIR, "budget", "spend.jsonl");

interface Price {
	input: number;
	output: number;
	cacheWrite: number;
	cacheRead: number;
}

interface BudgetConfig {
	limits: { dailyEur: number; weeklyEur: number; monthlyEur: number };
	rolloutDate: string; // YYYY-MM-DD, UTC. Spend before this date is ignored.
	weeklyResetDay: string; // sunday..saturday, 00:00 UTC
	prices: Record<string, Price>; // EUR per 1M tokens, keyed by model id
}

// Defaults: budget from the example rollout post and the Vertex list-price table.
const DEFAULT_CONFIG: BudgetConfig = {
	limits: { dailyEur: 50, weeklyEur: 150, monthlyEur: 600 },
	rolloutDate: "2000-01-01",
	weeklyResetDay: "thursday",
	prices: {
		"claude-opus-5-5": { input: 3.52, output: 17.6, cacheWrite: 4.4, cacheRead: 0.18 },
		"claude-sonnet-5-5": { input: 1.76, output: 8.8, cacheWrite: 2.2, cacheRead: 0.09 },
		"claude-haiku-5-5": { input: 0.09, output: 0.44, cacheWrite: 0.11, cacheRead: 0.01 },
		"gemini-3-8-flash": { input: 1.32, output: 6.6, cacheWrite: 1.32, cacheRead: 0.13 },
		"example-model-b": { input: 3.52, output: 17.6, cacheWrite: 3.52, cacheRead: 0.18 },
	},
};

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

interface LoadResult {
	config: BudgetConfig;
	problems: string[];
}

function isNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function parseDate(value: unknown): number | undefined {
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
	const ms = Date.parse(`${value}T00:00:00Z`);
	return Number.isFinite(ms) ? ms : undefined;
}

/** Read budget.json, keeping defaults for anything missing or invalid. */
function loadConfig(): LoadResult {
	const problems: string[] = [];
	const config: BudgetConfig = structuredClone(DEFAULT_CONFIG);
	if (!existsSync(CONFIG_FILE)) return { config, problems };

	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
	} catch (error) {
		problems.push(`budget.json is not valid JSON; using defaults (${(error as Error).message})`);
		return { config, problems };
	}
	if (typeof raw !== "object" || raw === null) {
		problems.push("budget.json must be an object; using defaults");
		return { config, problems };
	}
	const data = raw as Record<string, unknown>;

	const limits = data.limits as Record<string, unknown> | undefined;
	if (limits && typeof limits === "object") {
		for (const key of ["dailyEur", "weeklyEur", "monthlyEur"] as const) {
			if (limits[key] === undefined) continue;
			if (isNumber(limits[key])) config.limits[key] = limits[key];
			else problems.push(`limits.${key} must be a number >= 0; using default`);
		}
	}

	if (data.rolloutDate !== undefined) {
		if (parseDate(data.rolloutDate) !== undefined) config.rolloutDate = data.rolloutDate as string;
		else problems.push("rolloutDate must be YYYY-MM-DD; using default");
	}

	if (data.weeklyResetDay !== undefined) {
		const day = typeof data.weeklyResetDay === "string" ? data.weeklyResetDay.toLowerCase() : "";
		if (WEEKDAYS.includes(day)) config.weeklyResetDay = day;
		else problems.push(`weeklyResetDay must be one of ${WEEKDAYS.join(", ")}; using default`);
	}

	const prices = data.prices as Record<string, unknown> | undefined;
	if (prices && typeof prices === "object") {
		for (const [model, value] of Object.entries(prices)) {
			const p = value as Record<string, unknown> | undefined;
			if (p && isNumber(p.input) && isNumber(p.output) && isNumber(p.cacheWrite) && isNumber(p.cacheRead)) {
				config.prices[model] = { input: p.input, output: p.output, cacheWrite: p.cacheWrite, cacheRead: p.cacheRead };
			} else {
				problems.push(`prices.${model} needs input, output, cacheWrite, cacheRead as numbers; ignored`);
			}
		}
	}

	return { config, problems };
}

interface SpendRecord {
	ts: number; // epoch ms
	model: string;
	eur: number;
	session?: string; // session id; absent on records written before per-session tracking
}

function priceFor(config: BudgetConfig, model: string): Price | undefined {
	// Match by suffix so provider prefixes still resolve.
	const key = Object.keys(config.prices).find((k) => model === k || model.endsWith(`/${k}`));
	return key ? config.prices[key] : undefined;
}

function estimateEur(
	config: BudgetConfig,
	model: string,
	usage: { input: number; output: number; cacheRead: number; cacheWrite: number },
): number | undefined {
	const p = priceFor(config, model);
	if (!p) return undefined;
	return (
		(usage.input * p.input + usage.output * p.output + usage.cacheWrite * p.cacheWrite + usage.cacheRead * p.cacheRead) /
		1_000_000
	);
}

function readLedger(): SpendRecord[] {
	if (!existsSync(LEDGER)) return [];
	const records: SpendRecord[] = [];
	for (const line of readFileSync(LEDGER, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			records.push(JSON.parse(line) as SpendRecord);
		} catch {
			// Skip malformed lines rather than failing the footer.
		}
	}
	return records;
}

function appendRecord(record: SpendRecord): void {
	mkdirSync(dirname(LEDGER), { recursive: true });
	appendFileSync(LEDGER, `${JSON.stringify(record)}\n`);
}

/** Start of the current daily window: today 00:00 UTC. */
function dayStart(now: Date): number {
	return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

/** Start of the current weekly window: most recent configured weekday 00:00 UTC. */
function weekStart(now: Date, resetDay: string): number {
	const resetDow = WEEKDAYS.indexOf(resetDay);
	const daysSince = (now.getUTCDay() - resetDow + 7) % 7;
	return dayStart(now) - daysSince * 86_400_000;
}

/** Start of the current monthly window: 1st of the month 00:00 UTC. */
function monthStart(now: Date): number {
	return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
}

function sumSince(records: SpendRecord[], since: number): number {
	let total = 0;
	for (const r of records) if (r.ts >= since) total += r.eur;
	return total;
}

function sumSession(records: SpendRecord[], sessionId: string): number {
	let total = 0;
	for (const r of records) if (r.session === sessionId) total += r.eur;
	return total;
}

function renderStatus(config: BudgetConfig, sessionId: string): string {
	const now = new Date();
	const rollout = Date.parse(`${config.rolloutDate}T00:00:00Z`);
	const records = readLedger();
	const day = sumSince(records, Math.max(dayStart(now), rollout));
	const week = sumSince(records, Math.max(weekStart(now, config.weeklyResetDay), rollout));
	const month = sumSince(records, Math.max(monthStart(now), rollout));
	const session = sumSession(records, sessionId);
	const { dailyEur, weeklyEur, monthlyEur } = config.limits;
	return `budget day €${day.toFixed(2)}/€${dailyEur} · week €${week.toFixed(2)}/€${weeklyEur} · month €${month.toFixed(2)}/€${monthlyEur} · session €${session.toFixed(2)} (est)`;
}

export default function (pi: ExtensionAPI) {
	let config: BudgetConfig = structuredClone(DEFAULT_CONFIG);
	const reported = new Set<string>();
	let watchers: FSWatcher[] = [];
	let debounce: ReturnType<typeof setTimeout> | undefined;

	/** Re-read budget.json and report problems once per distinct message. */
	function reload(ctx: ExtensionContext): void {
		const result = loadConfig();
		config = result.config;
		if (ctx.hasUI) {
			for (const problem of result.problems) {
				if (reported.has(problem)) continue;
				reported.add(problem);
				ctx.ui.notify(`Budget: ${problem}`, "warning");
			}
		}
	}

	function refresh(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(STATUS_KEY, renderStatus(config, ctx.sessionManager.getSessionId()));
	}

	/** Refresh when budget.json or the ledger changes on disk, debounced to coalesce bursts of events. */
	function onFileChange(ctx: ExtensionContext): void {
		if (debounce) clearTimeout(debounce);
		debounce = setTimeout(() => {
			debounce = undefined;
			reload(ctx);
			refresh(ctx);
		}, 150);
	}

	function startWatching(ctx: ExtensionContext): void {
		stopWatching();
		// Ensure both directories exist so they can be watched before the first write.
		mkdirSync(dirname(LEDGER), { recursive: true });
		const targets: [string, string][] = [
			[AGENT_DIR, "budget.json"],
			[dirname(LEDGER), "spend.jsonl"],
		];
		for (const [dir, file] of targets) {
			try {
				const watcher = watch(dir, (_event, filename) => {
					if (filename === file) onFileChange(ctx);
				});
				watcher.on("error", () => stopWatching());
				watchers.push(watcher);
			} catch {
				// Watching is best-effort; the per-turn refresh still applies.
			}
		}
	}

	function stopWatching(): void {
		for (const watcher of watchers) watcher.close();
		watchers = [];
		if (debounce) clearTimeout(debounce);
		debounce = undefined;
	}

	pi.on("session_start", async (_event, ctx) => {
		reload(ctx);
		refresh(ctx);
		if (ctx.hasUI) startWatching(ctx);
	});

	pi.on("session_shutdown", async () => {
		stopWatching();
	});

	// Other sessions may have spent since the last refresh; catch up before each turn.
	pi.on("turn_start", async (_event, ctx) => {
		refresh(ctx);
	});

	pi.on("message_end", async (event, ctx) => {
		const message = event.message;
		if (message.role !== "assistant" || !message.usage) return;

		reload(ctx);
		const model = message.model;
		const eur = estimateEur(config, model, message.usage);
		if (eur === undefined) {
			const note = `no price for model "${model}"; not counted`;
			if (!reported.has(note) && ctx.hasUI) {
				reported.add(note);
				ctx.ui.notify(`Budget: ${note}. Add it to prices in budget.json.`, "warning");
			}
			return;
		}

		appendRecord({ ts: Date.now(), model, eur, session: ctx.sessionManager.getSessionId() });
		refresh(ctx);
	});
}

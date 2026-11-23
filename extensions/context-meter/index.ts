// Context meter: a compact context bar in the footer plus a `/context` grid overlay.
//
//   Footer:   ▰▰▰▱▱▱▱▱▱┆ 25k/1M · ⇥984k
//   /context: 10×5 grid (2% per cell) with a per-category legend.
//
// The footer is published as extension status "context-meter"; place it with powerline's
// customItems (selfColorize: true). Category numbers are chars/4 estimates scaled to the
// provider-reported total; the total itself comes from ctx.getContextUsage().

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildSessionContext, DynamicBorder, estimateTokens } from "@earendil-works/pi-coding-agent";
import { Container, isKeyRelease, Text, visibleWidth } from "@earendil-works/pi-tui";
import { categorize, type ToolInfo } from "./breakdown.ts";
import {
	type Breakdown,
	type Painter,
	plainPainter,
	isRough,
	renderFooter,
	renderOverlay,
	resolveCompaction,
	scaleToTotal,
	type Snapshot,
} from "./meter.ts";

const STATUS_KEY = "context-meter";
const STREAM_THROTTLE_MS = 500;

export default function contextMeter(pi: ExtensionAPI) {
	let lastStreamUpdate = 0;
	// getSystemPromptOptions() exists only on command contexts; event handlers use this cache,
	// refreshed from before_agent_start and from /context.
	type ContextFile = { path: string; content: string };
	let cachedContextFiles: ContextFile[] = [];

	const painterFor = (ctx: ExtensionContext): Painter => {
		const theme = ctx.ui.theme;
		return { fg: (color, text) => theme.fg(color, text), bold: (text) => theme.bold(text) };
	};

	/**
	 * Message estimate, plus whether the provider has reported usage in this context yet.
	 * Before the first reply (and right after compaction) Pi's total counts messages only,
	 * without the prompt and tools, so the meter must fall back to its own estimate.
	 */
	const messageStats = (ctx: ExtensionContext): { tokens: number; reported: boolean } => {
		try {
			const sm = ctx.sessionManager;
			const { messages } = buildSessionContext(sm.getEntries(), sm.getLeafId());
			const tokens = messages.reduce((acc, m) => acc + estimateTokens(m), 0);
			const reported = messages.some((m) => {
				if (m.role !== "assistant" || !("usage" in m)) return false;
				const u = m.usage as { input?: number; cacheRead?: number; cacheWrite?: number } | undefined;
				return (u?.input ?? 0) + (u?.cacheRead ?? 0) + (u?.cacheWrite ?? 0) > 0;
			});
			return { tokens, reported };
		} catch {
			return { tokens: 0, reported: false };
		}
	};

	const tools = (): ToolInfo[] => {
		const active = new Set(pi.getActiveTools());
		return pi
			.getAllTools()
			.filter((t) => active.has(t.name))
			.map((t) => ({
				name: t.name,
				description: t.description,
				parameters: t.parameters,
				exposure: t.exposure,
				sourcePath: t.sourceInfo?.path,
			}));
	};

	/** Build the full breakdown. Returns undefined when there is no model or window. */
	const compute = (ctx: ExtensionContext, contextFiles: ContextFile[] = cachedContextFiles): Breakdown | undefined => {
		const usage = ctx.getContextUsage();
		const window = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
		if (window <= 0) return undefined;

		const modelKey = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
		const compaction = resolveCompaction(window, pi.getSettings(), modelKey);
		const stats = messageStats(ctx);

		const raw = categorize({
			systemPrompt: ctx.getSystemPrompt(),
			contextFiles,
			tools: tools(),
			messageTokens: stats.tokens,
		});
		const rawSum = raw.reduce((acc, c) => acc + c.tokens, 0);

		const estimated = usage?.tokens == null || !stats.reported;
		const used = estimated ? rawSum : (usage?.tokens ?? 0);
		const { categories, factor } = scaleToTotal(raw, used);
		const snapshot: Snapshot = { used, estimated, window, compaction };
		return { categories, snapshot, rough: !estimated && isRough(factor) };
	};

	/** Footer only needs the total; avoid the full breakdown unless the total is unknown. */
	const updateFooter = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		try {
			const usage = ctx.getContextUsage();
			const window = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
			if (window <= 0) {
				ctx.ui.setStatus(STATUS_KEY, undefined);
				return;
			}
			let snapshot: Snapshot;
			if (usage?.tokens == null || !messageStats(ctx).reported) {
				const full = compute(ctx);
				if (!full) return;
				snapshot = full.snapshot;
			} else {
				const modelKey = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
				snapshot = {
					used: usage.tokens,
					estimated: false,
					window,
					compaction: resolveCompaction(window, pi.getSettings(), modelKey),
				};
			}
			ctx.ui.setStatus(STATUS_KEY, renderFooter(snapshot, painterFor(ctx)));
		} catch {
			// Never break the session over a footer.
		}
	};

	pi.on("before_agent_start", async (event) => {
		cachedContextFiles = event.systemPromptOptions.contextFiles ?? [];
	});
	pi.on("session_start", async (_event, ctx) => updateFooter(ctx));
	pi.on("model_select", async (_event, ctx) => updateFooter(ctx));
	pi.on("message_end", async (_event, ctx) => updateFooter(ctx));
	pi.on("turn_end", async (_event, ctx) => updateFooter(ctx));
	pi.on("session_compact", async (_event, ctx) => updateFooter(ctx));
	pi.on("message_update", async (_event, ctx) => {
		const now = Date.now();
		if (now - lastStreamUpdate < STREAM_THROTTLE_MS) return;
		lastStreamUpdate = now;
		updateFooter(ctx);
	});

	pi.registerCommand("context", {
		description: "Show context window usage by category",
		handler: async (_args, ctx) => {
			cachedContextFiles = ctx.getSystemPromptOptions().contextFiles ?? [];
			const breakdown = compute(ctx, cachedContextFiles);
			if (!breakdown) {
				if (ctx.hasUI) ctx.ui.notify("No model selected, so there is no context window to show.", "warning");
				else console.log("No model selected, so there is no context window to show.");
				return;
			}

			if (!ctx.hasUI) {
				console.log(["Context Usage", "", ...renderOverlay(breakdown, plainPainter)].join("\n"));
				return;
			}

			await ctx.ui.custom<undefined>(
				(_tui, theme, _keybindings, done) => {
					const painter: Painter = { fg: (c, t) => theme.fg(c, t), bold: (t) => theme.bold(t) };
					const container = new Container();
					const border = (s: string) => theme.fg("borderAccent", s);
					container.addChild(new DynamicBorder(border));
					container.addChild(new Text(theme.fg("accent", theme.bold("Context Usage")), 1, 1));
					for (const line of renderOverlay(breakdown, painter, visibleWidth)) {
						container.addChild(new Text(line, 2, 0));
					}
					container.addChild(new Text(theme.fg("dim", "Press any key to close"), 1, 1));
					container.addChild(new DynamicBorder(border));
					return {
						render: (width: number) => container.render(width),
						invalidate: () => container.invalidate(),
						handleInput: (data: string) => {
							if (isKeyRelease(data)) return;
							done(undefined);
						},
					};
				},
				{ overlay: true },
			);
		},
	});
}

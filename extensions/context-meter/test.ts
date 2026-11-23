// Run: node --experimental-strip-types ~/.pi/agent/extensions/context-meter/test.ts
// Not loaded by Pi (only index.ts is an entry point).

import assert from "node:assert/strict";
import { test } from "node:test";
import { blockLength, categorize, isDeclared, isMcpTool } from "./breakdown.ts";
import {
	allocateCells,
	type Category,
	formatPercent,
	formatTokens,
	GRID_COLS,
	GRID_ROWS,
	isRough,
	layoutGrid,
	levelFor,
	plainPainter,
	renderFooter,
	renderOverlay,
	resolveCompaction,
	scaleToTotal,
	type Snapshot,
} from "./meter.ts";

const M = 1_000_000;
const on = resolveCompaction(M, {}, undefined);
const off = resolveCompaction(M, { compaction: { enabled: false } }, undefined);
const cat = (id: string, tokens: number): Category => ({ id, label: id, color: "accent", tokens });

test("compaction: default reserve on a 1M window", () => {
	assert.deepEqual(on, { enabled: true, reserve: 16384, threshold: 983616 });
});

test("compaction: model override beats setting beats default", () => {
	const settings = { compaction: { reserveTokens: 50000, modelOverrides: { "a/b": { reserveTokens: 33000 } } } };
	assert.equal(resolveCompaction(M, settings, "a/b").threshold, M - 33000);
	assert.equal(resolveCompaction(M, settings, "x/y").threshold, M - 50000);
	assert.equal(resolveCompaction(M, { compaction: { reserveTokens: -5 } }, undefined).reserve, 16384);
	assert.equal(off.enabled, false);
});

test("formatTokens / formatPercent", () => {
	assert.equal(formatTokens(370), "370");
	assert.equal(formatTokens(2843), "2.8k");
	assert.equal(formatTokens(14000), "14k");
	assert.equal(formatTokens(983616), "984k");
	assert.equal(formatTokens(M), "1M");
	assert.equal(formatTokens(1_250_000), "1.3M");
	assert.equal(formatPercent(370, M), "<0.1%");
	assert.equal(formatPercent(25000, M), "2.5%");
	assert.equal(formatPercent(0, M), "0%");
});

test("scaleToTotal: categories sum to the real total (within rounding)", () => {
	const { categories, factor } = scaleToTotal([cat("a", 100), cat("b", 300)], 800);
	assert.equal(factor, 2);
	assert.deepEqual(categories.map((c) => c.tokens), [200, 600]);
	assert.equal(scaleToTotal([cat("a", 0)], 500).factor, 1);
	assert.equal(isRough(2), false);
	assert.equal(isRough(2.1), true);
	assert.equal(isRough(0.49), true);
});

test("allocateCells: proportional, sums to cells, min one per non-zero", () => {
	const r = allocateCells([25, 25, 50], 50);
	assert.deepEqual(r, [13, 12, 25]); // 12.5/12.5/25: tied remainder goes to the first
	assert.equal(r.reduce((a, b) => a + b, 0), 50);
	const tiny = allocateCells([1, 1, 1_000_000], 50);
	assert.equal(tiny[0], 1);
	assert.equal(tiny[1], 1);
	assert.equal(tiny[2], 48);
	assert.deepEqual(allocateCells([0, 0], 50), [0, 0]);
	assert.deepEqual(allocateCells([0, 10], 50), [0, 50]);
	// More non-zero values than cells: never exceeds the budget.
	const many = allocateCells(Array(60).fill(1), 50);
	assert.equal(many.reduce((a, b) => a + b, 0), 50);
});

test("levelFor: thresholds against compaction point, or window when off", () => {
	assert.equal(levelFor(0.69 * on.threshold, M, on), "normal");
	assert.equal(levelFor(0.7 * on.threshold, M, on), "warn");
	assert.equal(levelFor(0.9 * on.threshold, M, on), "error");
	assert.equal(levelFor(0.89 * M, M, off), "warn");
});

test("footer: format, marker and estimate", () => {
	const s: Snapshot = { used: 25000, estimated: false, window: M, compaction: on };
	assert.equal(renderFooter(s, plainPainter), "▰▱▱▱▱▱▱▱▱┆ 25k/1M · ⇥984k");
	assert.equal(renderFooter({ ...s, estimated: true, used: 22000 }, plainPainter), "▰▱▱▱▱▱▱▱▱┆ ~22k/1M · ⇥984k");
	assert.equal(renderFooter({ ...s, compaction: off }, plainPainter), "▰▱▱▱▱▱▱▱▱▱ 25k/1M");
	assert.equal(renderFooter({ ...s, used: 0 }, plainPainter), "▱▱▱▱▱▱▱▱▱┆ 0/1M · ⇥984k");
	assert.equal(renderFooter({ ...s, used: 500000 }, plainPainter), "▰▰▰▰▰▱▱▱▱┆ 500k/1M · ⇥984k");
	assert.equal(renderFooter({ ...s, window: 0 }, plainPainter), "");
});

test("grid: 50 cells, order categories → free → buffer, buffer hidden when off", () => {
	const s: Snapshot = { used: 25000, estimated: false, window: M, compaction: on };
	const cells = layoutGrid([cat("a", 20000), cat("b", 5000)], s);
	assert.equal(cells.length, GRID_COLS * GRID_ROWS);
	const kinds = cells.map((c) => c.kind);
	assert.equal(kinds.lastIndexOf("category") < kinds.indexOf("free"), true);
	assert.equal(kinds.lastIndexOf("free") < kinds.indexOf("buffer"), true);
	assert.equal(kinds.filter((k) => k === "buffer").length, 1);
	assert.equal(layoutGrid([cat("a", 20000)], { ...s, compaction: off }).some((c) => c.kind === "buffer"), false);
});

test("overlay: header, legend rows, zero categories hidden", () => {
	const s: Snapshot = { used: 25000, estimated: false, window: M, compaction: on };
	const lines = renderOverlay({ categories: [cat("Tools", 20000), cat("Skills", 0), cat("Messages", 5000)], snapshot: s, rough: true }, plainPainter);
	const text = lines.join("\n");
	assert.match(text, /25k \/ 1M \(2\.5%\) · compacts at 984k \(rough\)/);
	assert.match(text, /■ Tools\s+≈20k\s+2\.0%/);
	assert.doesNotMatch(text, /Skills/);
	assert.match(text, /□ Free\s+959k/);
	assert.match(text, /░ Compaction buffer\s+16k/);
	assert.match(text, /┆░/); // marker sits right before the buffer cell
	const offText = renderOverlay({ categories: [cat("Tools", 20000)], snapshot: { ...s, compaction: off }, rough: false }, plainPainter).join("\n");
	assert.doesNotMatch(offText, /Compaction buffer|compacts at|┆/);
});

test("breakdown: prompt sections, context files, MCP vs tools", () => {
	assert.equal(blockLength("a<x>12</x>b<x>3</x>", "x"), "<x>12</x>".length + "<x>3</x>".length);
	assert.equal(blockLength("<x>unclosed", "x"), 0);
	assert.equal(isDeclared({ name: "a", exposure: "codemode" }), false);
	assert.equal(isMcpTool({ name: "codemode" }), true);
	assert.equal(isMcpTool({ name: "read", sourcePath: "builtin:read" }), false);

	const agents = "AGENTS RULES ".repeat(40);
	const prompt = `${"base ".repeat(200)}<tools>${"t".repeat(400)}</tools><skills>${"s".repeat(800)}</skills><mcp_servers>${"m".repeat(400)}</mcp_servers>${agents}`;
	const cats = Object.fromEntries(
		categorize({
			systemPrompt: prompt,
			contextFiles: [{ path: "AGENTS.md", content: agents }, { path: "missing.md", content: "not in prompt" }],
			tools: [
				{ name: "read", description: "r".repeat(400) },
				{ name: "codemode", description: "c".repeat(400) },
				{ name: "mcp__x__y", exposure: "codemode", description: "ignored".repeat(100) },
			],
			messageTokens: 370,
		}).map((c) => [c.id, c.tokens]),
	);
	assert.equal(cats.skills, Math.ceil((800 + 17) / 4));
	assert.equal(cats.context, Math.ceil(agents.length / 4));
	assert.ok(cats.tools > 100 && cats.tools < 220, `tools ${cats.tools}`);
	assert.ok(cats.mcp > 100 && cats.mcp < 220, `mcp ${cats.mcp}`);
	assert.equal(cats.messages, 370);
	assert.ok(cats.system >= 240 && cats.system <= 260, `system ${cats.system}`);
});

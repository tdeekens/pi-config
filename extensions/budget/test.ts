// Run: node --experimental-strip-types ~/.pi/agent/extensions/budget/test.ts
// Not loaded by Pi (only index.ts is an entry point).

import assert from "node:assert/strict";
import { test } from "node:test";
import { filledCells, levelFor, plainPainter, renderFooter, renderOverlay, shortEur, type Totals } from "./render.ts";

const totals: Totals = {
	periods: [
		{ key: "d", label: "Day", spent: 17.98, limit: 50, resetsAt: Date.UTC(2026, 10, 24) },
		{ key: "w", label: "Week", spent: 24.35, limit: 150, resetsAt: Date.UTC(2026, 10, 26) },
		{ key: "m", label: "Month", spent: 24.63, limit: 600, resetsAt: Date.UTC(2026, 11, 1) },
	],
	session: 3.6,
};

test("levelFor: 70/90 thresholds, zero limit", () => {
	assert.equal(levelFor(34.9, 50), "normal");
	assert.equal(levelFor(35, 50), "warn");
	assert.equal(levelFor(45, 50), "error");
	assert.equal(levelFor(60, 50), "error");
	assert.equal(levelFor(0, 0), "normal");
	assert.equal(levelFor(1, 0), "error");
});

test("filledCells: min one once spent, full at limit", () => {
	assert.equal(filledCells(0, 50, 3), 0);
	assert.equal(filledCells(0.01, 50, 3), 1);
	assert.equal(filledCells(17.98, 50, 3), 1);
	assert.equal(filledCells(30, 50, 3), 2);
	assert.equal(filledCells(50, 50, 3), 3);
	assert.equal(filledCells(80, 50, 3), 3);
	assert.equal(filledCells(17.98, 50, 10), 4);
});

test("shortEur", () => {
	assert.equal(shortEur(3.6), "3.6");
	assert.equal(shortEur(4), "4");
	assert.equal(shortEur(17.98), "18");
	assert.equal(shortEur(600), "600");
	assert.equal(shortEur(-1), "0");
});

test("footer: compact format", () => {
	assert.equal(renderFooter(totals, plainPainter), "~€ d ▰▱▱ 18/50  w ▰▱▱ 24/150  m ▰▱▱ 25/600 · s 3.60");
});

test("overlay: rows, percentages, resets", () => {
	const text = renderOverlay(totals, plainPainter).join("\n");
	assert.match(text, /Day {5}▰▰▰▰▱▱▱▱▱▱ {2}€17\.98 \/ €50 +36% {2}resets 00:00 UTC/);
	assert.match(text, /Week .*€24\.35 \/ €150 +16% {2}resets Thu/);
	assert.match(text, /Month .*€24\.63 \/ €600 +4% {2}resets Dec 1/);
	assert.match(text, /Session +€3\.60/);
});

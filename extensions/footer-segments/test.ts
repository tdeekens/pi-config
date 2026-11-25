// Run: node --experimental-strip-types ~/.pi/agent/extensions/footer-segments/test.ts
// Not loaded by Pi (only index.ts is an entry point).

import assert from "node:assert/strict";
import { test } from "node:test";
import { filledDots, type Painter, plainPainter, renderPath, renderThinking, shortenLeft } from "./render.ts";

const HOME = "/Users/me";
const path = (cwd: string, repoRoot?: string, icon = "") => renderPath({ cwd, home: HOME, repoRoot }, plainPainter, icon);

test("thinking: dots per level", () => {
	assert.equal(renderThinking("off", plainPainter), "○○○○○");
	assert.equal(renderThinking("minimal", plainPainter), "●○○○○");
	assert.equal(renderThinking("low", plainPainter), "●●○○○");
	assert.equal(renderThinking("medium", plainPainter), "●●●○○");
	assert.equal(renderThinking("high", plainPainter), "●●●●○");
	assert.equal(renderThinking("xhigh", plainPainter), "●●●●●");
	assert.equal(renderThinking("unknown", plainPainter), "○○○○○");
	assert.equal(filledDots("max"), 5);
});

test("thinking: level colour, gradient for rainbow levels, bold max", () => {
	const tag: Painter = { fg: (c, t) => `<${c}>${t}`, bold: (t) => `**${t}**` };
	assert.equal(renderThinking("medium", tag), "<thinkingMedium>●<thinkingMedium>●<thinkingMedium>●<dim>○<dim>○");
	assert.equal(renderThinking("high", tag), "<thinkingLow>●<thinkingMedium>●<thinkingHigh>●<thinkingXhigh>●<dim>○");
	assert.match(renderThinking("max", tag), /^\*\*.*<thinkingMax>●\*\*$/);
});

test("shortenLeft: keeps whole trailing segments", () => {
	assert.equal(shortenLeft("extensions/budget", 30), "extensions/budget");
	assert.equal(shortenLeft("src/app/components/table", 20), "…/components/table");
	assert.equal(shortenLeft("a/averyveryveryverylongsegmentname", 12), "…segmentname"); // hard cut
	assert.ok(shortenLeft("x/" + "y".repeat(50), 20).length <= 20);
});

test("path: home, repo root, inside repo, outside repo", () => {
	assert.equal(path(HOME), "~");
	assert.equal(path(`${HOME}/Development/pi-config`, `${HOME}/Development/pi-config`), "pi-config");
	assert.equal(
		path(`${HOME}/Development/pi-config/extensions/budget`, `${HOME}/Development/pi-config`),
		"pi-config › extensions/budget",
	);
	assert.equal(
		path(`${HOME}/Development/monorepo/packages/app/src/components/table`, `${HOME}/Development/monorepo`),
		"monorepo › …/app/src/components/table",
	);
	assert.equal(path(`${HOME}/Downloads/tmp`), "~/Downloads/tmp");
	assert.equal(path("/opt/homebrew"), "/opt/homebrew");
	assert.equal(path(HOME, undefined, "I"), "I ~");
});

/**
 * Q&A extraction hook - extracts questions from assistant responses
 *
 * Custom interactive TUI for answering questions.
 *
 * Demonstrates the "prompt generator" pattern with custom TUI:
 * 1. /answer command gets the last assistant message
 * 2. Shows a spinner while extracting questions as structured JSON
 * 3. Presents an interactive TUI to navigate and answer questions
 * 4. Submits the compiled answers when done
 */

import { complete, parseJsonWithRepair, type Model, type Api, type UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { BorderedLoader } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	truncateToWidth,
	type TUI,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

// Structured output format for question extraction
interface ExtractedQuestion {
	question: string;
	context?: string;
	options?: string[];
}

interface ExtractionResult {
	questions: ExtractedQuestion[];
}

type ExtractionOutcome =
	| { status: "ok"; result: ExtractionResult }
	| { status: "cancelled" }
	| { status: "error"; message: string };

const SYSTEM_PROMPT = `You are a question extractor. Given text from a conversation, extract any questions that need answering.

Output a JSON object with this structure:
{
  "questions": [
    {
      "question": "The question text",
      "context": "Optional context that helps answer the question",
      "options": ["Optional short answer choice", "Another short answer choice"]
    }
  ]
}

Rules:
- Extract all questions that require user input
- Keep questions in the order they appeared
- Be concise with question text
- Include context only when it provides essential information for answering
- Whenever the message offers choices, put them in "options" as short labels and keep them out of "context". This includes yes/no approvals (use ["Yes", "No"]), lettered or numbered alternatives like (a)/(b)/(c), and a recommendation among alternatives. Put the recommended choice first with " (Recommended)" appended
- Use "context" only for background the user needs to understand the question
- Omit "options" only for truly open-ended questions
- If no questions are found, return {"questions": []}

Example output:
{
  "questions": [
    {
      "question": "What is your preferred database?",
      "context": "We can only configure MySQL and PostgreSQL because of what is implemented.",
      "options": ["MySQL", "PostgreSQL"]
    },
    {
      "question": "Should we use TypeScript or JavaScript?",
      "options": ["TypeScript", "JavaScript"]
    }
  ]
}`;

const CODEX_MODEL_IDS = ["gpt-5.4-mini", "gpt-5.3-codex-spark", "gpt-5.4", "gpt-5.3-codex"];
const HAIKU_MODEL_ID = "claude-haiku-4-5";

/**
 * Prefer a fast configured Codex model for extraction, then haiku, then the
 * current model.
 */
async function selectExtractionModel(
	currentModel: Model<Api>,
	modelRegistry: ModelRegistry,
): Promise<Model<Api>> {
	for (const modelId of CODEX_MODEL_IDS) {
		const codexModel = modelRegistry.find("openai-codex", modelId);
		if (codexModel) {
			const auth = await modelRegistry.getApiKeyAndHeaders(codexModel);
			if (auth.ok) {
				return codexModel;
			}
		}
	}

	const haikuModel = modelRegistry.find("anthropic", HAIKU_MODEL_ID);
	if (!haikuModel) {
		return currentModel;
	}

	const auth = await modelRegistry.getApiKeyAndHeaders(haikuModel);
	if (auth.ok === false) {
		return currentModel;
	}

	return haikuModel;
}

/**
 * Fallback: pull sequential "(a) ... (b) ..." choices out of context text.
 * Returns null when fewer than two choices are found.
 */
function splitLetteredChoices(text: string): { context: string; options: string[] } | null {
	const letters = "abcdefghijklmnopqrstuvwxyz";
	const markers: RegExpMatchArray[] = [];
	for (const m of text.matchAll(/\(([a-z])\)\s*/gi)) {
		if (m[1].toLowerCase() !== letters[markers.length]) break;
		markers.push(m);
	}
	if (markers.length < 2) return null;

	const head = text.slice(0, markers[0].index).replace(/\b(options?|choices?)\s*:?\s*$/i, "").trim();
	const leftovers: string[] = [head];
	const options: string[] = [];
	markers.forEach((m, k) => {
		const start = m.index! + m[0].length;
		const end = k + 1 < markers.length ? markers[k + 1].index! : text.length;
		const segment = text.slice(start, end);
		// Option text ends at the first sentence break; anything after it stays as context.
		const cut = segment.search(/[.;:]\s|\n/);
		const label = (cut === -1 ? segment : segment.slice(0, cut)).trim().replace(/[.,;:]+$/, "").trim();
		if (label) options.push(label);
		if (cut !== -1) leftovers.push(segment.slice(cut + 1).trim());
	});

	return { context: leftovers.filter((s) => s.length > 0).join(" "), options };
}

function toExtractedQuestion(value: unknown): ExtractedQuestion | null {
	if (typeof value !== "object" || value === null) {
		return null;
	}
	const record = value as Record<string, unknown>;
	const question = record.question;
	const context = record.context;
	if (typeof question !== "string") {
		return null;
	}
	if (context !== undefined && context !== null && typeof context !== "string") {
		return null;
	}
	const options = Array.isArray(record.options)
		? record.options
				.filter((o): o is string => typeof o === "string" && o.trim().length > 0)
				.map((o) => o.trim())
		: [];
	let text = typeof context === "string" ? context : "";
	let finalOptions = options;
	if (finalOptions.length === 0 && text.length > 0) {
		const split = splitLetteredChoices(text);
		if (split && split.options.length >= 2) {
			finalOptions = split.options;
			text = split.context;
		}
	}
	const result: ExtractedQuestion = { question };
	if (text.length > 0) result.context = text;
	if (finalOptions.length > 0) result.options = finalOptions;
	return result;
}

function toExtractionResult(value: unknown): ExtractionResult | null {
	if (typeof value !== "object" || value === null) {
		return null;
	}
	const record = value as Record<string, unknown>;
	if (!Array.isArray(record.questions)) {
		return null;
	}
	const questions: ExtractedQuestion[] = [];
	for (const question of record.questions) {
		const extractedQuestion = toExtractedQuestion(question);
		if (!extractedQuestion) {
			return null;
		}
		questions.push(extractedQuestion);
	}
	return { questions };
}

/**
 * Parse the JSON response from the LLM.
 */
function parseExtractionResult(text: string): ExtractionResult | null {
	const candidates: string[] = [];
	const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (jsonMatch) {
		candidates.push(jsonMatch[1].trim());
	}

	const trimmed = text.trim();
	candidates.push(trimmed);

	const firstBrace = trimmed.indexOf("{");
	const lastBrace = trimmed.lastIndexOf("}");
	if (firstBrace !== -1 && lastBrace > firstBrace) {
		candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
	}

	for (const candidate of candidates) {
		try {
			const result = toExtractionResult(parseJsonWithRepair<unknown>(candidate));
			if (result) {
				return result;
			}
		} catch {
			// Try the next candidate.
		}
	}

	return null;
}

/**
 * Interactive Q&A component for answering extracted questions.
 * Questions with options show a selectable list (last row: "Other") and
 * questions without options show a free-text editor.
 */
class QnAComponent implements Component {
	private questions: ExtractedQuestion[];
	private others: string[]; // free-text answer per question
	private choices: (number | null)[]; // committed row index; options.length = "Other"
	private cursors: number[]; // highlighted row per question
	private currentIndex: number = 0;
	private editor: Editor;
	private tui: TUI;
	private onDone: (result: string | null) => void;
	private showingConfirmation: boolean = false;

	// Cache
	private cachedWidth?: number;
	private cachedLines?: string[];

	// Colors - using proper reset sequences
	private dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
	private bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
	private cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
	private green = (s: string) => `\x1b[32m${s}\x1b[0m`;
	private yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
	private gray = (s: string) => `\x1b[90m${s}\x1b[0m`;

	constructor(
		questions: ExtractedQuestion[],
		tui: TUI,
		onDone: (result: string | null) => void,
	) {
		this.questions = questions;
		this.others = questions.map(() => "");
		this.choices = questions.map(() => null);
		this.cursors = questions.map(() => 0);
		this.tui = tui;
		this.onDone = onDone;

		// Create a minimal theme for the editor
		const editorTheme: EditorTheme = {
			borderColor: this.dim,
			selectList: {
				selectedPrefix: this.cyan,
				selectedText: (s: string) => `\x1b[44m${s}\x1b[0m`,
				description: this.gray,
				scrollInfo: this.dim,
				noMatch: this.yellow,
			},
		};

		this.editor = new Editor(tui, editorTheme);
		// Disable the editor's built-in submit (which clears the editor)
		// We'll handle Enter ourselves to preserve the text
		this.editor.disableSubmit = true;
		this.editor.onChange = () => {
			this.invalidate();
			this.tui.requestRender();
		};
	}

	private optionCount(i: number): number {
		return this.questions[i].options?.length ?? 0;
	}

	private hasOptions(i: number): boolean {
		return this.optionCount(i) > 0;
	}

	/** The free-text editor is used for open questions and for the "Other" row. */
	private editorActive(i: number = this.currentIndex): boolean {
		if (!this.hasOptions(i)) return true;
		return this.cursors[i] === this.optionCount(i);
	}

	private answerOf(i: number): string {
		if (!this.hasOptions(i)) return this.others[i].trim();
		const choice = this.choices[i];
		if (choice === null) return "";
		if (choice === this.optionCount(i)) return this.others[i].trim();
		return this.questions[i].options![choice];
	}

	private saveCurrentAnswer(): void {
		if (!this.editorActive()) return;
		const text = this.editor.getText();
		this.others[this.currentIndex] = text;
		// Typing into "Other" counts as choosing it
		if (this.hasOptions(this.currentIndex) && text.trim().length > 0) {
			this.choices[this.currentIndex] = this.optionCount(this.currentIndex);
		}
	}

	private navigateTo(index: number): void {
		if (index < 0 || index >= this.questions.length) return;
		this.saveCurrentAnswer();
		this.currentIndex = index;
		this.editor.setText(this.others[index] || "");
		this.invalidate();
	}

	private moveCursor(delta: number): void {
		const i = this.currentIndex;
		this.saveCurrentAnswer();
		const max = this.optionCount(i); // last row is "Other"
		this.cursors[i] = Math.min(max, Math.max(0, this.cursors[i] + delta));
		this.editor.setText(this.others[i] || "");
		this.invalidate();
		this.tui.requestRender();
	}

	/** Move to the next question, or ask for confirmation on the last one. */
	private advance(): void {
		if (this.currentIndex < this.questions.length - 1) {
			this.navigateTo(this.currentIndex + 1);
		} else {
			this.showingConfirmation = true;
		}
		this.invalidate();
		this.tui.requestRender();
	}

	private submit(): void {
		this.saveCurrentAnswer();

		// Build the response text
		const parts: string[] = [];
		for (let i = 0; i < this.questions.length; i++) {
			const q = this.questions[i];
			const a = this.answerOf(i) || "(no answer)";
			parts.push(`Q: ${q.question}`);
			if (q.context) {
				parts.push(`> ${q.context}`);
			}
			parts.push(`A: ${a}`);
			parts.push("");
		}

		this.onDone(parts.join("\n").trim());
	}

	private cancel(): void {
		this.onDone(null);
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	handleInput(data: string): void {
		// Handle confirmation dialog
		if (this.showingConfirmation) {
			if (matchesKey(data, Key.enter) || data.toLowerCase() === "y") {
				this.submit();
				return;
			}
			if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data.toLowerCase() === "n") {
				this.showingConfirmation = false;
				this.invalidate();
				this.tui.requestRender();
				return;
			}
			return;
		}

		// Global navigation and commands
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.cancel();
			return;
		}

		// Tab / Shift+Tab for navigation
		if (matchesKey(data, Key.tab)) {
			if (this.currentIndex < this.questions.length - 1) {
				this.navigateTo(this.currentIndex + 1);
				this.tui.requestRender();
			}
			return;
		}
		if (matchesKey(data, Key.shift("tab"))) {
			if (this.currentIndex > 0) {
				this.navigateTo(this.currentIndex - 1);
				this.tui.requestRender();
			}
			return;
		}

		const i = this.currentIndex;
		const isEnter = matchesKey(data, Key.enter) && !matchesKey(data, Key.shift("enter"));

		// Questions with options: arrows move the list, Enter picks the highlighted row
		if (this.hasOptions(i)) {
			if (matchesKey(data, Key.up)) {
				this.moveCursor(-1);
				return;
			}
			if (matchesKey(data, Key.down)) {
				this.moveCursor(1);
				return;
			}
			if (isEnter) {
				this.saveCurrentAnswer();
				this.choices[i] = this.cursors[i];
				this.advance();
				return;
			}
			if (this.editorActive()) {
				this.editor.handleInput(data);
				this.invalidate();
				this.tui.requestRender();
			}
			return;
		}

		// Open questions: arrow up/down for question navigation when editor is empty
		// (Editor handles its own cursor navigation when there's content)
		if (matchesKey(data, Key.up) && this.editor.getText() === "") {
			if (this.currentIndex > 0) {
				this.navigateTo(this.currentIndex - 1);
				this.tui.requestRender();
				return;
			}
		}
		if (matchesKey(data, Key.down) && this.editor.getText() === "") {
			if (this.currentIndex < this.questions.length - 1) {
				this.navigateTo(this.currentIndex + 1);
				this.tui.requestRender();
				return;
			}
		}

		// Handle Enter ourselves (editor's submit is disabled)
		// Plain Enter moves to next question or shows confirmation on last question
		// Shift+Enter adds a newline (handled by editor)
		if (isEnter) {
			this.saveCurrentAnswer();
			this.advance();
			return;
		}

		// Pass to editor
		this.editor.handleInput(data);
		this.invalidate();
		this.tui.requestRender();
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const lines: string[] = [];
		const boxWidth = Math.min(width - 4, 120); // Allow wider box
		const contentWidth = boxWidth - 4; // 2 chars padding on each side

		// Helper to create horizontal lines (dim the whole thing at once)
		const horizontalLine = (count: number) => "─".repeat(count);

		// Helper to create a box line
		const boxLine = (content: string, leftPad: number = 2): string => {
			const paddedContent = " ".repeat(leftPad) + content;
			const contentLen = visibleWidth(paddedContent);
			const rightPad = Math.max(0, boxWidth - contentLen - 2);
			return this.dim("│") + paddedContent + " ".repeat(rightPad) + this.dim("│");
		};

		const emptyBoxLine = (): string => {
			return this.dim("│") + " ".repeat(boxWidth - 2) + this.dim("│");
		};

		const padToWidth = (line: string): string => {
			const len = visibleWidth(line);
			return line + " ".repeat(Math.max(0, width - len));
		};

		// Title
		lines.push(padToWidth(this.dim("╭" + horizontalLine(boxWidth - 2) + "╮")));
		const title = `${this.bold(this.cyan("Questions"))} ${this.dim(`(${this.currentIndex + 1}/${this.questions.length})`)}`;
		lines.push(padToWidth(boxLine(title)));
		lines.push(padToWidth(this.dim("├" + horizontalLine(boxWidth - 2) + "┤")));

		// Progress indicator
		const progressParts: string[] = [];
		for (let i = 0; i < this.questions.length; i++) {
			const answered = this.answerOf(i).length > 0;
			const current = i === this.currentIndex;
			if (current) {
				progressParts.push(this.cyan("●"));
			} else if (answered) {
				progressParts.push(this.green("●"));
			} else {
				progressParts.push(this.dim("○"));
			}
		}
		lines.push(padToWidth(boxLine(progressParts.join(" "))));
		lines.push(padToWidth(emptyBoxLine()));

		// Current question
		const i = this.currentIndex;
		const q = this.questions[i];
		const questionText = `${this.bold("Q:")} ${q.question}`;
		const wrappedQuestion = wrapTextWithAnsi(questionText, contentWidth);
		for (const line of wrappedQuestion) {
			lines.push(padToWidth(boxLine(line)));
		}

		// Context if present
		if (q.context) {
			lines.push(padToWidth(emptyBoxLine()));
			const contextText = this.gray(`> ${q.context}`);
			const wrappedContext = wrapTextWithAnsi(contextText, contentWidth - 2);
			for (const line of wrappedContext) {
				lines.push(padToWidth(boxLine(line)));
			}
		}

		lines.push(padToWidth(emptyBoxLine()));

		// Option list (with a trailing "Other" row)
		if (this.hasOptions(i)) {
			const rows = [...(q.options ?? []), "Other (type your own answer)"];
			rows.forEach((label, j) => {
				const pointer = this.cursors[i] === j ? this.cyan("❯") : " ";
				const mark = this.choices[i] === j ? this.green("✓") : " ";
				const text = this.cursors[i] === j ? this.bold(label) : label;
				lines.push(padToWidth(boxLine(truncateToWidth(`${pointer} ${mark} ${text}`, contentWidth))));
			});
			lines.push(padToWidth(emptyBoxLine()));
		}

		// Render the editor component (multi-line input) with padding
		// Skip the first and last lines (editor's own border lines)
		if (this.editorActive(i)) {
			const answerPrefix = this.bold("A: ");
			const editorWidth = contentWidth - 4 - 3; // Extra padding + space for "A: "
			const editorLines = this.editor.render(editorWidth);
			for (let j = 1; j < editorLines.length - 1; j++) {
				if (j === 1) {
					// First content line gets the "A: " prefix
					lines.push(padToWidth(boxLine(answerPrefix + editorLines[j])));
				} else {
					// Subsequent lines get padding to align with the first line
					lines.push(padToWidth(boxLine("   " + editorLines[j])));
				}
			}
			lines.push(padToWidth(emptyBoxLine()));
		}

		// Confirmation dialog or footer with controls
		if (this.showingConfirmation) {
			lines.push(padToWidth(this.dim("├" + horizontalLine(boxWidth - 2) + "┤")));
			const confirmMsg = `${this.yellow("Submit all answers?")} ${this.dim("(Enter/y to confirm, Esc/n to cancel)")}`;
			lines.push(padToWidth(boxLine(truncateToWidth(confirmMsg, contentWidth))));
		} else {
			lines.push(padToWidth(this.dim("├" + horizontalLine(boxWidth - 2) + "┤")));
			const controls = this.hasOptions(i)
				? `${this.dim("↑/↓")} choose · ${this.dim("Enter")} select · ${this.dim("Tab/Shift+Tab")} move · ${this.dim("Esc")} cancel`
				: `${this.dim("Tab/Enter")} next · ${this.dim("Shift+Tab")} prev · ${this.dim("Shift+Enter")} newline · ${this.dim("Esc")} cancel`;
			lines.push(padToWidth(boxLine(truncateToWidth(controls, contentWidth))));
		}
		lines.push(padToWidth(this.dim("╰" + horizontalLine(boxWidth - 2) + "╯")));

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}
}

export default function (pi: ExtensionAPI) {
	const answerHandler = async (ctx: ExtensionContext) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("answer requires interactive mode", "error");
				return;
			}

			if (!ctx.model) {
				ctx.ui.notify("No model selected", "error");
				return;
			}

			// Find the last assistant message on the current branch
			const branch = ctx.sessionManager.getBranch();
			let lastAssistantText: string | undefined;

			for (let i = branch.length - 1; i >= 0; i--) {
				const entry = branch[i];
				if (entry.type === "message") {
					const msg = entry.message;
					if ("role" in msg && msg.role === "assistant") {
						if (msg.stopReason !== "stop") {
							ctx.ui.notify(`Last assistant message incomplete (${msg.stopReason})`, "error");
							return;
						}
						const textParts = msg.content
							.filter((c): c is { type: "text"; text: string } => c.type === "text")
							.map((c) => c.text);
						if (textParts.length > 0) {
							lastAssistantText = textParts.join("\n");
							break;
						}
					}
				}
			}

			if (!lastAssistantText) {
				ctx.ui.notify("No assistant messages found", "error");
				return;
			}

			// Select the best model for extraction.
			const extractionModel = await selectExtractionModel(ctx.model, ctx.modelRegistry);

			// Run extraction with loader UI
			const extractionOutcome = await ctx.ui.custom<ExtractionOutcome>((tui, theme, _kb, done) => {
				const loader = new BorderedLoader(tui, theme, `Extracting questions using ${extractionModel.id}...`);
				loader.onAbort = () => done({ status: "cancelled" });

				const doExtract = async (): Promise<ExtractionOutcome> => {
					const auth = await ctx.modelRegistry.getApiKeyAndHeaders(extractionModel);
					if (auth.ok === false) {
						return { status: "error", message: auth.error };
					}
					const userMessage: UserMessage = {
						role: "user",
						content: [{ type: "text", text: lastAssistantText! }],
						timestamp: Date.now(),
					};

					const response = await complete(
						extractionModel,
						{ systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
						{ apiKey: auth.apiKey, headers: auth.headers, signal: loader.signal },
					);

					if (response.stopReason === "aborted") {
						return { status: "cancelled" };
					}
					if (response.stopReason === "error") {
						return { status: "error", message: response.errorMessage ?? "question extraction failed" };
					}

					const responseText = response.content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map((c) => c.text)
						.join("\n");
					const result = parseExtractionResult(responseText);
					if (!result) {
						return { status: "error", message: "question extraction returned invalid JSON" };
					}

					return { status: "ok", result };
				};

				doExtract()
					.then(done)
					.catch((error: unknown) => {
						const message = error instanceof Error ? error.message : String(error);
						done({ status: "error", message });
					});

				return loader;
			});

			if (extractionOutcome.status === "cancelled") {
				ctx.ui.notify("Cancelled", "info");
				return;
			}
			if (extractionOutcome.status === "error") {
				ctx.ui.notify(`Question extraction failed: ${extractionOutcome.message}`, "error");
				return;
			}

			const extractionResult = extractionOutcome.result;
			if (extractionResult.questions.length === 0) {
				ctx.ui.notify("No questions found in the last message", "info");
				return;
			}

			// Show the Q&A component
			const answersResult = await ctx.ui.custom<string | null>((tui, _theme, _kb, done) => {
				return new QnAComponent(extractionResult.questions, tui, done);
			});

			if (answersResult === null) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}

			// Send the answers directly as a message and trigger a turn
			pi.sendMessage(
				{
					customType: "answers",
					content: "I answered your questions in the following way:\n\n" + answersResult,
					display: true,
				},
				{ triggerTurn: true },
			);
	};

	pi.registerCommand("answer", {
		description: "Extract questions from last assistant message into interactive Q&A",
		handler: (_args, ctx) => answerHandler(ctx),
	});

	pi.registerShortcut("ctrl+.", {
		description: "Extract and answer questions",
		handler: answerHandler,
	});
}

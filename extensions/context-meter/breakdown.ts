// Splits the context into categories from raw inputs. Pure: callers gather the inputs from Pi.
// Estimates use characters / 4, Pi's own heuristic; the result is scaled to the real total later.

import type { Category } from "./meter.ts";

export interface ToolInfo {
	name: string;
	description?: string;
	parameters?: unknown;
	exposure?: string;
	sourcePath?: string;
}

export interface BreakdownInputs {
	systemPrompt: string;
	contextFiles: Array<{ path: string; content: string }>;
	tools: ToolInfo[];
	messageTokens: number;
}

export function estimateText(text: string): number {
	return Math.ceil(text.length / 4);
}

/** Total length of every `<tag>…</tag>` block in the prompt. */
export function blockLength(prompt: string, tag: string): number {
	const open = `<${tag}>`;
	const close = `</${tag}>`;
	let total = 0;
	let from = 0;
	for (;;) {
		const start = prompt.indexOf(open, from);
		if (start === -1) break;
		const end = prompt.indexOf(close, start + open.length);
		if (end === -1) break;
		total += end + close.length - start;
		from = end + close.length;
	}
	return total;
}

function lengthTokens(length: number): number {
	return Math.ceil(length / 4);
}

/** Tools reach the model as declarations only when exposed directly. */
export function isDeclared(tool: ToolInfo): boolean {
	return tool.exposure === undefined || tool.exposure === "direct" || tool.exposure === "model-only";
}

/** MCP tools, plus codemode, which exists here mainly to reach MCP servers. */
export function isMcpTool(tool: ToolInfo): boolean {
	return tool.name === "codemode" || tool.name.startsWith("mcp__") || (tool.sourcePath ?? "").startsWith("builtin:mcp");
}

function toolTokens(tool: ToolInfo): number {
	let params = "";
	try {
		params = tool.parameters === undefined ? "" : JSON.stringify(tool.parameters);
	} catch {
		params = "";
	}
	return estimateText(`${tool.name}${tool.description ?? ""}${params}`);
}

export function categorize(inputs: BreakdownInputs): Category[] {
	const prompt = inputs.systemPrompt;
	const promptTokens = estimateText(prompt);

	const skills = lengthTokens(blockLength(prompt, "skills") || blockLength(prompt, "available_skills"));
	const mcpSection = lengthTokens(blockLength(prompt, "mcp_servers"));
	const toolSection = lengthTokens(blockLength(prompt, "tools"));
	const contextFiles = inputs.contextFiles
		.filter((f) => f.content && prompt.includes(f.content))
		.reduce((acc, f) => acc + estimateText(f.content), 0);

	let declaredTools = 0;
	let mcpTools = 0;
	for (const tool of inputs.tools) {
		if (!isDeclared(tool)) continue;
		if (isMcpTool(tool)) mcpTools += toolTokens(tool);
		else declaredTools += toolTokens(tool);
	}

	const systemPrompt = Math.max(0, promptTokens - skills - mcpSection - toolSection - contextFiles);

	return [
		{ id: "system", label: "System prompt", color: "muted", tokens: systemPrompt },
		{ id: "tools", label: "Tools", color: "accent", tokens: declaredTools + toolSection },
		{ id: "mcp", label: "MCP", color: "syntaxKeyword", tokens: mcpTools + mcpSection },
		{ id: "skills", label: "Skills", color: "warning", tokens: skills },
		{ id: "context", label: "Context files", color: "success", tokens: contextFiles },
		{ id: "messages", label: "Messages", color: "mdLink", tokens: Math.max(0, Math.round(inputs.messageTokens)) },
	];
}

export const MAX_TOOL_ARGS_CHARS = 500;
export const TOOL_RESULT_MAX_EXPANDED_LINES = 100;

type ToolCallFields = {
	name: string;
	args: Record<string, unknown>;
	intent?: string;
};

type ToolResultFields = {
	resultText: string;
	isError: boolean;
	hasResult: boolean;
};

export type ToolTranscriptFields = ToolCallFields & ToolResultFields;

export function formatToolArgs(name: string, args: Record<string, unknown>): string {
	if (name === "read" || name === "write" || name === "edit") return args.path ? `path: ${args.path}` : "";
	if (name === "bash") return typeof args.command === "string" ? args.command.replaceAll("\t", "    ") : "";
	if (name === "search")
		return [
			args.pattern ? `pattern: ${args.pattern}` : "",
			Array.isArray(args.paths) ? `paths: ${args.paths.join(", ")}` : "",
		]
			.filter(Boolean)
			.join(", ");
	return Object.entries(args)
		.filter(([key]) => !key.startsWith("_"))
		.map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
		.join(", ")
		.slice(0, MAX_TOOL_ARGS_CHARS);
}

export function composeToolCall({ name, args, intent }: ToolCallFields): string {
	return [formatToolArgs(name, args), intent].filter(Boolean).join("\n");
}

export function composeToolResult({ resultText, isError, hasResult }: ToolResultFields): string {
	const text = resultText.trim();
	if (!hasResult) return "⏳ pending";
	if (isError) return `✗ ${text || "Error"}`;
	return text || "✓ done";
}

export function composeToolText(fields: ToolTranscriptFields): string {
	return [composeToolCall(fields), composeToolResult(fields)].filter(Boolean).join("\n");
}

/**
 * Caps result output without allocating an array for every source line. The final
 * line count still requires scanning the result so the omitted-line count is exact.
 */
function expandedToolResult(result: string): string {
	let lineCount = 1;
	let prefixEnd = result.length;
	for (let index = 0; index < result.length; index++) {
		if (result[index] !== "\n") continue;
		if (lineCount === TOOL_RESULT_MAX_EXPANDED_LINES) prefixEnd = index;
		lineCount += 1;
	}
	const prefix = result.slice(0, prefixEnd);
	return lineCount > TOOL_RESULT_MAX_EXPANDED_LINES
		? `${prefix}\n... ${lineCount - TOOL_RESULT_MAX_EXPANDED_LINES} more lines`
		: prefix;
}

export function toolDisplayText(fields: ToolTranscriptFields, expanded: boolean): string {
	const call = composeToolCall(fields);
	if (!expanded) return call;
	return [call, expandedToolResult(composeToolResult(fields))].filter(Boolean).join("\n");
}

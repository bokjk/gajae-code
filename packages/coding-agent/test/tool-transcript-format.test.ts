import { describe, expect, test } from "bun:test";
import {
	composeToolCall,
	composeToolResult,
	composeToolText,
	formatToolArgs,
	MAX_TOOL_ARGS_CHARS,
	TOOL_RESULT_MAX_EXPANDED_LINES,
	toolDisplayText,
} from "../src/modes/components/tool-transcript-format";

describe("tool transcript format", () => {
	test("formats tool arguments with the observer-compatible shapes", () => {
		expect(formatToolArgs("read", { path: "src/file.ts", ignored: "value" })).toBe("path: src/file.ts");
		expect(formatToolArgs("write", { path: "out.txt" })).toBe("path: out.txt");
		expect(formatToolArgs("edit", {})).toBe("");
		expect(formatToolArgs("bash", { command: "printf '\tvalue'" })).toBe("printf '    value'");
		expect(formatToolArgs("search", { pattern: "needle", paths: ["src", "test"] })).toBe(
			"pattern: needle, paths: src, test",
		);
		expect(formatToolArgs("custom", { visible: "value", _private: "hidden", nested: { ok: true } })).toBe(
			'visible: value, nested: {"ok":true}',
		);
		expect(formatToolArgs("custom", { value: "x".repeat(MAX_TOOL_ARGS_CHARS + 10) })).toHaveLength(
			MAX_TOOL_ARGS_CHARS,
		);
	});

	test("composes every tool result state", () => {
		expect(composeToolResult({ resultText: "ignored", isError: false, hasResult: false })).toBe("⏳ pending");
		expect(composeToolResult({ resultText: "", isError: false, hasResult: true })).toBe("✓ done");
		expect(composeToolResult({ resultText: "  completed  ", isError: false, hasResult: true })).toBe("completed");
		expect(composeToolResult({ resultText: "  failed  ", isError: true, hasResult: true })).toBe("✗ failed");
		expect(composeToolResult({ resultText: "", isError: true, hasResult: true })).toBe("✗ Error");
	});

	test("composes calls and canonical tool text", () => {
		const fields = {
			name: "read",
			args: { path: "src/file.ts" },
			intent: "Inspect file",
			resultText: "ok",
			isError: false,
			hasResult: true,
		};
		expect(composeToolCall(fields)).toBe("path: src/file.ts\nInspect file");
		expect(composeToolText(fields)).toBe("path: src/file.ts\nInspect file\nok");
	});

	test("shows call-only while collapsed and caps expanded results by source line", () => {
		const fields = {
			name: "bash",
			args: { command: "echo ok" },
			intent: "Run command",
			resultText: Array.from({ length: TOOL_RESULT_MAX_EXPANDED_LINES + 2 }, (_, index) => `line-${index}`).join(
				"\n",
			),
			isError: false,
			hasResult: true,
		};
		expect(toolDisplayText(fields, false)).toBe("echo ok\nRun command");
		const expanded = toolDisplayText(fields, true);
		expect(expanded).toContain("line-99");
		expect(expanded).not.toContain("line-100");
		expect(expanded).toEndWith("... 2 more lines");
	});
	test("caps expanded results with bounded line storage while preserving line counts", () => {
		const fields = {
			name: "custom",
			args: {},
			intent: undefined,
			isError: false,
			hasResult: true,
			resultText: "",
		};
		for (const lineCount of [99, 100, 101]) {
			fields.resultText = Array.from({ length: lineCount }, (_, index) => `line-${index}`).join("\n");
			const output = toolDisplayText(fields, true);
			if (lineCount <= TOOL_RESULT_MAX_EXPANDED_LINES) expect(output).toContain(`line-${lineCount - 1}`);
			else expect(output).not.toContain(`line-${TOOL_RESULT_MAX_EXPANDED_LINES}`);
			expect(output.endsWith("... 1 more lines")).toBe(lineCount === 101);
		}
		fields.resultText = Array.from({ length: 100_000 }, (_, index) => `line-${index}`).join("\n");
		const output = toolDisplayText(fields, true);
		expect(output).toContain("line-99");
		expect(output).not.toContain("line-100");
		expect(output).toEndWith("... 99900 more lines");
	});

	test("preserves empty, error, pending, and trailing-newline result behavior", () => {
		const base = { name: "custom", args: {}, intent: undefined };
		expect(toolDisplayText({ ...base, resultText: "", isError: false, hasResult: true }, true)).toBe("✓ done");
		expect(toolDisplayText({ ...base, resultText: "", isError: true, hasResult: true }, true)).toBe("✗ Error");
		expect(toolDisplayText({ ...base, resultText: "ignored", isError: false, hasResult: false }, true)).toBe(
			"⏳ pending",
		);
		expect(toolDisplayText({ ...base, resultText: "one\ntwo\n", isError: false, hasResult: true }, true)).toBe(
			"one\ntwo",
		);
	});
});

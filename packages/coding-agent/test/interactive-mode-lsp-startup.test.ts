import { describe, expect, it } from "bun:test";
import {
	filterNoisyOptionalMissingLspStartupFailures,
	isOptionalMissingLspStartupFailure,
	LSP_STARTUP_EVENT_CHANNEL,
	type LspStartupEvent,
} from "../src/lsp/startup-events";

describe("InteractiveMode LSP startup events", () => {
	it("represents startup completion events on the shared channel", () => {
		const event: LspStartupEvent = {
			type: "completed",
			servers: [{ name: "rust-analyzer", status: "ready", fileTypes: [".rs"] }],
		};

		expect(LSP_STARTUP_EVENT_CHANNEL).toBe("lsp:startup");
		expect(event.servers).toEqual([{ name: "rust-analyzer", status: "ready", fileTypes: [".rs"] }]);
	});

	it("classifies missing rust-analyzer startup failures as optional noise", () => {
		const error =
			"LSP server exited (code 1): error: Unknown binary 'rust-analyzer'\nRun `rustup component add rust-analyzer`.";

		expect(isOptionalMissingLspStartupFailure("rust-analyzer", error)).toBe(true);
		expect(isOptionalMissingLspStartupFailure("rust-analyzer", "server crashed while indexing workspace")).toBe(
			false,
		);
		expect(isOptionalMissingLspStartupFailure("clangd", error)).toBe(false);
	});

	it("filters only missing optional rust-analyzer failures so startup warnings stay non-spammy", () => {
		const rustAnalyzerFailure = {
			name: "rust-analyzer",
			status: "error" as const,
			fileTypes: [".rs"],
			error: "LSP server exited (code 1): error: Unknown binary 'rust-analyzer'",
		};
		const clangdFailure = {
			name: "clangd",
			status: "error" as const,
			fileTypes: [".c"],
			error: "ENOENT: clangd",
		};
		const rustAnalyzerCrash = {
			name: "rust-analyzer",
			status: "error" as const,
			fileTypes: [".rs"],
			error: "server crashed while indexing workspace",
		};

		expect(filterNoisyOptionalMissingLspStartupFailures([rustAnalyzerFailure])).toEqual([]);
		expect(filterNoisyOptionalMissingLspStartupFailures([rustAnalyzerFailure, clangdFailure])).toEqual([
			clangdFailure,
		]);
		expect(filterNoisyOptionalMissingLspStartupFailures([rustAnalyzerCrash])).toEqual([rustAnalyzerCrash]);
	});
});

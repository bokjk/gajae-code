import type { LspStartupServerInfo } from "./index";

export const LSP_STARTUP_EVENT_CHANNEL = "lsp:startup";

const OPTIONAL_MISSING_STARTUP_PATTERNS: Array<{ serverName: string; pattern: RegExp }> = [
	{
		serverName: "rust-analyzer",
		pattern: /(?:Unknown binary 'rust-analyzer'|No such file or directory|ENOENT|command not found|not found)/i,
	},
];

export type LspStartupEvent =
	| {
			type: "completed";
			servers: Array<LspStartupServerInfo & { status: "ready" | "error" }>;
	  }
	| {
			type: "failed";
			error: string;
	  };

export function isOptionalMissingLspStartupFailure(serverName: string, error: string | undefined): boolean {
	if (!error) return false;
	return OPTIONAL_MISSING_STARTUP_PATTERNS.some(entry => entry.serverName === serverName && entry.pattern.test(error));
}

export function filterNoisyOptionalMissingLspStartupFailures<T extends { name: string; error?: string }>(
	servers: T[],
): T[] {
	return servers.filter(server => !isOptionalMissingLspStartupFailure(server.name, server.error));
}

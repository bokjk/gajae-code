import { describe, expect, test } from "bun:test";
import { loadConfigFromEnv } from "../src/config";

const presetsJson = JSON.stringify([
	{ id: "demo", workdir: "/home/bot/src/project", sessionCommand: "gjc --worktree", taskTemplate: "Do: {{task}}" },
]);

function baseEnv(extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
	return {
		GJC_TELEGRAM_REMOTE_BOT_TOKEN: "123:abc",
		GJC_TELEGRAM_REMOTE_ALLOWED_USER_IDS: "100, 200",
		GJC_TELEGRAM_REMOTE_PRESETS: presetsJson,
		...extra,
	};
}

describe("loadConfigFromEnv", () => {
	test("loads a minimal, valid config", () => {
		const config = loadConfigFromEnv(baseEnv());
		expect(config.botToken).toBe("123:abc");
		expect([...config.policy.allowedUserIds]).toEqual(["100", "200"]);
		expect(config.policy.presets.has("demo")).toBe(true);
		expect(config.coordinator.command).toBe("gjc");
		expect(config.coordinator.args).toEqual(["mcp-serve", "coordinator"]);
	});

	test("requires a bot token", () => {
		const env = baseEnv();
		delete env.GJC_TELEGRAM_REMOTE_BOT_TOKEN;
		expect(() => loadConfigFromEnv(env)).toThrow(/missing_env:GJC_TELEGRAM_REMOTE_BOT_TOKEN/);
	});

	test("default-denies when no allowlist is configured", () => {
		const env = baseEnv();
		delete env.GJC_TELEGRAM_REMOTE_ALLOWED_USER_IDS;
		expect(() => loadConfigFromEnv(env)).toThrow(/no_allowlist/);
	});

	test("forces the smallest mutation set and never enables questions", () => {
		const readOnly = loadConfigFromEnv(baseEnv());
		expect(readOnly.coordinator.env.GJC_COORDINATOR_MCP_MUTATIONS).toBe("sessions");
		const withStop = loadConfigFromEnv(baseEnv({ GJC_TELEGRAM_REMOTE_ENABLE_STOP: "true" }));
		expect(withStop.coordinator.env.GJC_COORDINATOR_MCP_MUTATIONS).toBe("sessions,reports");
		expect(withStop.coordinator.env.GJC_COORDINATOR_MCP_MUTATIONS).not.toContain("questions");
	});

	test("derives workdir roots and session command from presets", () => {
		const config = loadConfigFromEnv(baseEnv());
		expect(config.coordinator.env.GJC_COORDINATOR_MCP_WORKDIR_ROOTS).toBe("/home/bot/src/project");
		expect(config.coordinator.env.GJC_COORDINATOR_MCP_SESSION_COMMAND).toBe("gjc --worktree");
	});

	test("rejects ambiguous session commands without an explicit override", () => {
		const env = baseEnv({
			GJC_TELEGRAM_REMOTE_PRESETS: JSON.stringify([
				{ id: "a", workdir: "/home/bot/a", sessionCommand: "gjc --worktree" },
				{ id: "b", workdir: "/home/bot/b", sessionCommand: "gjc --tmux" },
			]),
		});
		expect(() => loadConfigFromEnv(env)).toThrow(/ambiguous_session_command/);
	});

	test("rejects a preset workdir outside explicit roots", () => {
		const env = baseEnv({ GJC_COORDINATOR_MCP_WORKDIR_ROOTS: "/home/bot/other" });
		expect(() => loadConfigFromEnv(env)).toThrow(/workdir_outside_roots/);
	});

	test("rejects malformed preset JSON", () => {
		expect(() => loadConfigFromEnv(baseEnv({ GJC_TELEGRAM_REMOTE_PRESETS: "{not json" }))).toThrow(
			/presets_invalid_json/,
		);
	});
});

import { afterEach, describe, expect, test } from "bun:test";
import * as path from "node:path";
import { McpStdioCoordinatorClient } from "../src/coordinator-client";

const FAKE = path.join(import.meta.dir, "fixtures", "fake-coordinator.ts");

let client: McpStdioCoordinatorClient | null = null;

function makeClient(command = "bun", args = [FAKE]): McpStdioCoordinatorClient {
	client = new McpStdioCoordinatorClient({ command, args, env: {} });
	return client;
}

afterEach(async () => {
	await client?.close();
	client = null;
});

describe("McpStdioCoordinatorClient (real subprocess JSON-RPC)", () => {
	test("reads bounded coordination status", async () => {
		const status = await makeClient().getCoordinationStatus();
		expect(status.ok).toBe(true);
		expect(status.sessions).toHaveLength(1);
		expect(status.sessionStates).toHaveLength(1);
		expect(status.turns).toHaveLength(1);
	});

	test("starts a session with allow_mutation and returns the session id", async () => {
		const result = await makeClient().startSession({ cwd: "/home/bot/src/project", prompt: "hi" });
		expect(result).toEqual({ ok: true, sessionId: "sess-new" });
	});

	test("records a cancelled report", async () => {
		const result = await makeClient().reportStatus({ sessionId: "sess-1", turnId: "turn-1", status: "cancelled" });
		expect(result).toEqual({ ok: true });
	});

	test("returns coordinator_unreachable when the subprocess cannot be spawned", async () => {
		const status = await makeClient("gjc-telegram-remote-no-such-binary", []).getCoordinationStatus();
		expect(status.ok).toBe(false);
		expect(status.reason).toBe("coordinator_unreachable");
	});
});

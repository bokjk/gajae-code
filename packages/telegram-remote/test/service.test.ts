import { describe, expect, test } from "bun:test";
import type { ServiceConfig } from "../src/config";
import { MESSAGES, UNAUTHORIZED_REFUSAL } from "../src/messages";
import { runService } from "../src/service";
import type { CoordinationStatus, IncomingMessage } from "../src/types";
import { FakeCoordinatorClient, FakeTransport, preset, presetMap } from "./helpers";

function serviceConfig(): ServiceConfig {
	return {
		botToken: "x",
		pollTimeoutSec: 1,
		policy: {
			allowedUserIds: new Set(["100"]),
			allowedChatIds: new Set(),
			presets: presetMap(preset()),
			enableStop: true,
		},
		coordinator: { command: "gjc", args: ["mcp-serve", "coordinator"], env: {} },
	};
}

describe("runService end-to-end (fake transport + fake coordinator)", () => {
	test("drives the command loop and replies per the contract", async () => {
		const coordinator = new FakeCoordinatorClient();
		const liveStatus: CoordinationStatus = {
			ok: true,
			sessions: [{ session_id: "sess-1", branch: "main" }],
			sessionStates: [{ session_id: "sess-1", state: "running", live: true }],
			turns: [{ session_id: "sess-1", status: "active", turn_id: "turn-1" }],
		};
		coordinator.status = liveStatus;

		const inbox: IncomingMessage[] = [
			{ userId: "100", chatId: "100", text: "/help" },
			{ userId: "100", chatId: "100", text: "/sessions" },
			{ userId: "100", chatId: "100", text: "/start-session demo build it" },
			{ userId: "666", chatId: "666", text: "/sessions" },
		];
		const transport = new FakeTransport(inbox);

		await runService(serviceConfig(), { coordinator, transport });

		expect(transport.sent[0]?.text).toBe(MESSAGES.help);
		expect(transport.sent[1]?.text).toContain("sess-1");
		expect(transport.sent[2]?.text).toContain("sess-1");
		expect(transport.sent[3]?.text).toBe(UNAUTHORIZED_REFUSAL);
		expect(coordinator.countOf("startSession")).toBe(1);
	});
});

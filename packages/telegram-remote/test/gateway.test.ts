import { beforeEach, describe, expect, test } from "bun:test";
import { type GatewayPolicy, TelegramRemoteGateway } from "../src/gateway";
import { MESSAGES, UNAUTHORIZED_REFUSAL } from "../src/messages";
import type { CoordinationStatus } from "../src/types";
import { FakeCoordinatorClient, message, preset, presetMap } from "./helpers";

function liveSession(): CoordinationStatus {
	return {
		ok: true,
		sessions: [{ session_id: "sess-1", branch: "main" }],
		sessionStates: [{ session_id: "sess-1", state: "running", live: true, updated_at: "2026-06-15T00:00:00.000Z" }],
		turns: [{ session_id: "sess-1", status: "active", turn_id: "turn-1" }],
	};
}

let coordinator: FakeCoordinatorClient;
let clock: number;

function makeGateway(overrides: Partial<GatewayPolicy> = {}): TelegramRemoteGateway {
	return new TelegramRemoteGateway(
		{
			allowedUserIds: new Set(["100"]),
			allowedChatIds: new Set(["900"]),
			presets: presetMap(preset({ id: "demo", taskTemplate: "Task: {{task}}", taskMaxLen: 20 })),
			enableStop: true,
			confirmTtlMs: 1000,
			...overrides,
		},
		{ coordinator, now: () => clock },
	);
}

beforeEach(() => {
	coordinator = new FakeCoordinatorClient();
	clock = 0;
});

describe("authorization (default deny)", () => {
	test("an unlisted sender gets the boring refusal and triggers no backend call", async () => {
		const gateway = makeGateway();
		const reply = await gateway.handleMessage(message({ userId: "999", chatId: "999", text: "/sessions" }));
		expect(reply).toBe(UNAUTHORIZED_REFUSAL);
		expect(coordinator.calls).toHaveLength(0);
	});

	test("refusal is identical regardless of the attempted command (no hints)", async () => {
		const gateway = makeGateway();
		const a = await gateway.handleMessage(message({ userId: "999", chatId: "999", text: "/start-session demo x" }));
		const b = await gateway.handleMessage(message({ userId: "999", chatId: "999", text: "/stop sess-1 confirm" }));
		expect(a).toBe(UNAUTHORIZED_REFUSAL);
		expect(b).toBe(UNAUTHORIZED_REFUSAL);
	});

	test("authorization can be granted by chat id", async () => {
		const gateway = makeGateway();
		const reply = await gateway.handleMessage(message({ userId: null, chatId: "900", text: "/help" }));
		expect(reply).toBe(MESSAGES.help);
	});

	test("with no allowlist nobody is authorized", async () => {
		const gateway = makeGateway({ allowedUserIds: new Set(), allowedChatIds: new Set() });
		const reply = await gateway.handleMessage(message({ text: "/help" }));
		expect(reply).toBe(UNAUTHORIZED_REFUSAL);
	});
});

describe("read commands", () => {
	test("/sessions renders bounded summaries", async () => {
		coordinator.status = liveSession();
		const gateway = makeGateway();
		const reply = await gateway.handleMessage(message({ text: "/sessions" }));
		expect(reply).toContain("sess-1");
		expect(reply).toContain("working");
		expect(coordinator.countOf("getCoordinationStatus")).toBe(1);
	});

	test("/sessions reports a boring offline message when the backend is unreachable", async () => {
		coordinator.status = { ok: false, reason: "coordinator_unreachable", sessions: [], sessionStates: [], turns: [] };
		const gateway = makeGateway();
		expect(await gateway.handleMessage(message({ text: "/sessions" }))).toBe(MESSAGES.backendOffline);
	});

	test("/observe requires a session id and rejects unknown sessions", async () => {
		coordinator.status = liveSession();
		const gateway = makeGateway();
		expect(await gateway.handleMessage(message({ text: "/observe" }))).toBe(MESSAGES.observeUsage);
		expect(await gateway.handleMessage(message({ text: "/observe missing" }))).toBe(MESSAGES.unknownSession);
		expect(await gateway.handleMessage(message({ text: "/observe sess-1" }))).toContain("status: working");
	});
});

describe("/start-session preset binding", () => {
	test("missing preset id shows usage and calls no backend", async () => {
		const gateway = makeGateway();
		expect(await gateway.handleMessage(message({ text: "/start-session" }))).toBe(MESSAGES.startUsage);
		expect(coordinator.countOf("startSession")).toBe(0);
	});

	test("unknown preset is rejected without enumeration and without a backend call", async () => {
		const gateway = makeGateway();
		expect(await gateway.handleMessage(message({ text: "/start-session nope task" }))).toBe(MESSAGES.unknownPreset);
		expect(coordinator.countOf("startSession")).toBe(0);
	});

	test("over-length task is rejected before any backend call", async () => {
		const gateway = makeGateway();
		const reply = await gateway.handleMessage(message({ text: `/start-session demo ${"x".repeat(30)}` }));
		expect(reply).toBe(MESSAGES.taskTooLong);
		expect(coordinator.countOf("startSession")).toBe(0);
	});

	test("start binds the preset workdir, never a chat-supplied path", async () => {
		const gateway = makeGateway();
		const reply = await gateway.handleMessage(message({ text: "/start-session demo /etc/passwd" }));
		expect(coordinator.countOf("startSession")).toBe(1);
		expect(coordinator.calls[0]?.args).toEqual({ cwd: "/home/bot/src/project", prompt: "Task: /etc/passwd" });
		expect(reply).toContain("sess-1");
	});

	test("maps fail-closed mutation reasons to boring messages", async () => {
		const gateway = makeGateway();
		coordinator.startResult = { ok: false, reason: "coordinator_mutation_class_disabled:sessions" };
		expect(await gateway.handleMessage(message({ text: "/start-session demo x" }))).toBe(
			MESSAGES.sessionControlDisabled,
		);
		coordinator.startResult = { ok: false, reason: "coordinator_mutation_call_not_allowed:sessions" };
		expect(await gateway.handleMessage(message({ text: "/start-session demo x" }))).toBe(
			MESSAGES.sessionControlNotPermitted,
		);
	});
});

describe("/stop confirmation gating", () => {
	test("stop is disabled when reports mutation is not enabled", async () => {
		coordinator.status = liveSession();
		const gateway = makeGateway({ enableStop: false });
		expect(await gateway.handleMessage(message({ text: "/stop sess-1" }))).toBe(MESSAGES.sessionControlDisabled);
		expect(coordinator.countOf("reportStatus")).toBe(0);
	});

	test("first /stop arms; a second /stop ... confirm executes the cancel once", async () => {
		coordinator.status = liveSession();
		const gateway = makeGateway();
		const armed = await gateway.handleMessage(message({ text: "/stop sess-1" }));
		expect(armed).toContain("confirm");
		expect(coordinator.countOf("reportStatus")).toBe(0);

		const done = await gateway.handleMessage(message({ text: "/stop sess-1 confirm" }));
		expect(done).toContain("Stop requested");
		expect(coordinator.countOf("reportStatus")).toBe(1);
		expect(coordinator.calls.at(-1)?.args).toMatchObject({
			sessionId: "sess-1",
			turnId: "turn-1",
			status: "cancelled",
		});
	});

	test("confirm without a prior arm does not execute", async () => {
		coordinator.status = liveSession();
		const gateway = makeGateway();
		const reply = await gateway.handleMessage(message({ text: "/stop sess-1 confirm" }));
		expect(reply).toContain("confirm");
		expect(coordinator.countOf("reportStatus")).toBe(0);
	});

	test("an expired arm must be re-confirmed", async () => {
		coordinator.status = liveSession();
		const gateway = makeGateway({ confirmTtlMs: 1000 });
		await gateway.handleMessage(message({ text: "/stop sess-1" }));
		clock = 2000; // beyond TTL
		const reply = await gateway.handleMessage(message({ text: "/stop sess-1 confirm" }));
		expect(reply).toContain("confirm");
		expect(coordinator.countOf("reportStatus")).toBe(0);
	});

	test("unknown session is refused before arming", async () => {
		coordinator.status = liveSession();
		const gateway = makeGateway();
		expect(await gateway.handleMessage(message({ text: "/stop missing" }))).toBe(MESSAGES.unknownSession);
	});

	test("an offline session fails closed: no arm, no report", async () => {
		coordinator.status = {
			ok: true,
			sessions: [{ session_id: "sess-1", branch: "main" }],
			sessionStates: [{ session_id: "sess-1", state: "running", live: false }],
			turns: [],
		};
		const gateway = makeGateway();
		expect(await gateway.handleMessage(message({ text: "/stop sess-1" }))).toBe(MESSAGES.backendOffline);
		expect(await gateway.handleMessage(message({ text: "/stop sess-1 confirm" }))).toBe(MESSAGES.backendOffline);
		expect(coordinator.countOf("reportStatus")).toBe(0);
	});
});

describe("unknown commands", () => {
	test("authorized unknown command gets the boring unknown message", async () => {
		const gateway = makeGateway();
		expect(await gateway.handleMessage(message({ text: "/shell rm -rf /" }))).toBe(MESSAGES.unknownCommand);
	});
});

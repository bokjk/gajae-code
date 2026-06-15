import { describe, expect, test } from "bun:test";
import { parseCommand } from "../src/commands";

describe("parseCommand", () => {
	test("parses the five commands plus help", () => {
		expect(parseCommand("/help")).toEqual({ kind: "help" });
		expect(parseCommand("/sessions")).toEqual({ kind: "sessions" });
		expect(parseCommand("/observe sess-1")).toEqual({ kind: "observe", sessionId: "sess-1" });
		expect(parseCommand("/start-session demo build the thing")).toEqual({
			kind: "start_session",
			presetId: "demo",
			task: "build the thing",
		});
		expect(parseCommand("/stop sess-1")).toEqual({ kind: "stop", sessionId: "sess-1", confirm: false });
		expect(parseCommand("/stop sess-1 confirm")).toEqual({ kind: "stop", sessionId: "sess-1", confirm: true });
	});

	test("strips @botname mention and is case-insensitive", () => {
		expect(parseCommand("/Sessions@MyGjcBot")).toEqual({ kind: "sessions" });
		expect(parseCommand("/STOP sess-1 CONFIRM")).toEqual({ kind: "stop", sessionId: "sess-1", confirm: true });
	});

	test("missing arguments resolve to null fields, not crashes", () => {
		expect(parseCommand("/observe")).toEqual({ kind: "observe", sessionId: null });
		expect(parseCommand("/start-session")).toEqual({ kind: "start_session", presetId: null, task: null });
		expect(parseCommand("/stop")).toEqual({ kind: "stop", sessionId: null, confirm: false });
	});

	test("rejects the undocumented underscore alias for start-session", () => {
		expect(parseCommand("/start_session demo")).toEqual({ kind: "unknown" });
	});

	test("rejects everything outside the vocabulary as unknown", () => {
		expect(parseCommand("/start")).toEqual({ kind: "unknown" });
		expect(parseCommand("/shell rm -rf /")).toEqual({ kind: "unknown" });
		expect(parseCommand("/exec")).toEqual({ kind: "unknown" });
		expect(parseCommand("hello there")).toEqual({ kind: "unknown" });
		expect(parseCommand("")).toEqual({ kind: "unknown" });
		expect(parseCommand("   ")).toEqual({ kind: "unknown" });
	});

	test("a non-leading slash is not a command", () => {
		expect(parseCommand("please /stop it")).toEqual({ kind: "unknown" });
	});
});

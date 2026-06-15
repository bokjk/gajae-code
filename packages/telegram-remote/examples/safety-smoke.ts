/**
 * Runnable safety smoke for the Telegram Remote gateway. Drives a set of
 * adversarial messages through the gateway with an in-memory coordinator (no
 * bot token, no network, no real session backend) and asserts the v0 safety
 * invariants hold. Prints a single deterministic line on success so it can be
 * replayed as CLI evidence; throws (non-zero exit) on any violation.
 *
 *   bun packages/telegram-remote/examples/safety-smoke.ts
 */
import { TelegramRemoteGateway } from "../src/gateway";
import { UNAUTHORIZED_REFUSAL } from "../src/messages";
import type {
	CoordinationStatus,
	CoordinatorClient,
	IncomingMessage,
	ReportStatusResult,
	StartSessionResult,
} from "../src/types";

const HOSTILE_STATUS: CoordinationStatus = {
	ok: true,
	sessions: [
		{
			session_id: "sess-1",
			branch: "feat/x",
			repo: "proj",
			cwd: "/secret/abs/path",
			tail_preview: ["SECRET_TAIL", "export TOKEN=sk-LEAK"],
			final_response: { text: "TRANSCRIPT_LEAK" },
		},
	],
	sessionStates: [{ session_id: "sess-1", state: "running", live: true, reason: "INTERNAL_LEAK" }],
	turns: [{ session_id: "sess-1", status: "active", turn_id: "turn-1", prompt: { text: "PROMPT_LEAK" } }],
};

const FORBIDDEN = ["SECRET_TAIL", "sk-LEAK", "TRANSCRIPT_LEAK", "PROMPT_LEAK", "/secret/abs/path"];

class SmokeCoordinator implements CoordinatorClient {
	startCalls = 0;
	reportCalls = 0;
	async getCoordinationStatus(): Promise<CoordinationStatus> {
		return HOSTILE_STATUS;
	}
	async startSession(input: { cwd: string; prompt?: string }): Promise<StartSessionResult> {
		this.startCalls++;
		this.lastStartCwd = input.cwd;
		return { ok: true, sessionId: "sess-new" };
	}
	async reportStatus(): Promise<ReportStatusResult> {
		this.reportCalls++;
		return { ok: true };
	}
	lastStartCwd = "";
}

function assert(condition: boolean, message: string): void {
	if (!condition) throw new Error(`safety-smoke failed: ${message}`);
}

async function main(): Promise<void> {
	const coordinator = new SmokeCoordinator();
	const gateway = new TelegramRemoteGateway(
		{
			allowedUserIds: new Set(["100"]),
			allowedChatIds: new Set(),
			presets: new Map([
				[
					"demo",
					{
						id: "demo",
						workdir: "/home/bot/src/project",
						sessionCommand: "gjc --worktree",
						taskTemplate: "Task: {{task}}",
						taskMaxLen: 50,
					},
				],
			]),
			enableStop: true,
		},
		{ coordinator },
	);

	const auth = (text: string): IncomingMessage => ({ userId: "100", chatId: "100", text });
	const intruder = (text: string): IncomingMessage => ({ userId: "999", chatId: "999", text });

	// 1. Default deny: an intruder gets the identical boring refusal and no backend call.
	for (const text of ["/sessions", "/start-session demo x", "/stop sess-1 confirm"]) {
		assert((await gateway.handleMessage(intruder(text))) === UNAUTHORIZED_REFUSAL, `intruder refused: ${text}`);
	}
	assert(coordinator.startCalls === 0 && coordinator.reportCalls === 0, "intruder triggered no mutation");

	// 2. Redaction: hostile coordinator fields never reach chat.
	const listed = await gateway.handleMessage(auth("/sessions"));
	const observed = await gateway.handleMessage(auth("/observe sess-1"));
	for (const secret of FORBIDDEN) {
		assert(!listed.includes(secret), `list leaked ${secret}`);
		assert(!observed.includes(secret), `observe leaked ${secret}`);
	}

	// 3. Workdir injection: chat-supplied path never becomes the cwd.
	await gateway.handleMessage(auth("/start-session demo /etc/shadow"));
	assert(coordinator.lastStartCwd === "/home/bot/src/project", "workdir bound to preset, not chat");

	// 4. /stop confirmation gating: arm does not mutate; only confirm does.
	await gateway.handleMessage(auth("/stop sess-1"));
	assert(coordinator.reportCalls === 0, "arm did not mutate");
	await gateway.handleMessage(auth("/stop sess-1 confirm"));
	assert(coordinator.reportCalls === 1, "confirm recorded exactly one cancel");

	process.stdout.write("telegram-remote-safety-ok\n");
}

await main();

import type {
	CoordinationStatus,
	CoordinatorClient,
	GatewayPreset,
	IncomingMessage,
	ReportStatusResult,
	StartSessionResult,
	TelegramTransport,
} from "../src/types";

export interface RecordedCall {
	method: "getCoordinationStatus" | "startSession" | "reportStatus";
	args: unknown;
}

/** In-memory CoordinatorClient that records calls and returns scripted results. */
export class FakeCoordinatorClient implements CoordinatorClient {
	status: CoordinationStatus = { ok: true, sessions: [], sessionStates: [], turns: [] };
	startResult: StartSessionResult = { ok: true, sessionId: "sess-1" };
	reportResult: ReportStatusResult = { ok: true };
	calls: RecordedCall[] = [];

	async getCoordinationStatus(): Promise<CoordinationStatus> {
		this.calls.push({ method: "getCoordinationStatus", args: {} });
		return this.status;
	}

	async startSession(input: { cwd: string; prompt?: string }): Promise<StartSessionResult> {
		this.calls.push({ method: "startSession", args: input });
		return this.startResult;
	}

	async reportStatus(input: {
		sessionId: string;
		turnId?: string;
		status: "cancelled";
		summary?: string;
	}): Promise<ReportStatusResult> {
		this.calls.push({ method: "reportStatus", args: input });
		return this.reportResult;
	}

	countOf(method: RecordedCall["method"]): number {
		return this.calls.filter(call => call.method === method).length;
	}
}

/** Drives a scripted list of inbound messages through the gateway and records replies. */
export class FakeTransport implements TelegramTransport {
	sent: Array<{ chatId: string; text: string }> = [];
	constructor(private readonly inbox: IncomingMessage[]) {}

	async run(onMessage: (message: IncomingMessage) => Promise<string>): Promise<void> {
		for (const message of this.inbox) {
			const reply = await onMessage(message);
			this.sent.push({ chatId: message.chatId, text: reply });
		}
	}

	stop(): void {}
}

export function preset(overrides: Partial<GatewayPreset> = {}): GatewayPreset {
	return {
		id: "demo",
		workdir: "/home/bot/src/project",
		sessionCommand: "gjc --worktree",
		taskTemplate: "Work on this task: {{task}}",
		taskMaxLen: 100,
		...overrides,
	};
}

export function presetMap(...presets: GatewayPreset[]): Map<string, GatewayPreset> {
	return new Map(presets.map(item => [item.id, item]));
}

export function message(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
	return { userId: "100", chatId: "100", text: "/help", ...overrides };
}

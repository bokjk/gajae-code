/**
 * Shared domain types for the v0 Telegram Remote gateway.
 *
 * Tracks docs/telegram-remote.md. The gateway is a thin command + bounded-read
 * surface over the Coordinator MCP. Nothing here imports coding-agent internals;
 * the only contract with the coordinator is the {@link CoordinatorClient} port.
 */

/** Opaque coordinator record. The gateway never trusts or forwards raw fields. */
export type RawRecord = Record<string, unknown>;

/**
 * A named, server-side session preset. Never assembled from chat input.
 * `workdir` and `sessionCommand` are fixed bindings; the only chat-supplied
 * value is a single length-capped task string injected into `taskTemplate`.
 */
export interface GatewayPreset {
	/** The only preset reference a chat user may name. */
	id: string;
	/** Fixed workdir; must be inside the coordinator workdir allowlist. */
	workdir: string;
	/** Fixed session command (e.g. `gjc --worktree`). Enforced coordinator-side. */
	sessionCommand: string;
	/** Optional fixed template with exactly one `{{task}}` slot. */
	taskTemplate?: string;
	/** Hard length cap on the chat-supplied task string. */
	taskMaxLen: number;
}

/** Bounded session status enum that may leave the PC into chat. */
export type SessionStatus = "idle" | "working" | "blocked" | "offline";

/** Bounded turn-lifecycle enum that may leave the PC into chat. */
export type TurnActivity = "none" | "queued" | "active" | "waiting_for_answer" | "terminal";

/** Allowlisted session-list projection. Only these fields may reach chat. */
export interface SessionSummary {
	sessionId: string;
	name: string;
	status: SessionStatus;
	branch: string | null;
	lastActivityAt: string | null;
}

/** Allowlisted open-session projection. Only these fields may reach chat. */
export interface SessionView extends SessionSummary {
	activeTurn: TurnActivity;
	/** Short sanitized reason when blocked; null when not blocked or withheld. */
	blockerSummary: string | null;
}

/** A message received from the Telegram transport, normalized for the gateway. */
export interface IncomingMessage {
	/** Telegram user id; null when not present (e.g. channel posts). */
	userId: string | null;
	/** Telegram chat id the reply must be sent to. */
	chatId: string;
	/** Raw message text. */
	text: string;
}

/** Parsed command vocabulary. Everything outside this set is `unknown`. */
export type ParsedCommand =
	| { kind: "help" }
	| { kind: "sessions" }
	| { kind: "observe"; sessionId: string | null }
	| { kind: "start_session"; presetId: string | null; task: string | null }
	| { kind: "stop"; sessionId: string | null; confirm: boolean }
	| { kind: "unknown" };

/** Result of reading bounded coordination state. */
export interface CoordinationStatus {
	ok: boolean;
	/** Failure reason when `ok` is false (e.g. `coordinator_unreachable`). */
	reason?: string;
	sessions: RawRecord[];
	sessionStates: RawRecord[];
	turns: RawRecord[];
}

/** Result of a preset-bound session start. */
export interface StartSessionResult {
	ok: boolean;
	reason?: string;
	sessionId?: string;
}

/** Result of recording a coordinator report (used for `/stop`). */
export interface ReportStatusResult {
	ok: boolean;
	reason?: string;
}

/**
 * The only contract the gateway has with the session backend. v0 maps the
 * command vocabulary onto these bounded operations; the MCP stdio client and
 * test fakes both implement this port.
 */
export interface CoordinatorClient {
	/** Bounded, redaction-friendly cross-session read. Never raw tail/scrollback. */
	getCoordinationStatus(): Promise<CoordinationStatus>;
	/** Preset-bound creation. Only `cwd` (+ optional templated prompt) crosses. */
	startSession(input: { cwd: string; prompt?: string }): Promise<StartSessionResult>;
	/** Records a terminal coordinator status (used for graceful `/stop`). */
	reportStatus(input: {
		sessionId: string;
		turnId?: string;
		status: "cancelled";
		summary?: string;
	}): Promise<ReportStatusResult>;
	/** Release any underlying process. Optional for in-memory implementations. */
	close?(): Promise<void>;
}

/** Telegram transport port. The real adapter long-polls the Bot API. */
export interface TelegramTransport {
	/** Run the receive loop, replying with the handler's returned text. */
	run(onMessage: (message: IncomingMessage) => Promise<string>): Promise<void>;
	/** Stop the receive loop. */
	stop(): void;
}

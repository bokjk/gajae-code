/**
 * The Telegram Remote gateway core. Maps the fixed command vocabulary onto the
 * {@link CoordinatorClient} port under default-deny authorization, redacted
 * projection, fail-closed mutation handling, and explicit `/stop` confirmation.
 *
 * The gateway is transport-agnostic: {@link TelegramRemoteGateway.handleMessage}
 * takes a normalized message and returns chat-safe reply text. The real Telegram
 * adapter and the test fakes feed it the same shape.
 */
import { parseCommand } from "./commands";
import { MESSAGES } from "./messages";
import { resolvePreset } from "./presets";
import {
	activeTurnId,
	findSessionView,
	projectSessionSummaries,
	renderSessionsList,
	renderSessionView,
} from "./projection";
import type { CoordinatorClient, GatewayPreset, IncomingMessage } from "./types";

const DEFAULT_CONFIRM_TTL_MS = 120_000;

/** Authorization + preset policy the gateway enforces. */
export interface GatewayPolicy {
	allowedUserIds: ReadonlySet<string>;
	allowedChatIds: ReadonlySet<string>;
	presets: ReadonlyMap<string, GatewayPreset>;
	/** When false, `/stop` is refused as disabled (no `reports` mutation). */
	enableStop: boolean;
	/** How long a `/stop` arm stays valid before re-confirmation. */
	confirmTtlMs?: number;
}

/** Runtime dependencies for the gateway. */
export interface GatewayDeps {
	coordinator: CoordinatorClient;
	/** Injectable clock for deterministic confirmation-expiry tests. */
	now?: () => number;
}

/** Map a coordinator failure reason onto a boring, safe chat message. */
function mapReason(reason: string | undefined): string {
	if (!reason) return MESSAGES.genericFailure;
	if (reason.startsWith("coordinator_mutation_class_disabled")) return MESSAGES.sessionControlDisabled;
	if (reason.startsWith("coordinator_mutation_call_not_allowed")) return MESSAGES.sessionControlNotPermitted;
	if (reason === "unknown_session") return MESSAGES.unknownSession;
	if (reason === "active_turn_exists") return MESSAGES.activeTurnExists;
	if (reason === "coordinator_unreachable" || reason === "offline") return MESSAGES.backendOffline;
	return MESSAGES.genericFailure;
}

export class TelegramRemoteGateway {
	private readonly policy: GatewayPolicy;
	private readonly coordinator: CoordinatorClient;
	private readonly now: () => number;
	/** Pending `/stop` confirmations keyed by `${chatId}:${sessionId}` → expiry ms. */
	private readonly pendingStops = new Map<string, number>();

	constructor(policy: GatewayPolicy, deps: GatewayDeps) {
		this.policy = policy;
		this.coordinator = deps.coordinator;
		this.now = deps.now ?? Date.now;
	}

	/** Handle one inbound message and return chat-safe reply text. */
	async handleMessage(message: IncomingMessage): Promise<string> {
		if (!this.isAuthorized(message)) {
			return MESSAGES.unauthorized;
		}

		const command = parseCommand(message.text);
		switch (command.kind) {
			case "help":
				return MESSAGES.help;
			case "sessions":
				return this.handleSessions();
			case "observe":
				return this.handleObserve(command.sessionId);
			case "start_session":
				return this.handleStartSession(command.presetId, command.task);
			case "stop":
				return this.handleStop(message.chatId, command.sessionId, command.confirm);
			default:
				return MESSAGES.unknownCommand;
		}
	}

	private isAuthorized(message: IncomingMessage): boolean {
		if (message.userId !== null && this.policy.allowedUserIds.has(message.userId)) return true;
		return this.policy.allowedChatIds.has(message.chatId);
	}

	private async handleSessions(): Promise<string> {
		const status = await this.coordinator.getCoordinationStatus();
		if (!status.ok) return MESSAGES.backendOffline;
		return renderSessionsList(projectSessionSummaries(status));
	}

	private async handleObserve(sessionId: string | null): Promise<string> {
		if (!sessionId) return MESSAGES.observeUsage;
		const status = await this.coordinator.getCoordinationStatus();
		if (!status.ok) return MESSAGES.backendOffline;
		const view = findSessionView(status, sessionId);
		if (!view) return MESSAGES.unknownSession;
		return renderSessionView(view);
	}

	private async handleStartSession(presetId: string | null, task: string | null): Promise<string> {
		if (!presetId) return MESSAGES.startUsage;
		const resolution = resolvePreset(this.policy.presets, presetId, task);
		if (!resolution.ok) {
			return resolution.reason === "unknown_preset" ? MESSAGES.unknownPreset : MESSAGES.taskTooLong;
		}
		const result = await this.coordinator.startSession({
			cwd: resolution.preset.workdir,
			prompt: resolution.prompt,
		});
		if (!result.ok) return mapReason(result.reason);
		return `Started ${result.sessionId ?? "session"} from preset ${resolution.preset.id}.`;
	}

	private async handleStop(chatId: string, sessionId: string | null, confirm: boolean): Promise<string> {
		if (!sessionId) return MESSAGES.stopUsage;
		if (!this.policy.enableStop) return MESSAGES.sessionControlDisabled;

		const status = await this.coordinator.getCoordinationStatus();
		if (!status.ok) return MESSAGES.backendOffline;
		const view = findSessionView(status, sessionId);
		if (!view) return MESSAGES.unknownSession;
		// Fail closed: never record control for an offline session (it may have a different owner).
		if (view.status === "offline") return MESSAGES.backendOffline;

		const key = `${chatId}:${sessionId}`;
		const now = this.now();
		if (confirm && this.isArmed(key, now)) {
			this.pendingStops.delete(key);
			const turnId = activeTurnId(status, sessionId) ?? undefined;
			const result = await this.coordinator.reportStatus({
				sessionId,
				turnId,
				status: "cancelled",
				summary: "Operator requested graceful stop via Telegram remote.",
			});
			if (!result.ok) return mapReason(result.reason);
			return `Stop requested for ${sessionId}.`;
		}

		this.pendingStops.set(key, now + (this.policy.confirmTtlMs ?? DEFAULT_CONFIRM_TTL_MS));
		return `Confirm stop of ${sessionId}: send /stop ${sessionId} confirm`;
	}

	private isArmed(key: string, now: number): boolean {
		const expiry = this.pendingStops.get(key);
		return expiry !== undefined && expiry > now;
	}
}

/**
 * The Telegram Remote gateway core. Maps the fixed command vocabulary AND inline
 * keyboard callbacks onto the {@link CoordinatorClient} port under default-deny
 * authorization, redacted projection, fail-closed mutation handling, and explicit
 * `/stop` confirmation.
 *
 * Rich messaging is a presentation + alternate-entry layer: callbacks reuse the
 * same handlers/coordinator calls as text commands (no second control path), and
 * the transmitted-data allowlist is unchanged. {@link TelegramRemoteGateway.handleUpdate}
 * is the primary entry; {@link TelegramRemoteGateway.handleMessage} is a thin
 * text-only compatibility wrapper.
 */
import { parseCommand } from "./commands";
import { MESSAGES } from "./messages";
import { resolvePreset } from "./presets";
import {
	activeTurnId,
	escapeHtml,
	findSessionView,
	projectSessionRows,
	projectSessionSummaries,
	renderSessionsList,
	renderSessionsListHtml,
	renderSessionView,
	renderSessionViewHtml,
} from "./projection";
import { type CallbackTokenRecord, CallbackTokenStore } from "./tokens";
import type {
	CallbackAnswerOnlyReply,
	ChatReply,
	CoordinationStatus,
	CoordinatorClient,
	GatewayPreset,
	IncomingCallbackQuery,
	IncomingMessage,
	IncomingTextMessage,
	IncomingUpdate,
	OutgoingReply,
	SessionView,
	TelegramInlineKeyboardButton,
	TelegramInlineKeyboardMarkup,
} from "./types";

const DEFAULT_CONFIRM_TTL_MS = 120_000;
const DEFAULT_RICH_TTL_MS = 600_000;
const BUTTON_NAME_MAX = 40;
const STOP_SUMMARY = "Operator requested graceful stop via Telegram remote.";

/** Authorization + preset + rich-UI policy the gateway enforces. */
export interface GatewayPolicy {
	allowedUserIds: ReadonlySet<string>;
	allowedChatIds: ReadonlySet<string>;
	presets: ReadonlyMap<string, GatewayPreset>;
	/** When false, `/stop` is refused as disabled (no `reports` mutation). */
	enableStop: boolean;
	/** How long a `/stop` arm (text or button) stays valid before re-confirmation. */
	confirmTtlMs?: number;
	/** Enable HTML formatting + inline keyboards. Default false (plain v0 baseline). */
	enableRichMessages?: boolean;
	/** TTL for observe/refresh/arm buttons. Default 600_000. */
	richCallbackTtlMs?: number;
	/** Max in-memory callback tokens. Default 500. */
	richCallbackMaxTokens?: number;
}

/** Runtime dependencies for the gateway. */
export interface GatewayDeps {
	coordinator: CoordinatorClient;
	/** Injectable clock for deterministic confirmation-expiry tests. */
	now?: () => number;
}

type CallbackContext = { chatId: string; userId: string | null };

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
	private readonly tokens: CallbackTokenStore;
	/** Pending text `/stop` confirmations keyed by `${chatId}:${sessionId}` → expiry ms. */
	private readonly pendingStops = new Map<string, number>();

	constructor(policy: GatewayPolicy, deps: GatewayDeps) {
		this.policy = policy;
		this.coordinator = deps.coordinator;
		this.now = deps.now ?? Date.now;
		this.tokens = new CallbackTokenStore({ now: this.now, maxTokens: policy.richCallbackMaxTokens });
	}

	/** Primary entry: handle a text message or an inline-keyboard callback. */
	async handleUpdate(update: IncomingUpdate): Promise<OutgoingReply> {
		if (update.kind === "callback_query") return this.handleCallback(update);
		if (!this.isAuthorized(update.userId, update.chatId)) return this.chat(MESSAGES.unauthorized);
		return this.dispatchText(update);
	}

	/** Text-only compatibility wrapper returning the reply text. */
	async handleMessage(message: IncomingMessage): Promise<string> {
		const reply = await this.handleUpdate(message);
		return reply.kind === "chat" ? reply.text : (reply.callbackAnswer.text ?? "");
	}

	private async dispatchText(message: IncomingTextMessage): Promise<ChatReply> {
		const ctx: CallbackContext = { chatId: message.chatId, userId: message.userId };
		const command = parseCommand(message.text);
		switch (command.kind) {
			case "help":
				return this.chat(MESSAGES.help);
			case "start":
				return this.chat(MESSAGES.start);
			case "sessions":
				return this.handleSessions(ctx);
			case "observe":
				return this.handleObserve(command.sessionId, ctx);
			case "start_session":
				return this.handleStartSession(command.presetId, command.task);
			case "stop":
				return this.handleStop(ctx, command.sessionId, command.confirm);
			default:
				return this.chat(MESSAGES.unknownCommand);
		}
	}

	private async handleSessions(ctx: CallbackContext): Promise<ChatReply> {
		const status = await this.coordinator.getCoordinationStatus();
		if (!status.ok) return this.chat(MESSAGES.backendOffline);
		if (!this.rich) return this.chat(renderSessionsList(projectSessionSummaries(status)));
		const rows = projectSessionRows(status);
		const reply: ChatReply = {
			kind: "chat",
			text: renderSessionsListHtml(rows.map(row => row.summary)),
			parseMode: "HTML",
		};
		const keyboard = this.sessionsKeyboard(rows, ctx);
		if (keyboard) reply.replyMarkup = keyboard;
		return reply;
	}

	private async handleObserve(sessionId: string | null, ctx: CallbackContext): Promise<ChatReply> {
		if (!sessionId) return this.chat(MESSAGES.observeUsage);
		const status = await this.coordinator.getCoordinationStatus();
		if (!status.ok) return this.chat(MESSAGES.backendOffline);
		const view = findSessionView(status, sessionId);
		if (!view) return this.chat(MESSAGES.unknownSession);
		return this.viewReply(view, sessionId, ctx);
	}

	private async handleStartSession(presetId: string | null, task: string | null): Promise<ChatReply> {
		if (!presetId) return this.chat(MESSAGES.startUsage);
		const resolution = resolvePreset(this.policy.presets, presetId, task);
		if (!resolution.ok) {
			return this.chat(resolution.reason === "unknown_preset" ? MESSAGES.unknownPreset : MESSAGES.taskTooLong);
		}
		const result = await this.coordinator.startSession({ cwd: resolution.preset.workdir, prompt: resolution.prompt });
		if (!result.ok) return this.chat(mapReason(result.reason));
		return this.chat(`Started ${result.sessionId ?? "session"} from preset ${resolution.preset.id}.`);
	}

	private async handleStop(ctx: CallbackContext, sessionId: string | null, confirm: boolean): Promise<ChatReply> {
		if (!sessionId) return this.chat(MESSAGES.stopUsage);
		if (!this.policy.enableStop) return this.chat(MESSAGES.sessionControlDisabled);

		const status = await this.coordinator.getCoordinationStatus();
		if (!status.ok) return this.chat(MESSAGES.backendOffline);
		const view = findSessionView(status, sessionId);
		if (!view) return this.chat(MESSAGES.unknownSession);
		// Fail closed: never record control for a dead/non-live session (it may have a different owner).
		if (view.status === "dead") return this.chat(MESSAGES.backendOffline);

		const key = `${ctx.chatId}:${sessionId}`;
		const now = this.now();
		if (confirm && this.isArmed(key, now)) {
			this.pendingStops.delete(key);
			return this.executeStop(sessionId, status, view);
		}

		this.pendingStops.set(key, now + this.confirmTtl);
		if (this.rich) {
			// Rich: show the capped/escaped display id and a Confirm button; the exact raw id stays
			// in the token + coordinator call, never echoed uncapped in chat.
			return {
				kind: "chat",
				text: `Confirm stop of <code>${escapeHtml(view.sessionId)}</code>?`,
				parseMode: "HTML",
				replyMarkup: this.stopConfirmKeyboard(sessionId, ctx),
			};
		}
		// Plain: the operator must type `/stop <id> confirm`, so echo the id they supplied.
		return { kind: "chat", text: `Confirm stop of ${sessionId}: send /stop ${sessionId} confirm` };
	}

	// --- Callback (inline-keyboard) handling ---

	private async handleCallback(update: IncomingCallbackQuery): Promise<OutgoingReply> {
		if (update.chatId === null) return this.answerOnly(MESSAGES.callbackInvalid);
		if (!this.isAuthorized(update.userId, update.chatId)) return this.answerOnly(MESSAGES.unauthorized, true);
		const resolution = this.tokens.resolve(update.data, { chatId: update.chatId, userId: update.userId });
		if (!resolution.ok) {
			return this.answerOnly(resolution.reason === "expired" ? MESSAGES.callbackExpired : MESSAGES.callbackInvalid);
		}
		const ctx: CallbackContext = { chatId: update.chatId, userId: update.userId };
		const { token, record } = resolution;
		switch (record.action) {
			case "observe":
				return this.callbackObserve(record, ctx, null);
			case "refresh_observe":
				return this.callbackObserve(record, ctx, update.messageId);
			case "stop_arm":
				return this.callbackStopArm(record, ctx);
			case "stop_confirm":
				return this.callbackStopConfirm(token, record);
			case "cancel":
				this.tokens.delete(token);
				// Revoke the paired confirmation so Cancel-then-Confirm cannot still mutate.
				this.tokens.revokeMatching("stop_confirm", record.chatId, record.sessionId);
				return this.answerOnly(MESSAGES.callbackCancelled);
		}
	}

	private async callbackObserve(
		record: CallbackTokenRecord,
		ctx: CallbackContext,
		editMessageId: string | number | null,
	): Promise<OutgoingReply> {
		const status = await this.coordinator.getCoordinationStatus();
		if (!status.ok) return this.answerOnly(MESSAGES.backendOffline);
		const view = findSessionView(status, record.sessionId);
		if (!view) return this.answerOnly(MESSAGES.unknownSession);
		const reply = this.viewReply(view, record.sessionId, ctx);
		reply.callbackAnswer = { text: MESSAGES.callbackDone };
		if (editMessageId !== null) reply.edit = { messageId: editMessageId };
		return reply;
	}

	private async callbackStopArm(record: CallbackTokenRecord, ctx: CallbackContext): Promise<OutgoingReply> {
		if (!this.policy.enableStop) return this.answerOnly(MESSAGES.sessionControlDisabled);
		const status = await this.coordinator.getCoordinationStatus();
		if (!status.ok) return this.answerOnly(MESSAGES.backendOffline);
		const view = findSessionView(status, record.sessionId);
		if (!view) return this.answerOnly(MESSAGES.unknownSession);
		if (view.status === "dead") return this.answerOnly(MESSAGES.backendOffline);
		const display = this.rich ? `<code>${escapeHtml(view.sessionId)}</code>` : view.sessionId;
		const reply: ChatReply = {
			kind: "chat",
			text: `Confirm stop of ${display}?`,
			replyMarkup: this.stopConfirmKeyboard(record.sessionId, ctx),
			callbackAnswer: { text: "Confirm?" },
		};
		if (this.rich) reply.parseMode = "HTML";
		return reply;
	}

	private async callbackStopConfirm(token: string, record: CallbackTokenRecord): Promise<OutgoingReply> {
		if (!this.policy.enableStop) return this.answerOnly(MESSAGES.sessionControlDisabled);
		const status = await this.coordinator.getCoordinationStatus();
		if (!status.ok) return this.answerOnly(MESSAGES.backendOffline);
		const view = findSessionView(status, record.sessionId);
		if (!view) return this.answerOnly(MESSAGES.unknownSession);
		if (view.status === "dead") return this.answerOnly(MESSAGES.backendOffline);
		// Single-use: consume before the call so a replay cannot double-mutate.
		this.tokens.markUsed(token);
		const result = await this.executeStop(record.sessionId, status, view);
		return { ...result, callbackAnswer: { text: MESSAGES.callbackDone } };
	}

	/** Shared terminal-stop call used by text confirm and button confirm. */
	private async executeStop(sessionId: string, status: CoordinationStatus, view: SessionView): Promise<ChatReply> {
		const turnId = activeTurnId(status, sessionId) ?? undefined;
		const result = await this.coordinator.reportStatus({
			sessionId,
			turnId,
			status: "cancelled",
			summary: STOP_SUMMARY,
		});
		if (!result.ok) return this.chat(mapReason(result.reason));
		if (this.rich) {
			return {
				kind: "chat",
				text: `Stop requested for <code>${escapeHtml(view.sessionId)}</code>.`,
				parseMode: "HTML",
			};
		}
		return this.chat(`Stop requested for ${sessionId}.`);
	}

	// --- Rendering + keyboards ---

	private viewReply(view: SessionView, rawSessionId: string, ctx: CallbackContext): ChatReply {
		if (!this.rich) return this.chat(renderSessionView(view, this.now()));
		return {
			kind: "chat",
			text: renderSessionViewHtml(view, this.now()),
			parseMode: "HTML",
			replyMarkup: this.observeKeyboard(rawSessionId, ctx),
		};
	}

	private sessionsKeyboard(
		rows: Array<{ rawSessionId: string; summary: { name: string } }>,
		ctx: CallbackContext,
	): TelegramInlineKeyboardMarkup | undefined {
		if (rows.length === 0) return undefined;
		const keyboard = rows.map(({ rawSessionId, summary }) => {
			const name = summary.name.slice(0, BUTTON_NAME_MAX);
			const row: TelegramInlineKeyboardButton[] = [
				{ text: `Observe ${name}`, callbackData: this.issue("observe", rawSessionId, ctx, this.richTtl) },
			];
			if (this.policy.enableStop) {
				row.push({ text: `Stop ${name}`, callbackData: this.issue("stop_arm", rawSessionId, ctx, this.richTtl) });
			}
			return row;
		});
		return { inline_keyboard: keyboard };
	}

	private observeKeyboard(rawSessionId: string, ctx: CallbackContext): TelegramInlineKeyboardMarkup {
		const row: TelegramInlineKeyboardButton[] = [
			{ text: "Refresh", callbackData: this.issue("refresh_observe", rawSessionId, ctx, this.richTtl) },
		];
		if (this.policy.enableStop) {
			row.push({ text: "Stop", callbackData: this.issue("stop_arm", rawSessionId, ctx, this.richTtl) });
		}
		return { inline_keyboard: [row] };
	}

	private stopConfirmKeyboard(rawSessionId: string, ctx: CallbackContext): TelegramInlineKeyboardMarkup {
		return {
			inline_keyboard: [
				[
					{ text: "Confirm stop", callbackData: this.issue("stop_confirm", rawSessionId, ctx, this.confirmTtl) },
					{ text: "Cancel", callbackData: this.issue("cancel", rawSessionId, ctx, this.confirmTtl) },
				],
			],
		};
	}

	private issue(
		action: CallbackTokenRecord["action"],
		sessionId: string,
		ctx: CallbackContext,
		ttlMs: number,
	): string {
		return this.tokens.issue({ action, sessionId, chatId: ctx.chatId, userId: ctx.userId, ttlMs });
	}

	// --- Helpers ---

	private get rich(): boolean {
		return this.policy.enableRichMessages ?? false;
	}

	private get confirmTtl(): number {
		return this.policy.confirmTtlMs ?? DEFAULT_CONFIRM_TTL_MS;
	}

	private get richTtl(): number {
		return this.policy.richCallbackTtlMs ?? DEFAULT_RICH_TTL_MS;
	}

	private chat(text: string): ChatReply {
		return { kind: "chat", text };
	}

	private answerOnly(text: string, showAlert?: boolean): CallbackAnswerOnlyReply {
		return {
			kind: "callback_answer",
			callbackAnswer: showAlert ? { text, showAlert: true } : { text },
			sendMessage: false,
		};
	}

	private isAuthorized(userId: string | null, chatId: string): boolean {
		if (userId !== null && this.policy.allowedUserIds.has(userId)) return true;
		return this.policy.allowedChatIds.has(chatId);
	}

	private isArmed(key: string, now: number): boolean {
		const expiry = this.pendingStops.get(key);
		return expiry !== undefined && expiry > now;
	}
}

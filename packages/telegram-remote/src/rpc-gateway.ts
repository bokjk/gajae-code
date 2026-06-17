import { parseCommand } from "./commands";
import { MESSAGES } from "./messages";
import type { RpcAttachmentStore } from "./rpc-attachment-store";
import { type RpcControlSignal, RpcControlStateMachine } from "./rpc-control-state";
import { RpcEventBridge } from "./rpc-event-bridge";
import {
	clearPendingAction,
	renderRpcLiveCard,
	renderRpcOnboarding,
	safeCallbackAnswer,
	upsertPendingAction,
} from "./rpc-safe-projection";
import { extensionUiResponseFromToken, RpcUiBridge } from "./rpc-ui-bridge";

import { CallbackTokenStore } from "./tokens";
import type {
	AttachmentRecord,
	ChatReply,
	IncomingMessage,
	IncomingUpdate,
	OutgoingReply,
	PendingActionSummary,
	RpcBackendPort,
	TelegramTransport,
} from "./types";

export interface RpcGatewayPolicy {
	allowedUserIds: ReadonlySet<string>;
	allowedChatIds: ReadonlySet<string>;
	defaultSocketPath: string;
	allowAttachSocketArg: boolean;
}

export interface RpcGatewayDeps {
	backend: RpcBackendPort;
	attachments: RpcAttachmentStore;
	now?: () => number;
	tokens?: CallbackTokenStore;
	rpcUiTtlMs?: number;
	outbound?: Pick<TelegramTransport, "send">;
	livenessMs?: number;
}

export class TelegramRpcGateway {
	readonly #policy: RpcGatewayPolicy;
	readonly #backend: RpcBackendPort;
	readonly #attachments: RpcAttachmentStore;
	readonly #now: () => number;
	readonly #control: RpcControlStateMachine;
	#lastControlSignal: RpcControlSignal | null = null;
	#pendingSteerText: string | null = null;
	#pendingSteerTextId: string | null = null;
	readonly #tokens: CallbackTokenStore;
	readonly #rpcUiTtlMs: number;
	#uiBridge: RpcUiBridge | null = null;
	#eventBridge: RpcEventBridge | null = null;
	readonly #outbound?: Pick<TelegramTransport, "send">;
	readonly #livenessMs: number;

	constructor(policy: RpcGatewayPolicy, deps: RpcGatewayDeps) {
		this.#policy = policy;
		this.#backend = deps.backend;
		this.#attachments = deps.attachments;
		this.#now = deps.now ?? Date.now;
		this.#tokens = deps.tokens ?? new CallbackTokenStore({ now: this.#now });
		this.#rpcUiTtlMs = deps.rpcUiTtlMs ?? 5 * 60 * 1000;
		this.#outbound = deps.outbound;
		this.#livenessMs = deps.livenessMs ?? 60_000;
		this.#control = new RpcControlStateMachine({
			backend: this.#backend,
			onSignal: signal => {
				if (signal.kind === "reconnect_required") {
					console.warn("gtr_rpc_gateway_reconnect", { reason: signal.reason, queued: signal.queuedInputs });
				}
				if (signal.kind === "reconnect_required" || this.#lastControlSignal?.kind !== "reconnect_required") {
					this.#lastControlSignal = signal;
				}
			},
		});
		this.#backend.onEvents?.(event => {
			this.#control.handleEvent(event);
			if (this.isControlIdleEvent(event)) this.#pendingSteerText = null;
		});
		this.#backend.onTransportError?.(() => this.#control.transportError());
		this.#backend.onCommandIgnored?.(() => this.#control.controllerStolen());
	}

	async restorePersistedAttachment(): Promise<void> {
		const attachment = this.#attachments.get();
		if (!attachment || attachment.stale) return;
		if (!this.isAuthorized(attachment.userId, attachment.chatId)) return;
		await this.#backend.connect(attachment.socketPath);
		this.#uiBridge?.stop();
		this.#eventBridge?.stop();
		this.#uiBridge = this.createUiBridge(attachment);
		this.#uiBridge.start();
		this.#eventBridge = this.createEventBridge(attachment);
		this.#eventBridge.start();
		await this.#uiBridge.replayPendingWorkflowGates();
		await this.#eventBridge.resync();
		await this.updateAttachmentState();
	}

	async handleUpdate(update: IncomingUpdate): Promise<OutgoingReply> {
		if (update.kind === "callback_query") return this.dispatchCallback(update);
		if (!this.isAuthorized(update.userId, update.chatId)) return this.chat(MESSAGES.unauthorized);
		return this.dispatchText(update);
	}

	private async dispatchText(message: IncomingMessage): Promise<ChatReply> {
		const command = parseCommand(message.text);
		switch (command.kind) {
			case "help":
			case "start":
				return this.html(renderRpcOnboarding());

			case "attach":
				return this.attach(message, command.socketPath);
			case "detach":
				this.#eventBridge?.stop();
				this.#eventBridge = null;
				this.#uiBridge?.stop();
				this.#uiBridge = null;
				await this.#attachments.clear();
				return this.chat("Detached. Session keeps running.");

			case "status":
				return this.status();
			case "abort":
				return this.abort();
			case "sessions":
			case "observe":
			case "presets":
			case "start_session":
			case "stop":
				return this.chat(MESSAGES.unknownCommand);
			default:
				if (message.text.trim().length === 0) return this.chat(MESSAGES.unknownCommand);
				return this.submitText(message.text);
		}
	}

	private async attach(message: IncomingMessage, requestedSocketPath: string | null): Promise<ChatReply> {
		const socketPath =
			this.#policy.allowAttachSocketArg && requestedSocketPath
				? requestedSocketPath
				: this.#policy.defaultSocketPath;
		const attachment: AttachmentRecord = {
			chatId: message.chatId,
			userId: message.userId,
			socketPath,
			stale: false,
			controllerState: "connecting",
			pendingGateIds: [],
			deliveryIdentities: [],
			updatedAt: this.#now(),
		};
		await this.#attachments.set(attachment);
		await this.clearAllPendingActions();

		this.#uiBridge?.stop();
		this.#eventBridge?.stop();
		this.#uiBridge = this.createUiBridge(attachment);
		this.#uiBridge.start();
		this.#eventBridge = this.createEventBridge(attachment);
		this.#eventBridge.start();
		await this.#control.attach();
		await this.#uiBridge.replayPendingWorkflowGates();
		const updated = { ...attachment, controllerState: this.#control.state, updatedAt: this.#now() };
		await this.#attachments.set(updated);
		return this.liveCardReply(updated);
	}

	private async status(editMessageId?: string | number | null): Promise<ChatReply> {
		const attachment = this.#attachments.get();
		if (!attachment) return this.html(renderRpcLiveCard({ attachment: null, now: this.#now() }).text);
		await this.updateAttachmentState();
		return this.liveCardReply(this.#attachments.get() ?? attachment, editMessageId ?? undefined);
	}

	private async submitText(text: string): Promise<ChatReply> {
		const attachment = this.#attachments.get();
		if (!attachment) return this.chat("Attach first with /attach.");
		if (this.#control.state !== "reconnecting") await this.#control.refreshFromBackend().catch(() => undefined);
		const textResponse = this.#uiBridge?.consumeTextResponse({
			chatId: attachment.chatId,
			userId: attachment.userId,
			text,
		});
		if (textResponse === "sent") {
			return this.chat("Sent.");
		}
		if (textResponse === "failed") {
			return this.chat("Couldn't deliver your response — not connected; try again.");
		}
		const routesToSteer = this.#control.state === "attached_turn_active" || this.#control.state === "waiting_for_ui";
		if (routesToSteer) {
			this.setPendingSteerText(text, attachment);
		} else {
			this.clearPendingSteerText(attachment);
			await this.#control.submitText(text);
		}
		await this.updateAttachmentState();
		return this.reconnectReplyIfNeeded()
			? this.chat(this.reconnectReplyIfNeeded()!)
			: routesToSteer
				? this.chat("Choose how to apply this input.", {
						inline_keyboard: [
							[
								{ text: "Steer current turn", callbackData: this.issueRpcToken("steer_held", attachment) },
								{ text: "Cancel and redirect", callbackData: this.issueRpcToken("cancel_steer", attachment) },
							],
							[{ text: "Dismiss", callbackData: this.issueRpcToken("dismiss_card", attachment) }],
						],
					})
				: this.chat("Queued.");
	}

	private async abort(): Promise<ChatReply> {
		const attachment = this.#attachments.get();
		if (!attachment) return this.chat("Attach first with /attach.");
		this.clearPendingSteerText(attachment);
		await this.#control.abort();
		await this.updateAttachmentState();
		return this.chat(this.reconnectReplyIfNeeded() ?? "Abort requested.");
	}

	private async dispatchCallback(update: Extract<IncomingUpdate, { kind: "callback_query" }>): Promise<OutgoingReply> {
		if (!update.chatId || !this.isAuthorized(update.userId, update.chatId)) {
			return { kind: "callback_answer", callbackAnswer: { text: MESSAGES.unauthorized }, sendMessage: false };
		}
		const tokenResolution = this.#tokens.resolve(update.data, { chatId: update.chatId, userId: update.userId });
		if (!tokenResolution.ok) {
			return { kind: "callback_answer", callbackAnswer: { text: MESSAGES.callbackInvalid }, sendMessage: false };
		}
		const record = tokenResolution.record;
		if (record.action === "live_refresh" || record.action === "live_status") {
			const attachment = this.#attachments.get();
			if (!attachment || attachment.stale) return this.callbackOnly("This card is stale. Send /status.");
			await this.updateAttachmentState();
			const latest = this.#attachments.get() ?? attachment;
			const projected = await this.projectLiveCard(latest);
			if (record.action === "live_refresh" && latest.liveCardFingerprint === projected.fingerprint) {
				return this.callbackOnly("Up to date.");
			}
			return this.liveCardReply(latest, update.messageId ?? undefined, { text: safeCallbackAnswer("Updated.") });
		}
		if (record.action === "live_help") {
			return {
				kind: "chat",
				text: renderRpcOnboarding(),
				parseMode: "HTML",
				edit: update.messageId === null ? undefined : { messageId: update.messageId },
				callbackAnswer: { text: "Help." },
			};
		}
		if (record.action === "live_detach") {
			this.#tokens.markUsed(tokenResolution.token);
			this.#eventBridge?.stop();
			this.#eventBridge = null;
			this.#uiBridge?.stop();
			this.#uiBridge = null;
			await this.#attachments.clear();
			await this.clearAllPendingActions();

			return this.callbackOnly("Detached. Session keeps running.");
		}
		if (record.action === "dismiss_card") {
			this.#tokens.markUsed(tokenResolution.token);
			return this.callbackOnly("Dismissed.");
		}

		if (record.action === "abort") {
			this.#tokens.markUsed(tokenResolution.token);
			this.clearPendingSteerText(this.#attachments.get());
			await this.#control.abort();
			await this.updateAttachmentState();
			return { kind: "callback_answer", callbackAnswer: { text: "Abort requested." }, sendMessage: false };
		}
		if (record.action === "steer_held" || record.action === "cancel_steer") {
			const text = this.#pendingSteerText;
			if (!text || record.heldTextId !== this.#pendingSteerTextId) {
				return { kind: "callback_answer", callbackAnswer: { text: MESSAGES.callbackInvalid }, sendMessage: false };
			}
			this.#tokens.markUsed(tokenResolution.token);
			this.clearPendingSteerText(this.#attachments.get());
			if (record.action === "steer_held") {
				await this.#control.submitText(text);
				await this.updateAttachmentState();
				return { kind: "callback_answer", callbackAnswer: { text: "Steer queued." }, sendMessage: false };
			}
			await this.#control.abortAndPrompt(text);
			await this.updateAttachmentState();
			return { kind: "callback_answer", callbackAnswer: { text: "Redirect queued." }, sendMessage: false };
		}
		if (record.action === "ui_select" || record.action === "ui_confirm") {
			const sent = await this.respondExtensionUi(extensionUiResponseFromToken(record));
			if (!sent) return this.callbackRejected();
			this.#tokens.markUsed(tokenResolution.token);
			if (record.dedupeKey) await this.clearPendingAction(record.dedupeKey);
			return { kind: "callback_answer", callbackAnswer: { text: "Sent." }, sendMessage: false };
		}
		if (record.action === "gate_answer") {
			const accepted = await this.respondGate(record.gateId, record.answer, record.idempotencyKey);
			if (!accepted) return this.callbackRejected();
			this.#tokens.markUsed(tokenResolution.token);
			if (record.dedupeKey) await this.clearPendingAction(record.dedupeKey);
			return { kind: "callback_answer", callbackAnswer: { text: MESSAGES.callbackDone }, sendMessage: false };
		}
		return { kind: "callback_answer", callbackAnswer: { text: MESSAGES.callbackInvalid }, sendMessage: false };
	}

	private issueRpcToken(
		action:
			| "steer_held"
			| "cancel_steer"
			| "abort"
			| "live_refresh"
			| "live_status"
			| "live_help"
			| "live_detach"
			| "dismiss_card",
		attachment: AttachmentRecord,
	): string {
		const base = { chatId: attachment.chatId, userId: attachment.userId, ttlMs: this.#rpcUiTtlMs };
		if (
			action === "abort" ||
			action === "live_refresh" ||
			action === "live_status" ||
			action === "live_help" ||
			action === "live_detach" ||
			action === "dismiss_card"
		) {
			return this.#tokens.issue({ ...base, action });
		}
		return this.#tokens.issue({ ...base, action, heldTextId: this.#pendingSteerTextId ?? "" });
	}

	private setPendingSteerText(text: string, attachment: AttachmentRecord): void {
		const oldHeldTextId = this.#pendingSteerTextId;
		this.#pendingSteerText = text;
		this.#pendingSteerTextId = `held:${this.#now()}:${Math.random().toString(36).slice(2)}`;
		if (oldHeldTextId) {
			this.#tokens.revokeMatching({ action: "steer_held", chatId: attachment.chatId, heldTextId: oldHeldTextId });
			this.#tokens.revokeMatching({ action: "cancel_steer", chatId: attachment.chatId, heldTextId: oldHeldTextId });
		}
	}

	private clearPendingSteerText(attachment: AttachmentRecord | null): void {
		const heldTextId = this.#pendingSteerTextId;
		this.#pendingSteerText = null;
		this.#pendingSteerTextId = null;
		if (attachment && heldTextId) {
			this.#tokens.revokeMatching({ action: "steer_held", chatId: attachment.chatId, heldTextId });
			this.#tokens.revokeMatching({ action: "cancel_steer", chatId: attachment.chatId, heldTextId });
		}
	}

	private createUiBridge(attachment: AttachmentRecord): RpcUiBridge {
		return new RpcUiBridge({
			backend: this.#backend,
			tokens: this.#tokens,
			binding: { chatId: attachment.chatId, userId: attachment.userId },
			now: this.#now,
			ttlMs: this.#rpcUiTtlMs,
			onMessage: async reply => {
				await this.#outbound?.send?.({ chatId: attachment.chatId, reply });
			},
			onPendingAction: summary => this.upsertPendingAction(summary),
			onClearPendingAction: dedupeKey => this.clearPendingAction(dedupeKey),
			isPendingActionActive: dedupeKey =>
				this.#attachments
					.get()
					?.pendingActions?.some(action => action.dedupeKey === dedupeKey && action.status === "pending") === true,
		});
	}

	private createEventBridge(attachment: AttachmentRecord): RpcEventBridge {
		return new RpcEventBridge({
			backend: this.#backend,
			attachments: this.#attachments,
			binding: { chatId: attachment.chatId, userId: attachment.userId },
			outbound: this.#outbound?.send ? { send: message => this.#outbound!.send!(message) } : undefined,
			now: this.#now,
			livenessMs: this.#livenessMs,
			onLiveCardUpdate: () => this.sendLiveCardUpdate(),
		});
	}

	private async respondExtensionUi(response: unknown): Promise<boolean> {
		try {
			// RpcClient.respondExtensionUi only writes an extension_ui_response frame;
			// the protocol has no ack for select/confirm/input, so success here means sent, not accepted.
			this.#backend.respondExtensionUi?.(response);
			return true;
		} catch {
			return false;
		}
	}

	private async respondGate(gateId: string, answer: unknown, idempotencyKey: string): Promise<boolean> {
		try {
			const result = await this.#backend.respondGate?.(gateId, answer, idempotencyKey);
			return responseAccepted(result);
		} catch {
			return false;
		}
	}

	private callbackRejected(): OutgoingReply {
		return { kind: "callback_answer", callbackAnswer: { text: "Request was rejected." }, sendMessage: false };
	}

	private async updateAttachmentState(): Promise<void> {
		const attachment = this.#attachments.get();
		if (!attachment) return;
		const state =
			this.#control.state === "attached_turn_active" && this.#control.hasPendingWork
				? "control_pending_abort_and_prompt"
				: this.#control.state;
		await this.#attachments.set({ ...attachment, controllerState: state, updatedAt: this.#now() });
	}

	private async upsertPendingAction(summary: PendingActionSummary): Promise<void> {
		const attachment = this.#attachments.get();
		if (!attachment || attachment.stale) return;
		await this.#attachments.set({
			...attachment,
			pendingActions: upsertPendingAction(attachment.pendingActions, summary),
			updatedAt: this.#now(),
		});
	}

	private async clearPendingAction(dedupeKey: string): Promise<void> {
		const attachment = this.#attachments.get();
		if (!attachment) return;
		await this.#attachments.set({
			...attachment,
			pendingActions: clearPendingAction(attachment.pendingActions, dedupeKey),
			updatedAt: this.#now(),
		});
	}

	private async clearAllPendingActions(): Promise<void> {
		const attachment = this.#attachments.get();
		if (!attachment) return;
		await this.#attachments.set({ ...attachment, pendingActions: [], updatedAt: this.#now() });
	}

	private isControlIdleEvent(event: { type: string; [key: string]: unknown }): boolean {
		return (
			event.type === "turn_end" ||
			event.type === "agent_end" ||
			event.type === "turn_cancelled" ||
			event.type === "agent_cancelled"
		);
	}

	private isAuthorized(userId: string | null, chatId: string): boolean {
		return (userId !== null && this.#policy.allowedUserIds.has(userId)) || this.#policy.allowedChatIds.has(chatId);
	}

	private chat(text: string, replyMarkup?: ChatReply["replyMarkup"]): ChatReply {
		return replyMarkup ? { kind: "chat", text, replyMarkup } : { kind: "chat", text };
	}

	private html(text: string, replyMarkup?: ChatReply["replyMarkup"]): ChatReply {
		return replyMarkup
			? { kind: "chat", text, parseMode: "HTML", replyMarkup }
			: { kind: "chat", text, parseMode: "HTML" };
	}

	private callbackOnly(text: string): OutgoingReply {
		return { kind: "callback_answer", callbackAnswer: { text: safeCallbackAnswer(text) }, sendMessage: false };
	}

	private async projectLiveCard(attachment: AttachmentRecord | null) {
		const backendState = await this.#backend.getState().catch(() => undefined);
		return renderRpcLiveCard({ attachment, backendState, now: this.#now() });
	}

	private async liveCardReply(
		attachment: AttachmentRecord,
		editMessageId?: string | number,
		callbackAnswer?: ChatReply["callbackAnswer"],
	): Promise<ChatReply> {
		const projected = await this.projectLiveCard(attachment);
		const replyMarkup = this.liveCardButtons(attachment);
		const fingerprint = projected.fingerprint;
		const targetMessageId = editMessageId ?? attachment.liveCardMessageId;
		return {
			kind: "chat",
			text: projected.text,
			parseMode: "HTML",
			replyMarkup,
			...(targetMessageId !== undefined ? { edit: { messageId: targetMessageId } } : {}),
			...(callbackAnswer ? { callbackAnswer } : {}),
			onDelivered: result => {
				if (result.ok && result.messageId !== undefined) {
					return this.persistLiveCardDelivery(fingerprint, result.messageId);
				}
			},
		};
	}

	private async sendLiveCardUpdate(): Promise<void> {
		const attachment = this.#attachments.get();
		if (!attachment || attachment.stale || !this.#outbound?.send) return;
		const reply = await this.liveCardReply(attachment, attachment.liveCardMessageId);
		const result = await this.#outbound.send({ chatId: attachment.chatId, reply });
		await reply.onDelivered?.(result);
	}

	private liveCardButtons(attachment: AttachmentRecord): ChatReply["replyMarkup"] {
		return {
			inline_keyboard: [
				[
					{ text: "Refresh", callbackData: this.issueRpcToken("live_refresh", attachment) },
					{ text: "Status", callbackData: this.issueRpcToken("live_status", attachment) },
					{ text: "Help", callbackData: this.issueRpcToken("live_help", attachment) },
				],
				[
					{ text: "Detach", callbackData: this.issueRpcToken("live_detach", attachment) },
					{ text: "Dismiss", callbackData: this.issueRpcToken("dismiss_card", attachment) },
				],
			],
		};
	}

	private async persistLiveCardDelivery(fingerprint: string, messageId: string | number): Promise<void> {
		const attachment = this.#attachments.get();
		if (!attachment || attachment.stale) return;
		await this.#attachments.set({
			...attachment,
			liveCardMessageId: messageId,
			liveCardFingerprint: fingerprint,
			liveCardUpdatedAt: this.#now(),
			updatedAt: this.#now(),
		});
	}

	private reconnectReplyIfNeeded(): string | null {
		return this.#lastControlSignal?.kind === "reconnect_required" || this.#control.state === "reconnecting"
			? "Reconnecting to RPC session; input is queued."
			: null;
	}
}

function responseAccepted(result: unknown): boolean {
	if (result === undefined) return true;
	if (typeof result !== "object" || result === null) return true;
	if ("accepted" in result && (result as { accepted?: unknown }).accepted === false) return false;
	if ("ok" in result && (result as { ok?: unknown }).ok === false) return false;
	if ("status" in result) {
		const status = (result as { status?: unknown }).status;
		if (status === "rejected" || status === "conflict" || status === "error") return false;
	}
	return true;
}

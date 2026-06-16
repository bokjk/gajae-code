import { parseCommand } from "./commands";
import { MESSAGES } from "./messages";
import type { RpcAttachmentStore } from "./rpc-attachment-store";
import { type RpcControlSignal, RpcControlStateMachine } from "./rpc-control-state";
import type {
	AttachmentRecord,
	ChatReply,
	IncomingMessage,
	IncomingUpdate,
	OutgoingReply,
	RpcBackendPort,
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
}

export class TelegramRpcGateway {
	readonly #policy: RpcGatewayPolicy;
	readonly #backend: RpcBackendPort;
	readonly #attachments: RpcAttachmentStore;
	readonly #now: () => number;
	readonly #control: RpcControlStateMachine;
	#lastControlSignal: RpcControlSignal | null = null;
	#pendingSteerText: string | null = null;

	constructor(policy: RpcGatewayPolicy, deps: RpcGatewayDeps) {
		this.#policy = policy;
		this.#backend = deps.backend;
		this.#attachments = deps.attachments;
		this.#now = deps.now ?? Date.now;
		this.#control = new RpcControlStateMachine({
			backend: this.#backend,
			onSignal: signal => {
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
				return this.chat("Commands: /attach, /detach, /status, /abort");
			case "attach":
				return this.attach(message, command.socketPath);
			case "detach":
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
		await this.#control.attach();
		await this.#attachments.set({ ...attachment, controllerState: this.#control.state, updatedAt: this.#now() });
		return this.chat("Attached to RPC session.");
	}

	private async status(): Promise<ChatReply> {
		const attachment = this.#attachments.get();
		if (!attachment) return this.chat("Detached.");
		const state = await this.#backend.getState();
		return this.chat(state.connected ? "Attached." : "Attachment is stale.");
	}

	private async submitText(text: string): Promise<ChatReply> {
		const attachment = this.#attachments.get();
		if (!attachment) return this.chat("Attach first with /attach.");
		if (this.#control.state !== "reconnecting") await this.#control.refreshFromBackend().catch(() => undefined);
		const routesToSteer = this.#control.state === "attached_turn_active" || this.#control.state === "waiting_for_ui";
		if (routesToSteer) {
			this.#pendingSteerText = text;
		} else {
			this.#pendingSteerText = null;
			await this.#control.submitText(text);
		}
		await this.updateAttachmentState();
		return this.reconnectReplyIfNeeded()
			? this.chat(this.reconnectReplyIfNeeded()!)
			: routesToSteer
				? this.chat("Choose how to apply this input.", {
						inline_keyboard: [
							[
								{ text: "Steer", callbackData: "gtr:v1:steer-held" },
								{ text: "Cancel & steer", callbackData: "gtr:v1:cancel-steer" },
							],
						],
					})
				: this.chat("Queued.");
	}

	private async abort(): Promise<ChatReply> {
		const attachment = this.#attachments.get();
		if (!attachment) return this.chat("Attach first with /attach.");
		this.#pendingSteerText = null;
		await this.#control.abort();
		await this.updateAttachmentState();
		return this.chat(this.reconnectReplyIfNeeded() ?? "Abort requested.");
	}

	private async dispatchCallback(update: Extract<IncomingUpdate, { kind: "callback_query" }>): Promise<OutgoingReply> {
		if (!update.chatId || !this.isAuthorized(update.userId, update.chatId)) {
			return { kind: "callback_answer", callbackAnswer: { text: MESSAGES.unauthorized }, sendMessage: false };
		}
		if (update.data === "gtr:v1:abort") {
			this.#pendingSteerText = null;
			await this.#control.abort();
			await this.updateAttachmentState();
			return { kind: "callback_answer", callbackAnswer: { text: "Abort requested." }, sendMessage: false };
		}
		if (update.data === "gtr:v1:steer-held" || update.data === "gtr:v1:cancel-steer") {
			const text = this.#pendingSteerText;
			if (!text) {
				return { kind: "callback_answer", callbackAnswer: { text: MESSAGES.callbackInvalid }, sendMessage: false };
			}
			this.#pendingSteerText = null;
			if (update.data === "gtr:v1:steer-held") {
				await this.#control.submitText(text);
				await this.updateAttachmentState();
				return { kind: "callback_answer", callbackAnswer: { text: "Steer queued." }, sendMessage: false };
			}
			await this.#control.abortAndPrompt(text);
			await this.updateAttachmentState();
			return { kind: "callback_answer", callbackAnswer: { text: "Cancel & steer queued." }, sendMessage: false };
		}
		return { kind: "callback_answer", callbackAnswer: { text: MESSAGES.callbackInvalid }, sendMessage: false };
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

	private reconnectReplyIfNeeded(): string | null {
		return this.#lastControlSignal?.kind === "reconnect_required" || this.#control.state === "reconnecting"
			? "Reconnecting to RPC session; input is queued."
			: null;
	}
}

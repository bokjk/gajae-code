import { createHash } from "node:crypto";
import type {
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcWorkflowGate,
	RpcWorkflowGateOption,
} from "@gajae-code/coding-agent/modes/rpc/rpc-types";
import { projectExtensionUiRequest, projectWorkflowGate, safeRpcLine } from "./rpc-safe-projection";
import type { CallbackTokenStore } from "./tokens";
import type { ChatReply, PendingActionSummary, RpcBackendPort, TelegramInlineKeyboardButton } from "./types";

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const TEXT_MAX_LEN = 4000;

export interface RpcUiBridgeBinding {
	chatId: string;
	userId: string | null;
}

export interface RpcUiBridgeOptions {
	backend: RpcBackendPort;
	tokens: CallbackTokenStore;
	binding: RpcUiBridgeBinding;
	now?: () => number;
	ttlMs?: number;
	onMessage?: (reply: ChatReply) => void | Promise<void>;
	onPendingAction?: (summary: PendingActionSummary) => void | Promise<void>;
	onClearPendingAction?: (dedupeKey: string) => void | Promise<void>;
	isPendingActionActive?: (dedupeKey: string) => boolean;
}

interface PendingTextResponse {
	requestId: string;
	chatId: string;
	userId: string | null;
	expiresAt: number;
	method: "input" | "editor";
	dedupeKey: string;
}

export class RpcUiBridge {
	readonly #backend: RpcBackendPort;
	readonly #tokens: CallbackTokenStore;
	readonly #binding: RpcUiBridgeBinding;
	readonly #now: () => number;
	readonly #ttlMs: number;
	readonly #onMessage?: (reply: ChatReply) => void | Promise<void>;
	readonly #onPendingAction?: (summary: PendingActionSummary) => void | Promise<void>;
	readonly #onClearPendingAction?: (dedupeKey: string) => void | Promise<void>;
	readonly #isPendingActionActive?: (dedupeKey: string) => boolean;
	readonly #pendingText = new Map<string, PendingTextResponse>();
	#unsubscribeUi: (() => void) | null = null;
	#unsubscribeGate: (() => void) | null = null;

	constructor(options: RpcUiBridgeOptions) {
		this.#backend = options.backend;
		this.#tokens = options.tokens;
		this.#binding = options.binding;
		this.#now = options.now ?? Date.now;
		this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
		this.#onMessage = options.onMessage;
		this.#onPendingAction = options.onPendingAction;
		this.#onClearPendingAction = options.onClearPendingAction;
		this.#isPendingActionActive = options.isPendingActionActive;
	}

	start(): void {
		this.#unsubscribeUi =
			this.#backend.onExtensionUiRequest?.(request => {
				void this.handleExtensionUiRequest(request as RpcExtensionUIRequest);
			}) ?? null;
		this.#unsubscribeGate =
			this.#backend.onWorkflowGate?.(gate => {
				void this.renderWorkflowGate(gate as RpcWorkflowGate);
			}) ?? null;
	}

	stop(): void {
		this.#unsubscribeUi?.();
		this.#unsubscribeGate?.();
		this.#unsubscribeUi = null;
		this.#unsubscribeGate = null;
		for (const pending of this.#pendingText.values()) void this.#onClearPendingAction?.(pending.dedupeKey);
		this.#pendingText.clear();
	}

	async replayPendingWorkflowGates(): Promise<void> {
		const gates = (await this.#backend.getPendingWorkflowGates?.()) as RpcWorkflowGate[] | undefined;
		for (const gate of gates ?? []) await this.renderWorkflowGate(gate);
	}

	async handleExtensionUiRequest(request: RpcExtensionUIRequest): Promise<ChatReply | null> {
		switch (request.method) {
			case "select":
				return this.#renderSelect(request);
			case "confirm":
				return this.#renderConfirm(request);
			case "input":
			case "editor":
				return this.#renderTextPrompt(request);
			case "open_url":
				this.#backend.respondExtensionUi?.({ type: "extension_ui_response", id: request.id, cancelled: true });
				return null;
			case "cancel": {
				const pending = this.#pendingText.get(request.targetId);
				this.#pendingText.delete(request.targetId);
				if (pending) void this.#onClearPendingAction?.(pending.dedupeKey);
				return null;
			}
			case "notify":
			case "setStatus":
			case "setWidget":
			case "setTitle":
			case "set_editor_text":
				return null;
		}
	}

	async renderWorkflowGate(gate: RpcWorkflowGate): Promise<ChatReply> {
		const projected = projectWorkflowGate(gate, this.#now(), this.#ttlMs);
		const rows = projected.options.map(row => [
			this.#gateButton(gate, row.option, row.optionIndex, row.label, projected.summary.dedupeKey),
		]);
		return this.#emitAction(projected.summary, {
			kind: "chat",
			parseMode: "HTML",
			text: projected.text,
			replyMarkup: { inline_keyboard: rows },
		});
	}

	consumeTextResponse(input: { chatId: string; userId: string | null; text: string }): "sent" | "failed" | null {
		for (const [requestId, pending] of this.#pendingText) {
			if (pending.chatId !== input.chatId) continue;
			if (pending.userId !== null && pending.userId !== input.userId) continue;
			if (this.#now() >= pending.expiresAt) {
				this.#pendingText.delete(requestId);
				void this.#onClearPendingAction?.(pending.dedupeKey);
				continue;
			}
			// RpcClient.respondExtensionUi only writes an extension_ui_response frame; input/editor has no
			// protocol ack. Write FIRST and delete the pending request ONLY after a non-throwing write so a
			// failed write retains the pending request for retry instead of silently dropping the text.
			try {
				this.#backend.respondExtensionUi?.({
					type: "extension_ui_response",
					id: requestId,
					value: sanitizeValue(input.text, TEXT_MAX_LEN),
				});
			} catch {
				return "failed";
			}
			this.#pendingText.delete(requestId);
			void this.#onClearPendingAction?.(pending.dedupeKey);
			return "sent";
		}
		return null;
	}

	async #renderSelect(request: Extract<RpcExtensionUIRequest, { method: "select" }>): Promise<ChatReply> {
		const projected = projectExtensionUiRequest(request, this.#now(), this.#ttlMs);
		if (!projected?.summary) return this.#emit({ kind: "chat", parseMode: "HTML", text: "Choose an option." });
		const summary = projected.summary;

		const rows = request.options.map((option, index) => [
			this.#uiButton(projected.options?.[index] ?? safeRpcLine(option, 48, `Option ${index + 1}`), {
				action: "ui_select",
				requestId: request.id,
				value: option,
				optionIndex: index,
				dedupeKey: summary.dedupeKey,
			}),
		]);
		return this.#emitAction(summary, {
			kind: "chat",
			parseMode: "HTML",
			text: projected.text,
			replyMarkup: { inline_keyboard: rows },
		});
	}

	async #renderConfirm(request: Extract<RpcExtensionUIRequest, { method: "confirm" }>): Promise<ChatReply> {
		const projected = projectExtensionUiRequest(request, this.#now(), this.#ttlMs);
		if (!projected?.summary) return this.#emit({ kind: "chat", parseMode: "HTML", text: "Confirm action." });
		return this.#emitAction(projected.summary, {
			kind: "chat",
			parseMode: "HTML",
			text: projected.text,
			replyMarkup: {
				inline_keyboard: [
					[
						this.#uiButton("Yes", {
							action: "ui_confirm",
							requestId: request.id,
							confirmed: true,
							dedupeKey: projected.summary.dedupeKey,
						}),
						this.#uiButton("No", {
							action: "ui_confirm",
							requestId: request.id,
							confirmed: false,
							dedupeKey: projected.summary.dedupeKey,
						}),
					],
				],
			},
		});
	}

	async #renderTextPrompt(
		request: Extract<RpcExtensionUIRequest, { method: "input" | "editor" }>,
	): Promise<ChatReply> {
		const projected = projectExtensionUiRequest(request, this.#now(), this.#ttlMs);
		if (!projected?.summary)
			return this.#emit({ kind: "chat", parseMode: "HTML", text: "Send the answer as the next message." });
		this.#pendingText.set(request.id, {
			requestId: request.id,
			chatId: this.#binding.chatId,
			userId: this.#binding.userId,
			expiresAt: projected.summary.expiresAt,
			method: request.method,
			dedupeKey: projected.summary.dedupeKey,
		});
		return this.#emitAction(projected.summary, {
			kind: "chat",
			parseMode: "HTML",
			text: projected.text,
		});
	}

	#uiButton(
		text: string,
		payload:
			| { action: "ui_select"; requestId: string; value: string; optionIndex: number; dedupeKey: string }
			| { action: "ui_confirm"; requestId: string; confirmed: boolean; dedupeKey: string },
	): TelegramInlineKeyboardButton {
		return {
			text,
			callbackData: this.#tokens.issue({
				...payload,
				chatId: this.#binding.chatId,
				userId: this.#binding.userId,
				ttlMs: this.#ttlMs,
			}),
		};
	}

	#gateButton(
		gate: RpcWorkflowGate,
		option: RpcWorkflowGateOption,
		optionIndex: number,
		label: string,
		dedupeKey: string,
	): TelegramInlineKeyboardButton {
		const answer = option.value ?? option.label;
		const actionKey = `gate_answer:${gate.gate_id}:${optionIndex}:${hashValue(answer)}`;
		return {
			text: label,
			callbackData: this.#tokens.issue({
				action: "gate_answer",
				gateId: gate.gate_id,
				answer,
				optionIndex,
				idempotencyKey: deriveGateIdempotencyKey({ chatId: this.#binding.chatId, gateId: gate.gate_id, actionKey }),
				chatId: this.#binding.chatId,
				userId: this.#binding.userId,
				ttlMs: this.#ttlMs,
				dedupeKey,
			}),
		};
	}

	async #emit(reply: ChatReply): Promise<ChatReply> {
		await this.#onMessage?.(reply);
		return reply;
	}

	async #emitAction(summary: PendingActionSummary, reply: ChatReply): Promise<ChatReply> {
		const alreadyActive = this.#isPendingActionActive?.(summary.dedupeKey) === true;
		void this.#onPendingAction?.(summary);
		const nextReply: ChatReply = {
			...reply,
			onDelivered: result => {
				if (result.ok && result.messageId !== undefined) {
					void this.#onPendingAction?.({ ...summary, deliveredMessageId: result.messageId });
				}
			},
		};
		if (!alreadyActive) await this.#onMessage?.(nextReply);
		return nextReply;
	}
}

export function extensionUiResponseFromToken(
	record:
		| { action: "ui_select"; requestId: string; value: string }
		| { action: "ui_confirm"; requestId: string; confirmed: boolean },
): RpcExtensionUIResponse {
	// Select/confirm callbacks share the extension_ui fire-and-forget contract; the gateway can only report "Sent."
	if (record.action === "ui_confirm") {
		return { type: "extension_ui_response", id: record.requestId, confirmed: record.confirmed };
	}
	return { type: "extension_ui_response", id: record.requestId, value: record.value };
}

export function deriveGateIdempotencyKey(input: { chatId: string; gateId: string; actionKey: string }): string {
	return `tg:${createHash("sha256").update(`${input.chatId}\0${input.gateId}\0${input.actionKey}`).digest("base64url").slice(0, 32)}`;
}

function sanitizeValue(value: string, maxLen: number): string {
	return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").slice(0, maxLen);
}

function hashValue(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("base64url").slice(0, 12);
}

import { createHash } from "node:crypto";
import type {
	RpcExtensionUIRequest,
	RpcWorkflowGate,
	RpcWorkflowGateOption,
} from "@gajae-code/coding-agent/modes/rpc/rpc-types";
import { escapeHtml } from "./projection";
import type {
	AttachmentRecord,
	PendingActionSummary,
	PendingActionType,
	RpcBackendState,
	RpcControlState,
	TelegramInlineKeyboardMarkup,
} from "./types";

export const RPC_CARD_TITLE_MAX = 160;
export const RPC_CARD_LINE_MAX = 160;
export const RPC_CARD_TEXT_MAX = 4000;
export const RPC_OPTION_MAX = 48;
export const RPC_CALLBACK_ANSWER_MAX = 120;

export const RPC_SENTINELS = [
	"GTR_SENTINEL_RAW_PROMPT_DO_NOT_SEND",
	"GTR_SENTINEL_TRANSCRIPT_DO_NOT_SEND",
	"GTR_SENTINEL_LOG_DO_NOT_SEND",
	"GTR_SENTINEL_DIFF_DO_NOT_SEND",
	"/private/tmp/GTR_SENTINEL_ABSOLUTE_PATH_DO_NOT_SEND",
	"GTR_SENTINEL_SECRET_TOKEN_DO_NOT_SEND=sk-gtr-secret",
	"GTR_SENTINEL_SYSTEM_PROMPT_DO_NOT_SEND",
	"/run/user/501/gjc/GTR_SENTINEL_SOCKET_PATH.sock",
	"/tmp/gtr/GTR_SENTINEL_ARTIFACT_PATH.md",
	'{"GTR_SENTINEL_BACKEND_SESSION_OBJECT_DO_NOT_SEND":true}',
	"GTR_SENTINEL_RAW_EVENT_PAYLOAD_DO_NOT_SEND",
] as const;

const ABSOLUTE_PATH_PATTERN = /(?:\/[A-Za-z0-9._ -]+){2,}/g;
const SECRET_PATTERN = /(?:sk-[A-Za-z0-9_-]{8,}|token\s*=\s*\S+|secret\s*=\s*\S+)/gi;
const SOCKET_PATTERN = /\S+\.sock\b/g;

export interface SafeWorkflowGateProjection {
	text: string;
	options: Array<{ label: string; option: RpcWorkflowGateOption; optionIndex: number }>;
	summary: PendingActionSummary;
}

export interface SafeExtensionUiProjection {
	text: string;
	options?: string[];
	summary?: PendingActionSummary;
}

export interface RpcLiveCardInput {
	attachment: AttachmentRecord | null;
	backendState?: RpcBackendState;
	now: number;
	hostLabel?: string;
	reconnectPending?: boolean;
}

export interface RpcLiveCardProjection {
	text: string;
	fingerprint: string;
}

export function safeRpcLine(value: unknown, maxLen = RPC_CARD_LINE_MAX, fallback = "Unavailable"): string {
	if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return fallback;
	const raw = String(value);
	const cleaned = redactForbidden(raw)
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (cleaned.length === 0) return fallback;
	return cleaned.length > maxLen ? `${cleaned.slice(0, maxLen - 1)}…` : cleaned;
}

export function safeCallbackAnswer(value: string): string {
	return safeRpcLine(value, RPC_CALLBACK_ANSWER_MAX, "Done.");
}

export function fingerprintRpcCard(text: string, replyMarkup?: TelegramInlineKeyboardMarkup): string {
	return createHash("sha256").update(JSON.stringify({ text, replyMarkup })).digest("hex").slice(0, 32);
}

export function renderRpcOnboarding(): string {
	return [
		"<b>GJC remote</b>",
		"Telegram is a Telegram-safe Codex-like controller for one already-running local RPC session.",
		"It is not ChatGPT mobile parity and not an OpenAI secure relay.",
		"Use /attach to connect, then send messages to steer work, answer questions, and approve gates.",
		"The host must stay awake, online, and running the RPC session.",
		"Files, credentials, permissions, local setup, logs, diffs, screenshots, test output, terminal history, transcripts, prompts, paths, env, and secrets stay on the host and are not browsed through Telegram.",
	].join("\n");
}

export function renderRpcLiveCard(input: RpcLiveCardInput): RpcLiveCardProjection {
	const attachment = input.attachment;
	const connected = input.backendState?.connected === true;
	const control = controlLabel(attachment?.controllerState);
	const pending = pendingLabel(attachment?.pendingActions ?? []);
	const liveness = livenessLabel(attachment, input.now);
	const chunk = chunkProgressLabel(attachment);
	const lines = [
		"<b>GJC remote</b>",
		`State: ${escapeHtml(stateLabel(attachment, connected, input.reconnectPending === true))}`,
		`Controller: ${escapeHtml(control)}`,
		`Host: ${escapeHtml(safeRpcLine(input.hostLabel ?? "Local RPC host", 48, "Local RPC host"))}`,
		`Liveness: ${escapeHtml(liveness)}`,
		`Pending: ${escapeHtml(pending)}`,
		`Delivery: ${escapeHtml(chunk)}`,
		`Next: ${escapeHtml(nextActionLabel(attachment, connected))}`,
	];
	const text = capCard(lines.join("\n"));
	return { text, fingerprint: fingerprintRpcCard(text) };
}

export function projectWorkflowGate(
	gate: RpcWorkflowGate,
	now = Date.now(),
	ttlMs = 5 * 60 * 1000,
): SafeWorkflowGateProjection {
	const options = gate.options && gate.options.length > 0 ? gate.options : defaultGateOptions(gate);
	const gateLabel = safeRpcLine(gate.kind, 48, "approval");
	const title = safeRpcLine(readSafeGateTitle(gate), RPC_CARD_TITLE_MAX, "Action required");
	const optionRows = options.map((option, optionIndex) => ({
		label: safeRpcLine(option.label ?? `Option ${optionIndex + 1}`, RPC_OPTION_MAX, `Option ${optionIndex + 1}`),
		option,
		optionIndex,
	}));
	const idHash = shortHash(gate.gate_id);
	const text = capCard(
		`<b>${escapeHtml(gateLabel)}</b> · <code>${escapeHtml(idHash)}</code>\n${escapeHtml(title)}\nChoose an option below.`,
	);
	return {
		text,
		options: optionRows,
		summary: {
			type: "workflow_gate",
			gateIdHash: idHash,
			dedupeKey: gateDedupeKey(gate),
			label: title,
			createdAt: now,
			expiresAt: now + ttlMs,
			status: "pending",
			optionHashes: optionRows.map(row => shortHash(row.option.value ?? row.label)),
		},
	};
}

export function projectExtensionUiRequest(
	request: RpcExtensionUIRequest,
	now = Date.now(),
	ttlMs = 5 * 60 * 1000,
): SafeExtensionUiProjection | null {
	switch (request.method) {
		case "select": {
			const title = safeRpcLine(request.title, RPC_CARD_TITLE_MAX, "Choose one option");
			const options = request.options.map((option, index) =>
				safeRpcLine(option, RPC_OPTION_MAX, `Option ${index + 1}`),
			);
			return {
				text: `<b>${escapeHtml(title)}</b>\nChoose an option below.`,
				options,
				summary: pendingUiSummary("ui_select", request.id, title, now, ttlMs),
			};
		}
		case "confirm": {
			const title = safeRpcLine(request.title, RPC_CARD_TITLE_MAX, "Confirm action");
			const message = safeRpcLine(request.message, RPC_CARD_LINE_MAX, "Confirm this action.");
			return {
				text: `<b>${escapeHtml(title)}</b>\n${escapeHtml(message)}`,
				summary: pendingUiSummary("ui_confirm", request.id, title, now, ttlMs),
			};
		}
		case "input":
		case "editor": {
			const title = safeRpcLine(
				request.title,
				RPC_CARD_TITLE_MAX,
				request.method === "editor" ? "Edit text" : "Answer required",
			);
			const hint =
				request.method === "editor"
					? "Send the replacement text as the next message."
					: "Send the answer as the next message.";
			return {
				text: `<b>${escapeHtml(title)}</b>\n${hint}`,
				summary: pendingUiSummary(
					request.method === "editor" ? "ui_editor" : "ui_text",
					request.id,
					title,
					now,
					ttlMs,
				),
			};
		}
		default:
			return null;
	}
}

export function gateDedupeKey(gate: RpcWorkflowGate): string {
	return `gate:${shortHash({ gateId: gate.gate_id, options: (gate.options ?? []).map(option => option.value ?? option.label) })}`;
}

export function requestDedupeKey(requestId: string, type: PendingActionType): string {
	return `${type}:${shortHash(requestId)}`;
}

export function upsertPendingAction(
	actions: readonly PendingActionSummary[] | undefined,
	next: PendingActionSummary,
): PendingActionSummary[] {
	const filtered = (actions ?? []).filter(action => action.dedupeKey !== next.dedupeKey);
	return [...filtered, next].slice(-25);
}

export function markPendingAction(
	actions: readonly PendingActionSummary[] | undefined,
	dedupeKey: string,
	status: PendingActionSummary["status"],
): PendingActionSummary[] {
	return (actions ?? []).map(action => (action.dedupeKey === dedupeKey ? { ...action, status } : action));
}

export function clearPendingAction(
	actions: readonly PendingActionSummary[] | undefined,
	dedupeKey: string,
): PendingActionSummary[] {
	return (actions ?? []).filter(action => action.dedupeKey !== dedupeKey);
}

export function expireMissingPendingActions(
	actions: readonly PendingActionSummary[] | undefined,
	activeDedupeKeys: ReadonlySet<string>,
): PendingActionSummary[] {
	return (actions ?? []).map(action =>
		activeDedupeKeys.has(action.dedupeKey) || action.status !== "pending" ? action : { ...action, status: "expired" },
	);
}

export function pendingUiSummary(
	type: Extract<PendingActionType, "ui_select" | "ui_confirm" | "ui_text" | "ui_editor">,
	requestId: string,
	label: string,
	now: number,
	ttlMs: number,
): PendingActionSummary {
	const requestIdHash = shortHash(requestId);
	return {
		type,
		requestIdHash,
		dedupeKey: requestDedupeKey(requestId, type),
		label: safeRpcLine(label, RPC_CARD_LINE_MAX, "Action required"),
		createdAt: now,
		expiresAt: now + ttlMs,
		status: "pending",
	};
}

export function shortHash(value: unknown): string {
	const text = typeof value === "string" ? value : JSON.stringify(value);
	return createHash("sha256").update(text).digest("base64url").slice(0, 12);
}

function redactForbidden(value: string): string {
	let output = value;
	for (const sentinel of RPC_SENTINELS) output = output.split(sentinel).join("[redacted]");
	return output
		.replace(SECRET_PATTERN, "[redacted]")
		.replace(SOCKET_PATTERN, "[redacted]")
		.replace(ABSOLUTE_PATH_PATTERN, "[redacted]");
}

function readSafeGateTitle(gate: RpcWorkflowGate): string {
	const context = gate.context;
	if (typeof context.title === "string" && context.title.trim().length > 0) return context.title;
	if (typeof context.summary === "string" && context.summary.trim().length > 0) return context.summary;
	return `${gate.kind} required`;
}

function defaultGateOptions(gate: RpcWorkflowGate): RpcWorkflowGateOption[] {
	if (gate.kind === "approval") {
		return [
			{ label: "Approve", value: "approve" },
			{ label: "Reject", value: "reject" },
		];
	}
	return [{ label: "Continue", value: true }];
}

function stateLabel(attachment: AttachmentRecord | null, connected: boolean, reconnectPending: boolean): string {
	if (!attachment) return "Detached";
	if (attachment.stale) return "Stale";
	if (reconnectPending || attachment.controllerState === "reconnecting") return "Reconnecting";
	return connected ? "Attached" : "Disconnected";
}

function controlLabel(state: RpcControlState | undefined): string {
	switch (state) {
		case "connecting":
			return "Connecting";
		case "attached_idle":
			return "Idle";
		case "attached_turn_active":
			return "Turn active";
		case "waiting_for_ui":
			return "Waiting for you";
		case "control_pending_abort_and_prompt":
			return "Redirect queued";
		case "reconnecting":
			return "Reconnecting";
		case "stale":
			return "Stale";
		case "detached":
			return "Detached";
		default:
			return "Unknown";
	}
}

function pendingLabel(actions: readonly PendingActionSummary[]): string {
	const pending = actions.filter(action => action.status === "pending");
	if (pending.length === 0) return "None";
	const labels = pending.slice(0, 3).map(action => safeRpcLine(action.label, 48, "Action"));
	const suffix = pending.length > labels.length ? ` +${pending.length - labels.length}` : "";
	return `${pending.length} · ${labels.join(", ")}${suffix}`;
}

function livenessLabel(attachment: AttachmentRecord | null, now: number): string {
	if (!attachment?.liveness) return "No heartbeat yet";
	const ageMs = Math.max(0, now - attachment.liveness.lastSeenAt);
	const age = ageMs < 60_000 ? `${Math.floor(ageMs / 1000)}s ago` : `${Math.floor(ageMs / 60_000)}m ago`;
	return `${age} (timeout ${Math.ceil(attachment.liveness.timeoutMs / 1000)}s)`;
}

function chunkProgressLabel(attachment: AttachmentRecord | null): string {
	const progress = attachment?.chunkProgress;
	if (!progress) return "Ready";
	return `chunk ${Math.min(progress.nextChunkIndex + 1, progress.chunkCount)}/${progress.chunkCount}`;
}

function nextActionLabel(attachment: AttachmentRecord | null, connected: boolean): string {
	if (!attachment) return "Send /attach";
	if (attachment.stale) return "Restart the host session, then /attach";
	if (!connected) return "Wait for reconnect or send /status";
	if (attachment.controllerState === "waiting_for_ui") return "Use the pending buttons or reply";
	if (attachment.controllerState === "attached_turn_active") return "Send text to steer";
	return "Send a message to start work";
}

function capCard(text: string): string {
	return text.length > RPC_CARD_TEXT_MAX ? `${text.slice(0, RPC_CARD_TEXT_MAX - 1)}…` : text;
}

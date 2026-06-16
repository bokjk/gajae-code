/**
 * Public surface of `@gajae-code/telegram-remote`. The Telegram operator gateway
 * over the Coordinator MCP: lifecycle and observation only, with optional rich
 * messaging (inline keyboards, HTML formatting, callback queries).
 */
export { parseCommand } from "./commands";
export { loadConfigFromEnv, type ServiceConfig } from "./config";
export { McpStdioCoordinatorClient, type McpStdioOptions } from "./coordinator-client";
export { type GatewayDeps, type GatewayPolicy, TelegramRemoteGateway } from "./gateway";
export { MESSAGES, UNAUTHORIZED_REFUSAL } from "./messages";
export { assertValidPreset, type PresetResolution, resolvePreset, sanitizeTask, TASK_SLOT } from "./presets";
export {
	activeTurnId,
	deriveStatus,
	deriveTurnActivity,
	escapeHtml,
	findSessionView,
	formatRelativeTime,
	isTerminalStatus,
	isWithinRetention,
	projectSessionRows,
	projectSessionSummaries,
	projectSessionSummary,
	projectSessionView,
	RETENTION_DEFAULT_MS,
	readSessionId,
	renderSessionsList,
	renderSessionsListHtml,
	renderSessionView,
	renderSessionViewHtml,
	shortSessionId,
} from "./projection";
export { type RunServiceOptions, runService } from "./service";
export { type TelegramBotApiOptions, TelegramBotApiTransport } from "./telegram";
export {
	CALLBACK_PREFIX,
	type CallbackAction,
	type CallbackTokenRecord,
	CallbackTokenStore,
	parseCallbackData,
} from "./tokens";
export type {
	CallbackAnswer,
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
	ParsedCommand,
	RawRecord,
	ReportStatusResult,
	SessionStatus,
	SessionSummary,
	SessionView,
	StartSessionResult,
	TelegramInlineKeyboardButton,
	TelegramInlineKeyboardMarkup,
	TelegramParseMode,
	TelegramTransport,
	TurnActivity,
} from "./types";

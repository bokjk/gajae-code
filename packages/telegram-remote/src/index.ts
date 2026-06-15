/**
 * Public surface of `@gajae-code/telegram-remote`. The v0 Telegram operator
 * gateway over the Coordinator MCP: lifecycle and observation only.
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
	findSessionView,
	projectSessionSummaries,
	projectSessionSummary,
	projectSessionView,
	renderSessionsList,
	renderSessionView,
} from "./projection";
export { type RunServiceOptions, runService } from "./service";
export { type TelegramBotApiOptions, TelegramBotApiTransport } from "./telegram";
export type {
	CoordinationStatus,
	CoordinatorClient,
	GatewayPreset,
	IncomingMessage,
	ParsedCommand,
	RawRecord,
	ReportStatusResult,
	SessionStatus,
	SessionSummary,
	SessionView,
	StartSessionResult,
	TelegramTransport,
	TurnActivity,
} from "./types";

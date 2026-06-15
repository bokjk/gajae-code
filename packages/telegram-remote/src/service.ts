/**
 * Service wiring: connect the Telegram transport to the gateway and the
 * coordinator client, and run the receive loop until stopped.
 */
import type { ServiceConfig } from "./config";
import { McpStdioCoordinatorClient } from "./coordinator-client";
import { TelegramRemoteGateway } from "./gateway";
import { TelegramBotApiTransport } from "./telegram";
import type { CoordinatorClient, TelegramTransport } from "./types";

/** Optional injection points for local runs and integration tests. */
export interface RunServiceOptions {
	coordinator?: CoordinatorClient;
	transport?: TelegramTransport;
}

/** Wire and run the gateway service until the transport loop ends. */
export async function runService(config: ServiceConfig, options: RunServiceOptions = {}): Promise<void> {
	const coordinator = options.coordinator ?? new McpStdioCoordinatorClient(config.coordinator);
	const transport =
		options.transport ??
		new TelegramBotApiTransport({
			botToken: config.botToken,
			apiBase: config.apiBase,
			pollTimeoutSec: config.pollTimeoutSec,
		});
	const gateway = new TelegramRemoteGateway(config.policy, { coordinator });

	const shutdown = (): void => {
		transport.stop();
	};
	process.once("SIGINT", shutdown);
	process.once("SIGTERM", shutdown);

	try {
		await transport.run(message => gateway.handleMessage(message));
	} finally {
		process.off("SIGINT", shutdown);
		process.off("SIGTERM", shutdown);
		await coordinator.close?.();
	}
}

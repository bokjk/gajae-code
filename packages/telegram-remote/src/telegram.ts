/**
 * Telegram Bot API transport. Dependency-free long-poll adapter over the public
 * Bot API using `fetch`. It only forwards normalized text messages to the
 * gateway and sends back the gateway's chat-safe reply text.
 */
import type { IncomingMessage, TelegramTransport } from "./types";

const DEFAULT_API_BASE = "https://api.telegram.org";
const DEFAULT_POLL_TIMEOUT_SEC = 30;
const ERROR_BACKOFF_MS = 2000;

/** Options for the real Bot API transport. */
export interface TelegramBotApiOptions {
	botToken: string;
	apiBase?: string;
	pollTimeoutSec?: number;
	/** Injectable fetch for tests. */
	fetchImpl?: typeof fetch;
}

interface TelegramUpdate {
	update_id: number;
	message?: {
		text?: string;
		chat?: { id?: number | string };
		from?: { id?: number | string };
	};
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function normalize(update: TelegramUpdate): IncomingMessage | null {
	const message = update.message;
	const text = message?.text;
	const chatId = message?.chat?.id;
	if (typeof text !== "string" || (typeof chatId !== "number" && typeof chatId !== "string")) {
		return null;
	}
	const userId = message?.from?.id;
	return {
		text,
		chatId: String(chatId),
		userId: typeof userId === "number" || typeof userId === "string" ? String(userId) : null,
	};
}

export class TelegramBotApiTransport implements TelegramTransport {
	private readonly endpoint: string;
	private readonly pollTimeoutSec: number;
	private readonly fetchImpl: typeof fetch;
	private running = false;
	private offset = 0;

	constructor(options: TelegramBotApiOptions) {
		const base = options.apiBase ?? DEFAULT_API_BASE;
		this.endpoint = `${base}/bot${options.botToken}`;
		this.pollTimeoutSec = options.pollTimeoutSec ?? DEFAULT_POLL_TIMEOUT_SEC;
		this.fetchImpl = options.fetchImpl ?? fetch;
	}

	async run(onMessage: (message: IncomingMessage) => Promise<string>): Promise<void> {
		this.running = true;
		while (this.running) {
			const updates = await this.getUpdates();
			if (updates.length === 0) continue;
			for (const update of updates) {
				this.offset = update.update_id + 1;
				const message = normalize(update);
				if (!message) continue;
				let reply: string;
				try {
					reply = await onMessage(message);
				} catch {
					reply = "Request failed.";
				}
				await this.sendMessage(message.chatId, reply);
			}
		}
	}

	stop(): void {
		this.running = false;
	}

	private async getUpdates(): Promise<TelegramUpdate[]> {
		try {
			const response = await this.fetchImpl(`${this.endpoint}/getUpdates`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					offset: this.offset,
					timeout: this.pollTimeoutSec,
					allowed_updates: ["message"],
				}),
			});
			const data = (await response.json()) as { ok?: boolean; result?: TelegramUpdate[] };
			return data.ok && Array.isArray(data.result) ? data.result : [];
		} catch {
			await sleep(ERROR_BACKOFF_MS);
			return [];
		}
	}

	private async sendMessage(chatId: string, text: string): Promise<void> {
		try {
			await this.fetchImpl(`${this.endpoint}/sendMessage`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ chat_id: chatId, text }),
			});
		} catch {
			// A failed reply must not crash the receive loop; the operator can retry.
		}
	}
}

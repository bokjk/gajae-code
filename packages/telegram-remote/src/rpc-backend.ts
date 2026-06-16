import { RpcClient } from "@gajae-code/coding-agent";
import type { RpcBackendConfig, RpcBackendPort, RpcBackendState } from "./types";

type RpcLifecycleEvent = { type: string; [key: string]: unknown };

type RpcClientWithTransportError = RpcClient & { onTransportError?: (listener: (error: Error) => void) => () => void };

type SocketSecurityModule = { assertSafeClientSocket(socketPath: string): Promise<void> };

async function validateClientSocket(socketPath: string): Promise<void> {
	const importer = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<unknown>;
	const security = (await importer(
		"@gajae-code/coding-agent/modes/rpc/rpc-socket-security.ts",
	)) as SocketSecurityModule;
	await security.assertSafeClientSocket(socketPath);
}

export class RpcBackend implements RpcBackendPort {
	readonly #config: RpcBackendConfig;
	#client: RpcClient | null = null;
	#connected = false;
	#eventListeners = new Set<(event: RpcLifecycleEvent) => void>();
	#transportErrorListeners = new Set<(error: Error) => void>();
	#commandIgnoredListeners = new Set<(error: Error) => void>();
	#unsubscribeEvents: (() => void) | null = null;
	#unsubscribeTransportError: (() => void) | null = null;

	constructor(config: RpcBackendConfig) {
		this.#config = config;
	}

	async connect(): Promise<void> {
		await validateClientSocket(this.#config.socketPath);
		const client = new RpcClient({
			transport: "uds",
			socketPath: this.#config.socketPath,
			onTransportError: (error: Error) => this.#emitTransportError(error),
		} as ConstructorParameters<typeof RpcClient>[0] & { transport: "uds"; socketPath: string });
		this.#unsubscribeEvents = client.onEvent(event => this.#emitEvent(event as RpcLifecycleEvent));
		this.#unsubscribeTransportError =
			(client as RpcClientWithTransportError).onTransportError?.((error: Error) =>
				this.#emitTransportError(error),
			) ?? null;
		await client.start();
		this.#client = client;
		this.#connected = true;
	}

	async close(): Promise<void> {
		this.#unsubscribeEvents?.();
		this.#unsubscribeTransportError?.();
		this.#unsubscribeEvents = null;
		this.#unsubscribeTransportError = null;
		this.#client?.stop();
		this.#client = null;
		this.#connected = false;
	}

	async getState(): Promise<RpcBackendState> {
		const session = this.#client ? await this.#client.getState().catch(() => undefined) : undefined;
		return { connected: this.#connected, socketPath: this.#config.socketPath, session };
	}

	async prompt(message: string): Promise<void> {
		await this.#callCommand(() => this.#requireClient().prompt(message));
	}

	async steer(message: string): Promise<void> {
		await this.#callCommand(() => this.#requireClient().steer(message));
	}

	async abort(): Promise<void> {
		await this.#callCommand(() => this.#requireClient().abort());
	}

	async abortAndPrompt(message: string): Promise<void> {
		await this.#callCommand(() => this.#requireClient().abortAndPrompt(message));
	}

	onEvents(listener: (event: RpcLifecycleEvent) => void): () => void {
		this.#eventListeners.add(listener);
		return () => this.#eventListeners.delete(listener);
	}

	onTransportError(listener: (error: Error) => void): () => void {
		this.#transportErrorListeners.add(listener);
		return () => this.#transportErrorListeners.delete(listener);
	}

	onCommandIgnored(listener: (error: Error) => void): () => void {
		this.#commandIgnoredListeners.add(listener);
		return () => this.#commandIgnoredListeners.delete(listener);
	}

	#requireClient(): RpcClient {
		if (!this.#client || !this.#connected) throw new Error("rpc_backend_not_connected");
		return this.#client;
	}

	async #callCommand(work: () => Promise<void>): Promise<void> {
		try {
			await work();
		} catch (error) {
			const normalized = error instanceof Error ? error : new Error(String(error));
			if (/timeout|ignored/i.test(normalized.message)) this.#emitCommandIgnored(normalized);
			throw normalized;
		}
	}

	#emitEvent(event: RpcLifecycleEvent): void {
		for (const listener of this.#eventListeners) listener(event);
	}

	#emitTransportError(error: Error): void {
		this.#connected = false;
		for (const listener of this.#transportErrorListeners) listener(error);
	}

	#emitCommandIgnored(error: Error): void {
		this.#connected = false;
		for (const listener of this.#commandIgnoredListeners) listener(error);
	}
}

export class FakeRpcBackend implements RpcBackendPort {
	connected = false;
	connectCalls = 0;
	closeCalls = 0;
	calls: Array<{
		method: "connect" | "close" | "getState" | "prompt" | "steer" | "abort" | "abortAndPrompt";
		args?: unknown;
	}> = [];
	state: RpcBackendState;
	transportErrorListeners = new Set<(error: Error) => void>();
	commandIgnoredListeners = new Set<(error: Error) => void>();

	constructor(socketPath = "/tmp/gjc-rpc.sock") {
		this.state = { connected: false, socketPath };
	}

	async connect(): Promise<void> {
		this.calls.push({ method: "connect" });
		this.connectCalls += 1;
		this.connected = true;
		this.state = { ...this.state, connected: true };
	}

	async close(): Promise<void> {
		this.calls.push({ method: "close" });
		this.closeCalls += 1;
		this.connected = false;
		this.state = { ...this.state, connected: false };
	}

	async getState(): Promise<RpcBackendState> {
		this.calls.push({ method: "getState" });
		return { ...this.state };
	}

	async prompt(message: string): Promise<void> {
		this.calls.push({ method: "prompt", args: message });
	}

	async steer(message: string): Promise<void> {
		this.calls.push({ method: "steer", args: message });
	}

	async abort(): Promise<void> {
		this.calls.push({ method: "abort" });
	}

	async abortAndPrompt(message: string): Promise<void> {
		this.calls.push({ method: "abortAndPrompt", args: message });
	}

	onTransportError(listener: (error: Error) => void): () => void {
		this.transportErrorListeners.add(listener);
		return () => this.transportErrorListeners.delete(listener);
	}

	onCommandIgnored(listener: (error: Error) => void): () => void {
		this.commandIgnoredListeners.add(listener);
		return () => this.commandIgnoredListeners.delete(listener);
	}

	emitTransportError(error = new Error("transport_error")): void {
		for (const listener of this.transportErrorListeners) listener(error);
	}

	emitCommandIgnored(error = new Error("command ignored")): void {
		for (const listener of this.commandIgnoredListeners) listener(error);
	}

	countOf(method: "connect" | "close" | "getState" | "prompt" | "steer" | "abort" | "abortAndPrompt"): number {
		return this.calls.filter(call => call.method === method).length;
	}
}

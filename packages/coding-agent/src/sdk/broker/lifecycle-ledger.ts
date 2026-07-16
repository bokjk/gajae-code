import { createHash } from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import type { SdkStartupFailure, SdkStartupRollbackResult } from "../startup-capability";
import { parseLifecycleJson } from "./lifecycle-codec";
import { assertSupportedStateVersion, SDK_STATE_VERSION } from "./state-version";

export type LifecycleState =
	| "accepted"
	| "effect_started"
	| "awaiting_ready"
	| "terminal_ok"
	| "terminal_error"
	| "terminal_uncertain";
export interface LifecycleWorktreeIntent {
	repoRoot: string;
	worktreePath: string;
	detached: boolean;
	baseRef: string;
	branchName?: string;
}

export interface LifecycleEffectIntent {
	sessionId: string;
	stateRoot: string;
	childOwnershipEstablished?: boolean;
	worktree?: LifecycleWorktreeIntent;
}

/** Durable lifecycle effects retained for exact replay; never implies rollback authority. */
export interface LifecycleCleanupProof {
	processExited: true;
	endpointRemoved: true;
	hostUnregistered:
		| { state: "unregistered"; indexSeq: number; lifecycleRequestId?: string }
		| { state: "not_registered" };
	rollback: {
		endpointGeneration: number | null;
		fenced: true;
		runtimeRemoved: true;
		hostStopped: true;
		brokerRegistrationReleased: true;
	};
}

export interface LifecycleStartupFailureReceipt extends SdkStartupFailure {
	artifactDigest: string;
	rollback: SdkStartupRollbackResult;
	cleanupProof?: LifecycleCleanupProof;
}

export interface LifecycleDurableEffectsReceipt {
	worktree?: {
		cwdDigest: string;
		created: boolean;
		reused: boolean;
		branchDigest?: string;
	};
	transcript?: {
		identityDigest: string;
		contentDigest: string;
	};
	startup?: LifecycleStartupFailureReceipt;
	digest?: string;
}

export interface LifecycleLedgerEntry {
	version: typeof SDK_STATE_VERSION;
	identity: string;
	requestHash: string;
	state: LifecycleState;
	intendedSessionId?: string;
	resultSessionId?: string;
	effectMarker?: string;
	effectIntent?: LifecycleEffectIntent;
	durableEffects?: LifecycleDurableEffectsReceipt;
	startupFailure?: LifecycleStartupFailureReceipt;

	endpointGeneration?: number;
	responseDigest?: string;
	response?: unknown;
	ts: number;
}
export type BeginResult =
	| { kind: "new"; entry: LifecycleLedgerEntry }
	| { kind: "replay"; entry: LifecycleLedgerEntry }
	| { kind: "idempotency_conflict" }
	| { kind: "terminal_uncertain"; entry: LifecycleLedgerEntry }
	| { kind: "in_progress"; entry: LifecycleLedgerEntry };
const terminal = (s: LifecycleState) => s === "terminal_ok" || s === "terminal_error";
const MAX_LIFECYCLE_LEDGER_BYTES = 8 * 1024 * 1024;
const MAX_LIFECYCLE_LEDGER_LINE_BYTES = 64 * 1024;
const MAX_LIFECYCLE_LEDGER_ROWS = 10_000;
const MAX_LIFECYCLE_LEDGER_JSON_DEPTH = 64;
const MAX_LIFECYCLE_LEDGER_JSON_FIELDS = 1024;

function isBoundedLedgerJson(value: unknown, depth = 0, budget = { fields: 0 }): boolean {
	if (depth > MAX_LIFECYCLE_LEDGER_JSON_DEPTH) return false;
	if (value === null || typeof value !== "object") return true;
	if (Array.isArray(value)) {
		if (value.length > MAX_LIFECYCLE_LEDGER_JSON_FIELDS) return false;
		return value.every(item => isBoundedLedgerJson(item, depth + 1, budget));
	}
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record);
	budget.fields += keys.length;
	return (
		budget.fields <= MAX_LIFECYCLE_LEDGER_JSON_FIELDS &&
		keys.every(key => isBoundedLedgerJson(record[key], depth + 1, budget))
	);
}

function isLifecycleLedgerEntry(value: unknown): value is LifecycleLedgerEntry {
	if (typeof value !== "object" || value === null || Array.isArray(value) || !isBoundedLedgerJson(value)) return false;
	const entry = value as Partial<LifecycleLedgerEntry>;
	return (
		typeof entry.identity === "string" &&
		entry.identity.length > 0 &&
		typeof entry.requestHash === "string" &&
		entry.requestHash.length > 0 &&
		(entry.state === "accepted" ||
			entry.state === "effect_started" ||
			entry.state === "awaiting_ready" ||
			entry.state === "terminal_ok" ||
			entry.state === "terminal_error" ||
			entry.state === "terminal_uncertain") &&
		typeof entry.ts === "number" &&
		Number.isSafeInteger(entry.ts)
	);
}
function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
		.join(",")}}`;
}

function hasValidTerminalDigests(entry: LifecycleLedgerEntry): boolean {
	if (!terminal(entry.state) && entry.state !== "terminal_uncertain") return true;
	if (
		(entry.state !== "terminal_uncertain" || entry.response !== undefined) &&
		(entry.response === undefined ||
			typeof entry.responseDigest !== "string" ||
			entry.responseDigest !== createHash("sha256").update(canonicalJson(entry.response)).digest("hex"))
	)
		return false;
	if (!entry.durableEffects) return true;
	const { digest, ...body } = entry.durableEffects;
	return typeof digest === "string" && digest === createHash("sha256").update(canonicalJson(body)).digest("hex");
}
export class LifecycleLedger {
	#file: string;
	#corruptFile: string;
	#entries: LifecycleLedgerEntry[] = [];
	#byIdentity = new Map<string, LifecycleLedgerEntry>();
	#warnings: string[] = [];
	constructor(agentDir: string) {
		this.#file = path.join(agentDir, "sdk", "lifecycle-ledger.jsonl");
		this.#corruptFile = `${this.#file}.corrupt`;
	}
	async open(): Promise<this> {
		await fs.mkdir(path.dirname(this.#file), { recursive: true, mode: 0o700 });
		this.#entries = [];
		const quarantinedTerminal = new Set<string>();
		this.#byIdentity.clear();
		this.#warnings = [];
		const uncertainAfterCorruption = new Set<string>();
		const source = await this.#readBoundedSource();
		let tornTail = false;
		if (source) {
			tornTail = source.length > 0 && source.at(-1) !== 0x0a;
			let lineStart = 0;
			let rows = 0;
			for (let offset = 0; offset <= source.length; offset += 1) {
				if (offset !== source.length && source[offset] !== 0x0a) continue;
				const line = source.subarray(lineStart, offset);
				lineStart = offset + 1;
				if (line.length === 0) continue;
				rows += 1;
				if (rows > MAX_LIFECYCLE_LEDGER_ROWS)
					await this.#rejectOversizedSource("Lifecycle ledger exceeds the maximum row count.");
				if (line.length > MAX_LIFECYCLE_LEDGER_LINE_BYTES)
					await this.#rejectOversizedSource("Lifecycle ledger row exceeds the maximum byte length.");
				try {
					const value = parseLifecycleJson(line);
					if (!isLifecycleLedgerEntry(value)) throw new Error("invalid ledger entry");
					const entry = value;
					assertSupportedStateVersion(this.#file, entry);
					if (!hasValidTerminalDigests(entry)) {
						await this.#quarantine(line);
						const {
							response: _response,
							responseDigest: _responseDigest,
							durableEffects: _durableEffects,
							...uncertain
						} = entry;
						const quarantined = { ...uncertain, state: "terminal_uncertain" as const, ts: Date.now() };
						this.#entries.push(quarantined);
						this.#byIdentity.set(quarantined.identity, quarantined);
						quarantinedTerminal.add(quarantined.identity);
						continue;
					}
					this.#entries.push(entry);
					this.#byIdentity.set(entry.identity, entry);
					uncertainAfterCorruption.delete(entry.identity);
				} catch (error) {
					if (error instanceof Error && "code" in error && error.code === "unsupported_state_version") throw error;
					for (const [identity, latest] of this.#byIdentity) {
						if (!terminal(latest.state) && latest.state !== "terminal_uncertain")
							uncertainAfterCorruption.add(identity);
					}
					await this.#quarantine(line);
				}
			}
		}
		if (tornTail) await this.#sealTornTail();
		for (const identity of quarantinedTerminal) {
			const entry = this.#byIdentity.get(identity);
			if (entry) await this.#append(entry);
		}
		for (const identity of uncertainAfterCorruption) {
			const entry = this.#byIdentity.get(identity);
			if (entry && !terminal(entry.state) && entry.state !== "terminal_uncertain") {
				const uncertain = { ...entry, state: "terminal_uncertain" as const, ts: Date.now() };
				if (uncertain.response !== undefined)
					uncertain.responseDigest = createHash("sha256").update(canonicalJson(uncertain.response)).digest("hex");
				await this.#append(uncertain);
			}
		}
		// Effects may have completed after the last durable marker; do not retry them after a restart.
		for (const entry of [...this.#byIdentity.values()]) {
			if (entry.state === "effect_started" || entry.state === "awaiting_ready") {
				const uncertain = { ...entry, state: "terminal_uncertain" as const, ts: Date.now() };
				if (uncertain.response !== undefined)
					uncertain.responseDigest = createHash("sha256").update(canonicalJson(uncertain.response)).digest("hex");
				await this.#append(uncertain);
			}
		}
		return this;
	}
	async #readBoundedSource(): Promise<Buffer | undefined> {
		let handle: fs.FileHandle | undefined;
		try {
			handle = await fs.open(this.#file, fsSync.constants.O_RDONLY | fsSync.constants.O_NOFOLLOW);
			const stat = await handle.stat({ bigint: true });
			if (!stat.isFile() || stat.size > BigInt(MAX_LIFECYCLE_LEDGER_BYTES))
				await this.#rejectOversizedSource("Lifecycle ledger exceeds the maximum file byte length.");
			const bytes = Buffer.alloc(Number(stat.size) + 1);
			const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
			if (bytesRead > MAX_LIFECYCLE_LEDGER_BYTES)
				await this.#rejectOversizedSource("Lifecycle ledger exceeds the maximum file byte length.");
			return bytes.subarray(0, bytesRead);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		} finally {
			if (handle) await handle.close();
		}
	}
	async #rejectOversizedSource(reason: string): Promise<never> {
		await this.#quarantine(reason);
		throw new Error(reason);
	}
	async #sealTornTail(): Promise<void> {
		const h = await fs.open(this.#file, "a", 0o600);
		try {
			await h.writeFile("\n");
			await h.sync();
		} finally {
			await h.close();
		}
	}
	async #quarantine(line: string | Uint8Array): Promise<void> {
		const h = await fs.open(this.#corruptFile, "a", 0o600);
		try {
			await h.writeFile(line);
			await h.writeFile("\n");
			await h.sync();
		} finally {
			await h.close();
		}
		this.#warnings.push("Malformed lifecycle ledger entry quarantined");
	}
	get warnings(): readonly string[] {
		return this.#warnings;
	}
	async #append(entry: LifecycleLedgerEntry): Promise<LifecycleLedgerEntry> {
		const h = await fs.open(this.#file, "a", 0o600);
		try {
			await h.writeFile(`${JSON.stringify(entry)}\n`);
			await h.sync();
		} finally {
			await h.close();
		}
		this.#entries.push(entry);
		this.#byIdentity.set(entry.identity, entry);
		return entry;
	}
	async begin(identity: string, requestHash: string): Promise<BeginResult> {
		const prior = this.#byIdentity.get(identity);
		if (!prior)
			return {
				kind: "new",
				entry: await this.#append({
					version: SDK_STATE_VERSION,
					identity,
					requestHash,
					state: "accepted",
					ts: Date.now(),
				}),
			};
		if (prior.requestHash !== requestHash) return { kind: "idempotency_conflict" };
		if (terminal(prior.state)) return { kind: "replay", entry: prior };
		if (prior.state === "terminal_uncertain") return { kind: "terminal_uncertain", entry: prior };
		// An accepted row has no durable side effect. Target serialization makes retrying it safe.
		if (prior.state === "accepted") return { kind: "new", entry: prior };
		return { kind: "in_progress", entry: prior };
	}
	async transition(
		identity: string,
		state: LifecycleState,
		fields: Omit<Partial<LifecycleLedgerEntry>, "identity" | "requestHash" | "state" | "ts"> = {},
	): Promise<LifecycleLedgerEntry> {
		const previous = this.#byIdentity.get(identity);
		if (!previous) throw new Error("Unknown lifecycle identity");
		const next = { ...previous, ...fields, state, ts: Date.now() };
		if (
			(terminal(state) || state === "terminal_uncertain") &&
			next.response !== undefined &&
			next.responseDigest === undefined
		)
			next.responseDigest = createHash("sha256").update(canonicalJson(next.response)).digest("hex");
		if (next.durableEffects && next.durableEffects.digest === undefined) {
			const { digest: _digest, ...body } = next.durableEffects;
			next.durableEffects = {
				...body,
				digest: createHash("sha256").update(canonicalJson(body)).digest("hex"),
			};
		}
		return this.#append(next);
	}

	async assertSupportedStateVersions(): Promise<void> {
		const source = await this.#readBoundedSource();
		if (!source) return;
		let lineStart = 0;
		for (let offset = 0; offset <= source.length; offset += 1) {
			if (offset !== source.length && source[offset] !== 0x0a) continue;
			const line = source.subarray(lineStart, offset);
			lineStart = offset + 1;
			if (line.length === 0 || line.length > MAX_LIFECYCLE_LEDGER_LINE_BYTES) continue;
			try {
				assertSupportedStateVersion(this.#file, parseLifecycleJson(line));
			} catch (error) {
				if (error instanceof Error && "code" in error && error.code === "unsupported_state_version") throw error;
			}
		}
	}

	get(identity: string): LifecycleLedgerEntry | undefined {
		return this.#byIdentity.get(identity);
	}
}

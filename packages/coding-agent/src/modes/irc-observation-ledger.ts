import type { ParsedIrcMessage } from "./utils/irc-message";

type InlineMode = "persistent" | "ephemeral";

export type IrcObservationRecord = Readonly<
	ParsedIrcMessage & {
		mode: InlineMode;
		observedAt: number;
		expiresAt?: number;
	}
>;

/** Runtime-only IRC observations. This intentionally has no persistence layer. */
export class IrcObservationLedger {
	#records = new Map<string, IrcObservationRecord>();

	observe(message: ParsedIrcMessage, settingEnabledAtObservation: boolean): IrcObservationRecord {
		const existing = this.#records.get(message.observationId);
		if (existing) return existing;

		const observedAt = Date.now();
		const mode: InlineMode = settingEnabledAtObservation ? "ephemeral" : "persistent";
		const record: IrcObservationRecord = Object.freeze({
			...message,
			mode,
			observedAt,
			...(mode === "ephemeral" ? { expiresAt: observedAt + 10_000 } : {}),
		});
		this.#records.set(record.observationId, record);
		return record;
	}

	getSidebarRecords(): readonly IrcObservationRecord[] {
		return [...this.#records.values()];
	}

	getInlineProjection(now: number): readonly IrcObservationRecord[] {
		return [...this.#records.values()].filter(record => record.mode === "persistent" || now < record.expiresAt!);
	}

	reset(): void {
		this.#records.clear();
	}
}

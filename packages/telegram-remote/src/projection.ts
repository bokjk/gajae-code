/**
 * Typed, redacted projection from the coordinator's bounded status into the
 * chat transmitted-data allowlist (docs/telegram-remote.md "Transmitted-data
 * contract"). Projections are built field-by-field from raw records — never by
 * spreading — so non-allowlisted fields (raw tail, transcripts, tool IO, diffs,
 * file contents, env, secrets, absolute paths) can never reach chat.
 */
import { MESSAGES } from "./messages";
import type { CoordinationStatus, RawRecord, SessionStatus, SessionSummary, SessionView, TurnActivity } from "./types";

const ACTIVE_TURN_STATUSES = new Set(["delivering", "active", "waiting_for_answer", "completing"]);
const TERMINAL_TURN_STATUSES = new Set(["completed", "failed", "cancelled", "superseded"]);

const NAME_MAX_LEN = 48;
const BRANCH_MAX_LEN = 64;
const BLOCKER_MAX_LEN = 120;
// Strict ISO-8601 instant; anything else in a timestamp key is treated as withheld.
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/** Read a string field, returning null for anything that is not a non-empty string. */
function readString(record: RawRecord, key: string): string | null {
	const value = record[key];
	return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** Read an ISO-8601 timestamp field; reject anything else so hostile text cannot ride a timestamp key. */
function readTimestamp(record: RawRecord | null, key: string): string | null {
	if (!record) return null;
	const value = readString(record, key);
	return value && ISO_TIMESTAMP.test(value) ? value : null;
}

/** Collapse to a single line, strip control chars, and length-cap. */
function sanitizeLine(value: string, maxLen: number): string {
	const cleaned = value
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return cleaned.length > maxLen ? `${cleaned.slice(0, maxLen - 1)}…` : cleaned;
}

function indexBySessionId(records: RawRecord[]): Map<string, RawRecord> {
	const index = new Map<string, RawRecord>();
	for (const record of records) {
		const id = readString(record, "session_id");
		if (id) index.set(id, record);
	}
	return index;
}

/** Most recent active or otherwise relevant turn for a session. */
function turnsForSession(turns: RawRecord[], sessionId: string): RawRecord[] {
	return turns
		.filter(turn => readString(turn, "session_id") === sessionId)
		.sort((a, b) => (readString(a, "updated_at") ?? "").localeCompare(readString(b, "updated_at") ?? ""));
}

function activeTurnOf(sessionTurns: RawRecord[]): RawRecord | null {
	for (let i = sessionTurns.length - 1; i >= 0; i--) {
		const status = readString(sessionTurns[i] as RawRecord, "status");
		if (status && ACTIVE_TURN_STATUSES.has(status)) return sessionTurns[i] as RawRecord;
	}
	return null;
}

/** Derive the bounded status enum from session state and the active turn. */
export function deriveStatus(sessionState: RawRecord | null, activeTurn: RawRecord | null): SessionStatus {
	if (sessionState && sessionState.live === false) return "offline";
	const state = sessionState ? readString(sessionState, "state") : null;
	const turnStatus = activeTurn ? readString(activeTurn, "status") : null;
	if (turnStatus === "waiting_for_answer" || state === "needs_user_input" || state === "errored") return "blocked";
	if (activeTurn || state === "running") return "working";
	return "idle";
}

/** Derive the bounded turn-activity enum, with no turn body or content. */
export function deriveTurnActivity(sessionTurns: RawRecord[], activeTurn: RawRecord | null): TurnActivity {
	if (activeTurn) {
		return readString(activeTurn, "status") === "waiting_for_answer" ? "waiting_for_answer" : "active";
	}
	if (sessionTurns.some(turn => readString(turn, "status") === "queued")) return "queued";
	if (sessionTurns.some(turn => TERMINAL_TURN_STATUSES.has(readString(turn, "status") ?? ""))) return "terminal";
	return "none";
}

function deriveName(session: RawRecord, sessionId: string, branch: string | null): string {
	const repo = readString(session, "repo");
	if (repo && branch) return sanitizeLine(`${repo}@${branch}`, NAME_MAX_LEN);
	return sanitizeLine(sessionId, NAME_MAX_LEN);
}

function deriveBranch(session: RawRecord, sessionState: RawRecord | null): string | null {
	const branch = readString(session, "branch") ?? (sessionState ? readString(sessionState, "branch") : null);
	return branch ? sanitizeLine(branch, BRANCH_MAX_LEN) : null;
}

function deriveLastActivity(session: RawRecord, sessionState: RawRecord | null): string | null {
	return (
		readTimestamp(sessionState, "updated_at") ??
		readTimestamp(session, "updated_at") ??
		readTimestamp(session, "created_at")
	);
}

function deriveBlocker(sessionState: RawRecord | null, status: SessionStatus): string | null {
	if (status !== "blocked" || !sessionState) return null;
	const reason = readString(sessionState, "reason");
	return reason ? sanitizeLine(reason, BLOCKER_MAX_LEN) : null;
}

/** Shared, allowlisted derivation for a single coordinator session. */
interface DerivedSession {
	sessionId: string;
	name: string;
	status: SessionStatus;
	branch: string | null;
	lastActivityAt: string | null;
	sessionState: RawRecord | null;
	sessionTurns: RawRecord[];
	activeTurn: RawRecord | null;
}

function deriveSession(session: RawRecord, sessionStates: RawRecord[], turns: RawRecord[]): DerivedSession | null {
	const sessionId = readString(session, "session_id");
	if (!sessionId) return null;
	const sessionState = indexBySessionId(sessionStates).get(sessionId) ?? null;
	const sessionTurns = turnsForSession(turns, sessionId);
	const activeTurn = activeTurnOf(sessionTurns);
	const branch = deriveBranch(session, sessionState);
	return {
		sessionId: sanitizeLine(sessionId, NAME_MAX_LEN),
		name: deriveName(session, sessionId, branch),
		status: deriveStatus(sessionState, activeTurn),
		branch,
		lastActivityAt: deriveLastActivity(session, sessionState),
		sessionState,
		sessionTurns,
		activeTurn,
	};
}

/** Project one coordinator session into the allowlisted list summary. */
export function projectSessionSummary(
	session: RawRecord,
	sessionStates: RawRecord[],
	turns: RawRecord[],
): SessionSummary | null {
	const derived = deriveSession(session, sessionStates, turns);
	if (!derived) return null;
	// Field-by-field projection: only allowlisted fields are copied.
	return {
		sessionId: derived.sessionId,
		name: derived.name,
		status: derived.status,
		branch: derived.branch,
		lastActivityAt: derived.lastActivityAt,
	};
}

/** Project one coordinator session into the allowlisted open-session view. */
export function projectSessionView(
	session: RawRecord,
	sessionStates: RawRecord[],
	turns: RawRecord[],
): SessionView | null {
	const derived = deriveSession(session, sessionStates, turns);
	if (!derived) return null;
	// Field-by-field projection: never spread, so the chat surface cannot silently widen.
	return {
		sessionId: derived.sessionId,
		name: derived.name,
		status: derived.status,
		branch: derived.branch,
		lastActivityAt: derived.lastActivityAt,
		activeTurn: deriveTurnActivity(derived.sessionTurns, derived.activeTurn),
		blockerSummary: deriveBlocker(derived.sessionState, derived.status),
	};
}

/** Project the whole coordination status into list summaries. */
export function projectSessionSummaries(status: CoordinationStatus): SessionSummary[] {
	return status.sessions
		.map(session => projectSessionSummary(session, status.sessionStates, status.turns))
		.filter((summary): summary is SessionSummary => summary !== null);
}

/** Find and project a single session by id. */
export function findSessionView(status: CoordinationStatus, sessionId: string): SessionView | null {
	const session = status.sessions.find(record => readString(record, "session_id") === sessionId);
	return session ? projectSessionView(session, status.sessionStates, status.turns) : null;
}

/** The coordinator turn id of a session's active turn, for `/stop`. */
export function activeTurnId(status: CoordinationStatus, sessionId: string): string | null {
	const activeTurn = activeTurnOf(turnsForSession(status.turns, sessionId));
	return activeTurn ? readString(activeTurn, "turn_id") : null;
}

/** Render the allowlisted summaries into a concise chat message. */
export function renderSessionsList(summaries: SessionSummary[]): string {
	if (summaries.length === 0) return MESSAGES.noSessions;
	return summaries
		.map(summary => {
			const branch = summary.branch ? ` · ${summary.branch}` : "";
			return `• ${summary.name} · ${summary.status}${branch}\n  ${summary.sessionId}`;
		})
		.join("\n");
}

/** Render the allowlisted open-session view into a concise chat message. */
export function renderSessionView(view: SessionView): string {
	const lines = [
		view.name,
		`id: ${view.sessionId}`,
		`status: ${view.status}`,
		`turn: ${view.activeTurn}`,
		`branch: ${view.branch ?? MESSAGES.withheld}`,
		`last: ${view.lastActivityAt ?? MESSAGES.withheld}`,
	];
	if (view.status === "blocked") {
		lines.push(`blocked: ${view.blockerSummary ?? MESSAGES.withheld}`);
	}
	return lines.join("\n");
}

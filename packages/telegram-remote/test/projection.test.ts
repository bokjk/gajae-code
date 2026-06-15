import { describe, expect, test } from "bun:test";
import {
	activeTurnId,
	deriveStatus,
	deriveTurnActivity,
	findSessionView,
	projectSessionSummaries,
	renderSessionsList,
	renderSessionView,
} from "../src/projection";
import type { CoordinationStatus, RawRecord } from "../src/types";

function status(parts: Partial<CoordinationStatus>): CoordinationStatus {
	return { ok: true, sessions: [], sessionStates: [], turns: [], ...parts };
}

describe("deriveStatus", () => {
	test("offline when liveness is false", () => {
		expect(deriveStatus({ session_id: "s", live: false, state: "running" }, null)).toBe("offline");
	});
	test("blocked on waiting_for_answer, needs_user_input, or errored", () => {
		expect(deriveStatus({ state: "running" }, { status: "waiting_for_answer" })).toBe("blocked");
		expect(deriveStatus({ state: "needs_user_input" }, null)).toBe("blocked");
		expect(deriveStatus({ state: "errored" }, null)).toBe("blocked");
	});
	test("working on active turn or running state", () => {
		expect(deriveStatus({ state: "ready_for_input" }, { status: "active" })).toBe("working");
		expect(deriveStatus({ state: "running" }, null)).toBe("working");
	});
	test("idle otherwise", () => {
		expect(deriveStatus({ state: "ready_for_input" }, null)).toBe("idle");
		expect(deriveStatus(null, null)).toBe("idle");
	});
});

describe("deriveTurnActivity", () => {
	test("classifies the active turn", () => {
		expect(deriveTurnActivity([{ status: "active" }], { status: "active" })).toBe("active");
		expect(deriveTurnActivity([{ status: "waiting_for_answer" }], { status: "waiting_for_answer" })).toBe(
			"waiting_for_answer",
		);
	});
	test("falls back to queued, terminal, then none", () => {
		expect(deriveTurnActivity([{ status: "queued" }], null)).toBe("queued");
		expect(deriveTurnActivity([{ status: "completed" }], null)).toBe("terminal");
		expect(deriveTurnActivity([], null)).toBe("none");
	});
});

describe("transmitted-data allowlist (redaction)", () => {
	// A session record stuffed with everything that must NEVER reach chat.
	const hostileSession: RawRecord = {
		session_id: "sess-1",
		branch: "feat/x",
		repo: "proj",
		cwd: "/secret/abs/path/to/repo",
		model: "claude-opus-secret",
		tail_preview: ["SECRET_TAIL_LINE", "$ export TOKEN=sk-SECRET"],
		last_content: "RAW_SCROLLBACK_LINE",
		final_response: { text: "TRANSCRIPT_BODY_SECRET" },
		prompt: "USER_PROMPT_TEXT_SECRET",
		env: { TOKEN: "sk-SECRET", OPENAI_API_KEY: "sk-leak" },
	};
	const hostileState: RawRecord = {
		session_id: "sess-1",
		state: "running",
		live: true,
		updated_at: "2026-06-15T00:00:00.000Z",
		current_turn_id: "turn-1",
		reason: "INTERNAL_REASON_SECRET",
	};
	const hostileTurn: RawRecord = {
		session_id: "sess-1",
		status: "active",
		turn_id: "turn-1",
		prompt: { text: "PROMPT_BODY_SECRET" },
		final_response: { text: "RESPONSE_BODY_SECRET" },
	};
	const FORBIDDEN = [
		"SECRET_TAIL_LINE",
		"RAW_SCROLLBACK_LINE",
		"TRANSCRIPT_BODY_SECRET",
		"USER_PROMPT_TEXT_SECRET",
		"PROMPT_BODY_SECRET",
		"RESPONSE_BODY_SECRET",
		"sk-SECRET",
		"sk-leak",
		"/secret/abs/path/to/repo",
		"claude-opus-secret",
		"INTERNAL_REASON_SECRET",
	];

	const coordination = status({ sessions: [hostileSession], sessionStates: [hostileState], turns: [hostileTurn] });

	test("projected summary contains only allowlisted fields", () => {
		const [summary] = projectSessionSummaries(coordination);
		expect(summary).toEqual({
			sessionId: "sess-1",
			name: "proj@feat/x",
			status: "working",
			branch: "feat/x",
			lastActivityAt: "2026-06-15T00:00:00.000Z",
		});
		for (const secret of FORBIDDEN) {
			expect(JSON.stringify(summary)).not.toContain(secret);
		}
	});

	test("rendered list and view never leak forbidden content", () => {
		const summaries = projectSessionSummaries(coordination);
		const view = findSessionView(coordination, "sess-1");
		expect(view).not.toBeNull();
		const rendered = `${renderSessionsList(summaries)}\n${view ? renderSessionView(view) : ""}`;
		for (const secret of FORBIDDEN) {
			expect(rendered).not.toContain(secret);
		}
		// Allowlisted fields are present.
		expect(rendered).toContain("sess-1");
		expect(rendered).toContain("feat/x");
		expect(rendered).toContain("working");
	});

	test("a blocked session surfaces only a sanitized, capped reason", () => {
		const blocked = status({
			sessions: [{ session_id: "sess-2", branch: "main" }],
			sessionStates: [{ session_id: "sess-2", state: "errored", live: true, reason: "x".repeat(400) }],
			turns: [],
		});
		const view = findSessionView(blocked, "sess-2");
		expect(view?.status).toBe("blocked");
		expect((view?.blockerSummary ?? "").length).toBeLessThanOrEqual(120);
	});

	test("a non-ISO timestamp cannot ride the allowlisted lastActivityAt key", () => {
		const hostile = status({
			sessions: [{ session_id: "sess-3", branch: "main", created_at: "2026-06-15T00:00:00.000Z" }],
			sessionStates: [
				{ session_id: "sess-3", state: "running", live: true, updated_at: "INJECTED_NOT_A_TIMESTAMP" },
			],
			turns: [],
		});
		const [summary] = projectSessionSummaries(hostile);
		// The hostile updated_at is rejected; derivation falls back to the valid created_at.
		expect(summary?.lastActivityAt).toBe("2026-06-15T00:00:00.000Z");
		expect(JSON.stringify(summary)).not.toContain("INJECTED_NOT_A_TIMESTAMP");
	});

	test("activeTurnId returns the coordinator turn id for /stop", () => {
		expect(activeTurnId(coordination, "sess-1")).toBe("turn-1");
		expect(activeTurnId(coordination, "missing")).toBeNull();
	});
});

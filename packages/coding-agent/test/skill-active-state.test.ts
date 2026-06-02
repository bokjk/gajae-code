import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	applyHandoffToActiveState,
	CANONICAL_GJC_WORKFLOW_SKILLS,
	getSkillActiveStatePaths,
	listActiveSkills,
	normalizeSkillActiveState,
	readVisibleSkillActiveState,
	syncSkillActiveState,
} from "../src/skill-state/active-state";

async function withTempCwd(fn: (cwd: string) => Promise<void>): Promise<void> {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-skill-active-"));
	try {
		await fn(cwd);
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
}

describe("GJC skill-active state", () => {
	it("normalizes legacy top-level active state into active skills", () => {
		const state = normalizeSkillActiveState({ active: true, skill: "deep-interview", phase: "intent-first" });
		expect(state?.active_skills).toEqual([
			expect.objectContaining({ skill: "deep-interview", phase: "intent-first", active: true }),
		]);
	});

	it("ignores inactive and blank entries while deduping by skill and session", () => {
		const active = listActiveSkills({
			active_skills: [
				{ skill: "", active: true },
				{ skill: "team", active: false },
				{ skill: "ralplan", phase: "draft", session_id: "sess-a" },
				{ skill: "ralplan", phase: "review", session_id: "sess-a" },
				{ skill: "ralplan", phase: "root" },
			],
		});
		expect(active).toEqual([
			expect.objectContaining({ skill: "ralplan", phase: "review", session_id: "sess-a" }),
			expect.objectContaining({ skill: "ralplan", phase: "root" }),
		]);
	});

	it("writes root and session copies under .gjc/state", async () => {
		await withTempCwd(async cwd => {
			await syncSkillActiveState({
				cwd,
				skill: "team",
				phase: "running",
				active: true,
				sessionId: "sess-a",
				nowIso: "2026-05-27T00:00:00.000Z",
			});

			const paths = getSkillActiveStatePaths(cwd, "sess-a");
			expect(await fs.readFile(paths.rootPath, "utf8")).toContain("team");
			expect(paths.sessionPath).toBeDefined();
			expect(await fs.readFile(paths.sessionPath ?? "", "utf8")).toContain("running");
		});
	});

	it("encodes session ids before using them as state path segments", async () => {
		await withTempCwd(async cwd => {
			const paths = getSkillActiveStatePaths(cwd, "../escape/session");
			expect(paths.sessionPath).toBe(
				path.join(cwd, ".gjc", "state", "sessions", "%2E%2E%2Fescape%2Fsession", "skill-active-state.json"),
			);
		});
	});

	it("filters root fallback entries to the current session", async () => {
		await withTempCwd(async cwd => {
			await syncSkillActiveState({ cwd, skill: "team", active: true, phase: "running", sessionId: "sess-a" });
			await syncSkillActiveState({
				cwd,
				skill: "deep-interview",
				active: true,
				phase: "intent",
				sessionId: "sess-b",
			});

			const visible = await readVisibleSkillActiveState(cwd, "sess-b");
			expect(visible?.active_skills?.map(entry => entry.skill)).toEqual(["deep-interview"]);
		});
	});

	it("clears only the matching session entry", async () => {
		await withTempCwd(async cwd => {
			await syncSkillActiveState({ cwd, skill: "team", active: true, sessionId: "sess-a" });
			await syncSkillActiveState({ cwd, skill: "team", active: true, sessionId: "sess-b" });
			await syncSkillActiveState({ cwd, skill: "team", active: false, sessionId: "sess-a" });

			const sessionA = await readVisibleSkillActiveState(cwd, "sess-a");
			const sessionB = await readVisibleSkillActiveState(cwd, "sess-b");
			expect(sessionA).toBeNull();
			expect(sessionB?.active_skills?.map(entry => entry.session_id)).toEqual(["sess-b"]);
		});
	});

	it("does not derive a stale flag for aged entries without explicit deactivation", async () => {
		await withTempCwd(async cwd => {
			await syncSkillActiveState({
				cwd,
				skill: "team",
				active: true,
				sessionId: "sess-old",
				nowIso: "2000-01-01T00:00:00.000Z",
			});

			const visible = await readVisibleSkillActiveState(cwd, "sess-old");
			const entry = visible?.active_skills?.[0];
			expect(entry?.skill).toBe("team");
			expect(entry?.stale).toBeUndefined();
		});
	});

	it("normalizes and preserves HUD summaries during root/session merge", async () => {
		await withTempCwd(async cwd => {
			await syncSkillActiveState({
				cwd,
				skill: "deep-interview",
				active: true,
				phase: "interviewing",
				sessionId: "sess-hud",
				nowIso: new Date().toISOString(),
				hud: {
					version: 1,
					summary: "round\tone",
					chips: [{ label: "ambiguity\n", value: "15%", priority: 10, severity: "success" }],
					details: Array.from({ length: 20 }, (_, index) => ({ label: `d${index}`, value: "x" })),
				},
			});

			const visible = await readVisibleSkillActiveState(cwd, "sess-hud");
			const entry = visible?.active_skills?.[0];
			expect(entry?.hud?.summary).toBe("round one");
			expect(entry?.hud?.chips?.[0]).toEqual({
				label: "ambiguity",
				value: "15%",
				priority: 10,
				severity: "success",
			});
			expect(entry?.hud?.details?.length).toBe(12);
		});
	});

	it("shows only the callee when a skill is seeded session-less then handed off under a session", async () => {
		await withTempCwd(async cwd => {
			// `gjc deep-interview` run without --session-id seeds a global row, then
			// the in-TUI skill chain hands off under a concrete session id. The
			// demotion must supersede the global row so the HUD stops showing the
			// already-handed-off skill.
			await syncSkillActiveState({ cwd, skill: "deep-interview", phase: "interviewing", active: true });
			await applyHandoffToActiveState({
				cwd,
				strict: true,
				caller: {
					cwd,
					skill: "deep-interview",
					active: false,
					phase: "handoff",
					sessionId: "sess1",
					handoff_to: "ralplan",
				},
				callee: {
					cwd,
					skill: "ralplan",
					active: true,
					phase: "planner",
					sessionId: "sess1",
					handoff_from: "deep-interview",
				},
			});

			const visible = await readVisibleSkillActiveState(cwd, "sess1");
			expect(visible?.active_skills?.map(entry => entry.skill)).toEqual(["ralplan"]);
		});
	});

	it("does not demote a same-skill row owned by a different session during handoff", async () => {
		await withTempCwd(async cwd => {
			await syncSkillActiveState({ cwd, skill: "ralplan", phase: "planner", active: true, sessionId: "sessB" });
			await syncSkillActiveState({
				cwd,
				skill: "deep-interview",
				phase: "interviewing",
				active: true,
				sessionId: "sessA",
			});
			await applyHandoffToActiveState({
				cwd,
				strict: true,
				caller: {
					cwd,
					skill: "deep-interview",
					active: false,
					phase: "handoff",
					sessionId: "sessA",
					handoff_to: "ralplan",
				},
				callee: {
					cwd,
					skill: "ralplan",
					active: true,
					phase: "planner",
					sessionId: "sessA",
					handoff_from: "deep-interview",
				},
			});

			const sessionA = await readVisibleSkillActiveState(cwd, "sessA");
			const sessionB = await readVisibleSkillActiveState(cwd, "sessB");
			expect(sessionA?.active_skills?.map(entry => entry.skill)).toEqual(["ralplan"]);
			expect(sessionB?.active_skills?.map(entry => entry.skill)).toEqual(["ralplan"]);
		});
	});

	it("self-heals a stale active row left in an on-disk state file", async () => {
		await withTempCwd(async cwd => {
			const { rootPath } = getSkillActiveStatePaths(cwd, "sess1");
			await fs.mkdir(path.dirname(rootPath), { recursive: true });
			await fs.writeFile(
				rootPath,
				JSON.stringify({
					version: 1,
					active: true,
					skill: "deep-interview",
					active_skills: [
						{
							skill: "deep-interview",
							phase: "interviewing",
							active: true,
							updated_at: "2026-01-01T00:00:00.000Z",
						},
						{
							skill: "deep-interview",
							phase: "handoff",
							active: false,
							session_id: "sess1",
							updated_at: "2026-01-01T00:01:00.000Z",
							handoff_to: "ralplan",
						},
						{
							skill: "ralplan",
							phase: "handoff",
							active: false,
							session_id: "sess1",
							updated_at: "2026-01-01T00:02:00.000Z",
							handoff_to: "ultragoal",
						},
						{
							skill: "ultragoal",
							phase: "executing",
							active: true,
							session_id: "sess1",
							updated_at: "2026-01-01T00:03:00.000Z",
						},
					],
				}),
			);

			const visible = await readVisibleSkillActiveState(cwd, "sess1");
			expect(visible?.active_skills?.map(entry => entry.skill)).toEqual(["ultragoal"]);
		});
	});

	it("supersedes an upstream pipeline skill when a later stage is activated without a handoff verb", async () => {
		await withTempCwd(async cwd => {
			// `gjc ralplan` then `gjc ultragoal` each activate their own row; the
			// ultragoal activation does not demote ralplan, so without the pipeline
			// collapse the HUD would render ralplan + ultragoal. Only the current
			// (most-recently-activated) stage should remain.
			await syncSkillActiveState({
				cwd,
				skill: "ralplan",
				phase: "final",
				active: true,
				source: "gjc-ralplan-native",
				nowIso: "2026-01-01T00:00:00.000Z",
			});
			await syncSkillActiveState({
				cwd,
				skill: "ultragoal",
				phase: "executing",
				active: true,
				source: "gjc-ultragoal",
				nowIso: "2026-01-01T00:05:00.000Z",
			});

			const visible = await readVisibleSkillActiveState(cwd);
			expect(visible?.active_skills?.map(entry => entry.skill)).toEqual(["ultragoal"]);
		});
	});

	it("keeps team alongside ultragoal since team is not part of the planning pipeline", async () => {
		await withTempCwd(async cwd => {
			await syncSkillActiveState({
				cwd,
				skill: "ultragoal",
				phase: "executing",
				active: true,
				nowIso: "2026-01-01T00:00:00.000Z",
			});
			await syncSkillActiveState({
				cwd,
				skill: "team",
				phase: "running",
				active: true,
				nowIso: "2026-01-01T00:05:00.000Z",
			});

			const visible = await readVisibleSkillActiveState(cwd);
			expect(visible?.active_skills?.map(entry => entry.skill).sort()).toEqual(["team", "ultragoal"]);
		});
	});

	it("keeps the canonical GJC workflow skill set intentionally small", () => {
		expect(CANONICAL_GJC_WORKFLOW_SKILLS).toEqual(["deep-interview", "ralplan", "ultragoal", "team"]);
	});
});

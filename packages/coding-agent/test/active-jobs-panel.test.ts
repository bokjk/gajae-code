import { describe, expect, test } from "bun:test";
import type { AsyncJobOutputSlice, AsyncJobOutputTailOptions } from "../src/async";
import { ActiveJobsPanelComponent, type ActiveJobsPanelController } from "../src/modes/components/active-jobs-panel";
import { COMPLETED_MONITOR_VISIBLE_MS } from "../src/modes/components/active-jobs-panel-model";
import type { JobRef } from "../src/modes/components/jobs-format";
import type { CronJobView, JobsSnapshot, MonitorJobView } from "../src/modes/jobs-observer";

const NOW = 5_000_000;

function mon(over: Partial<MonitorJobView> = {}): MonitorJobView {
	return { id: "m", label: "tail server.log", status: "running", startTime: NOW - 4_000, ...over };
}

function cron(over: Partial<CronJobView> = {}): CronJobView {
	return {
		id: "c",
		humanSchedule: "every 5m",
		cronExpression: "*/5 * * * *",
		prompt: "review deploy queue",
		recurring: true,
		nextFireAt: NOW + 120_000,
		createdAt: NOW - 1_000,
		...over,
	};
}

function snap(over: Partial<JobsSnapshot> = {}): JobsSnapshot {
	return {
		monitors: [],
		crons: [],
		activeMonitorCount: 0,
		activeCronCount: 0,
		worstState: "none",
		failedUnacknowledged: false,
		...over,
	};
}

function makeController(snapshot: JobsSnapshot, tail = "tail line one\ntail line two\n"): ActiveJobsPanelController {
	return {
		getSnapshot: () => snapshot,
		getMonitorOutputTail: (id: string, _options: AsyncJobOutputTailOptions): AsyncJobOutputSlice | undefined => ({
			jobId: id,
			status: "running",
			text: tail,
			startOffset: 0,
			nextOffset: tail.length,
			truncated: false,
		}),
	};
}

function makePanel(snapshot: JobsSnapshot, tail?: string) {
	const controller = makeController(snapshot, tail);
	let renders = 0;
	const focus = { self: 0, editor: 0 };
	const managed: JobRef[] = [];
	const panel = new ActiveJobsPanelComponent(controller, {
		requestRender: () => {
			renders++;
		},
		now: () => NOW,
		focusSelf: () => {
			focus.self++;
		},
		focusEditor: () => {
			focus.editor++;
		},
		openManageJob: ref => {
			managed.push(ref);
		},
	});
	panel.setSnapshot(snapshot);
	return {
		panel,
		focus,
		managed,
		get renders() {
			return renders;
		},
	};
}

describe("ActiveJobsPanelComponent", () => {
	test("renders nothing when no jobs are visible", () => {
		const { panel } = makePanel(snap());
		expect(panel.isVisible()).toBe(false);
		expect(panel.render(80)).toEqual([]);
		panel.dispose();
	});

	test("auto-shows a collapsed panel when a monitor or cron exists", () => {
		const { panel } = makePanel(snap({ monitors: [mon({ id: "m", label: "tail app.log" })] }));
		expect(panel.isVisible()).toBe(true);
		const lines = panel.render(80);
		expect(lines[0]).toContain("Active jobs (1)");
		expect(lines.join("\n")).toContain("tail app.log");
		expect(lines.join("\n")).toContain("running");
		panel.dispose();
	});

	test("collapsed panel caps at 4 rows and shows +N more", () => {
		const monitors = Array.from({ length: 6 }, (_, i) => mon({ id: `m${i}`, startTime: NOW - i }));
		const { panel } = makePanel(snap({ monitors }));
		const lines = panel.render(120);
		const jobRows = lines.filter(l => l.includes("monitor ·"));
		expect(jobRows).toHaveLength(4);
		expect(lines.join("\n")).toContain("+2 more");
		panel.dispose();
	});

	test("expands (taking focus) and shows the live monitor tail; collapse returns focus", () => {
		const { panel, focus } = makePanel(snap({ monitors: [mon({ id: "m", label: "tail x" })] }));
		expect(panel.isExpanded()).toBe(false);
		panel.onExpandUp();
		expect(panel.isExpanded()).toBe(true);
		expect(focus.self).toBe(1); // panel grabbed focus on expand
		expect(panel.selectedRef()).toEqual({ kind: "monitor", id: "m" });
		const expanded = panel.render(80).join("\n");
		expect(expanded).toContain("enter manage");
		expect(expanded).toContain("› monitor · tail x");
		expect(expanded).toContain("tail line two");
		panel.collapse();
		expect(panel.isExpanded()).toBe(false);
		expect(focus.editor).toBe(1); // focus handed back to the editor
		panel.dispose();
	});

	test("expand is a no-op when nothing is visible", () => {
		const { panel } = makePanel(snap());
		panel.onExpandUp();
		expect(panel.isExpanded()).toBe(false);
		expect(panel.render(80)).toEqual([]);
		panel.dispose();
	});

	test("a completed monitor past its TTL is filtered out", () => {
		const expired = mon({ id: "done", status: "completed", endTime: NOW - COMPLETED_MONITOR_VISIBLE_MS });
		const { panel } = makePanel(snap({ monitors: [expired] }));
		expect(panel.isVisible()).toBe(false);
		expect(panel.render(80)).toEqual([]);
		panel.dispose();
	});

	test("setSnapshot to empty hides and resets expansion", () => {
		const { panel } = makePanel(snap({ crons: [cron()] }));
		panel.onExpandUp();
		expect(panel.isExpanded()).toBe(true);
		panel.setSnapshot(snap());
		expect(panel.isVisible()).toBe(false);
		expect(panel.isExpanded()).toBe(false);
		panel.dispose();
	});
	test("arrow-down moves the selection through every job to the last; collapse returns to editor", () => {
		const monitors = Array.from({ length: 15 }, (_, i) =>
			mon({ id: `m${i}`, label: `mon${i}`, status: "running", startTime: NOW - i }),
		);
		const crons = Array.from({ length: 50 }, (_, i) =>
			cron({ id: `c${i}`, prompt: `promptnum${i}`, createdAt: NOW - i }),
		);
		const { panel, focus } = makePanel(snap({ monitors, crons }));
		panel.setMaxRows(8); // small window forces real scrolling
		panel.onExpandUp();
		expect(panel.isExpanded()).toBe(true);
		expect(panel.selectedRef()).toEqual({ kind: "monitor", id: "m0" }); // first job selected

		const seen: string[] = [];
		let guard = 0;
		while (panel.selectedRef()?.id !== "c49" && guard++ < 500) {
			seen.push(...panel.render(120));
			panel.onCollapseDown(); // arrow-down moves the selection
		}
		seen.push(...panel.render(120));
		// selection reached the last job and its row is rendered/scrolled into view
		expect(panel.selectedRef()).toEqual({ kind: "cron", id: "c49" });
		expect(seen.some(line => line.includes("promptnum49"))).toBe(true);

		panel.collapse();
		expect(panel.isExpanded()).toBe(false);
		expect(focus.editor).toBeGreaterThan(0);
		panel.dispose();
	});

	test("Enter on the selected job opens the manage overlay and collapses the panel", () => {
		const { panel, managed } = makePanel(
			snap({
				monitors: [mon({ id: "build", label: "npm run build", status: "running" })],
				crons: [cron({ id: "pr" })],
			}),
		);
		panel.onExpandUp();
		expect(panel.selectedRef()).toEqual({ kind: "monitor", id: "build" });
		panel.activateSelected();
		expect(managed).toEqual([{ kind: "monitor", id: "build" }]);
		expect(panel.isExpanded()).toBe(false);
		panel.dispose();
	});

	test("handleInput routes Escape to collapse while focused", () => {
		const { panel, focus } = makePanel(snap({ crons: [cron({ id: "pr" })] }));
		panel.onExpandUp();
		expect(panel.isExpanded()).toBe(true);
		panel.handleInput("\x1b"); // Escape
		expect(panel.isExpanded()).toBe(false);
		expect(focus.editor).toBeGreaterThan(0);
		panel.dispose();
	});

	test("collapsed render never exceeds the max-row budget", () => {
		const monitors = Array.from({ length: 6 }, (_, i) => mon({ id: `m${i}`, startTime: NOW - i }));
		const { panel } = makePanel(snap({ monitors }));
		for (const max of [1, 2, 3, 5, 10]) {
			panel.setMaxRows(max);
			const lines = panel.render(120);
			expect(lines.length).toBeLessThanOrEqual(max);
			expect(lines[0]).toContain("Active jobs");
		}
		panel.dispose();
	});
	test("requests a render and clears itself when the last job expires at its TTL deadline", async () => {
		let nowValue = NOW;
		const expiringSoon = mon({ id: "done", status: "completed", endTime: NOW - (COMPLETED_MONITOR_VISIBLE_MS - 60) });
		const snapshot = snap({ monitors: [expiringSoon] });
		const controller = makeController(snapshot);
		let renders = 0;
		const panel = new ActiveJobsPanelComponent(controller, { requestRender: () => renders++, now: () => nowValue });
		panel.setSnapshot(snapshot);
		expect(panel.isVisible()).toBe(true);
		const before = renders;
		// Advance time past the completed TTL; the scheduled boundary timer must
		// redraw (clearing the panel) even though no observer event fires.
		nowValue = NOW + 200;
		await new Promise(resolve => setTimeout(resolve, 160));
		expect(renders).toBeGreaterThan(before);
		expect(panel.isVisible()).toBe(false);
		expect(panel.render(80)).toEqual([]);
		panel.dispose();
	});
});

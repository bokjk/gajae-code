/**
 * Inline panel that visualizes active monitor/cron jobs directly below the
 * input. It auto-surfaces whenever the filtered snapshot has any visible job and
 * hides otherwise.
 *
 * Two modes:
 * - Collapsed (default, passive): a compact glance list; never steals focus and
 *   never offers destructive actions.
 * - Expanded (ctrl+up): the panel takes focus and becomes a selectable list —
 *   arrows move the selection, Enter opens the existing alt+j "Manage Jobs"
 *   overlay focused on the selected job (where cancel/delete live behind a
 *   confirm), and Esc collapses + returns focus to the editor. The panel itself
 *   still never cancels/deletes or acknowledges failures.
 *
 * Rendering and visibility derive from the pure model in
 * `active-jobs-panel-model`. The component owns side effects only: focus
 * handoff, a minute/TTL-boundary label refresh, and a bounded live-tail poll
 * while expanded.
 */
import { Container, matchesKey } from "@gajae-code/tui";
import type { AsyncJobOutputSlice, AsyncJobOutputTailOptions } from "../../async";
import { EMPTY_JOBS_SNAPSHOT, type JobsSnapshot } from "../jobs-observer";
import {
	buildCollapsedRows,
	buildExpandedFlat,
	buildExpandedWindow,
	COLLAPSED_JOB_ROW_CAP,
	COMPLETED_MONITOR_VISIBLE_MS,
	clampScrollOffset,
	FAILED_MONITOR_VISIBLE_MS,
	filterVisibleJobs,
	hasVisibleJobs,
	listVisibleJobRefs,
	TAIL_MAX_BYTES,
	TAIL_MAX_LINES_PER_MONITOR,
	TAIL_POLL_MS,
} from "./active-jobs-panel-model";
import type { JobRef } from "./jobs-format";

/** Read-only data access the panel needs (a `JobsObserver` subset). */
export interface ActiveJobsPanelController {
	getSnapshot(): JobsSnapshot;
	getMonitorOutputTail(id: string, options: AsyncJobOutputTailOptions): AsyncJobOutputSlice | undefined;
}

export interface ActiveJobsPanelCallbacks {
	requestRender(): void;
	/** Injectable clock for deterministic tests; defaults to Date.now. */
	now?(): number;
	/** Give the panel input focus (so arrows/Enter/Esc route to it) when it expands. */
	focusSelf?(): void;
	/** Return focus to the editor when the panel collapses. */
	focusEditor?(): void;
	/** Open the alt+j Manage Jobs overlay focused on the given job (cancel/delete + confirm). */
	openManageJob?(ref: JobRef): void;
}

/** Default max rows the expanded panel may occupy (interactive-mode tightens this from terminal height). */
const DEFAULT_MAX_ROWS = 10;
const MS_PER_MINUTE = 60_000;

export class ActiveJobsPanelComponent extends Container {
	/** Set by the TUI when focus changes (Focusable). */
	focused = false;

	readonly #controller: ActiveJobsPanelController;
	readonly #requestRender: () => void;
	readonly #now: () => number;
	readonly #focusSelf: (() => void) | undefined;
	readonly #focusEditor: (() => void) | undefined;
	readonly #openManageJob: ((ref: JobRef) => void) | undefined;

	#snapshot: JobsSnapshot = EMPTY_JOBS_SNAPSHOT;
	#expanded = false;
	#scrollOffset = 0;
	#maxRows = DEFAULT_MAX_ROWS;
	#disposed = false;
	#selectedRef: JobRef | undefined;
	/** Cached last-N tail lines per monitor id (only for visible expanded rows). */
	readonly #tailLines = new Map<string, string[]>();
	#visibleMonitorIds: string[] = [];
	#labelTimer: ReturnType<typeof setTimeout> | undefined;
	#tailTimer: ReturnType<typeof setInterval> | undefined;

	constructor(controller: ActiveJobsPanelController, callbacks: ActiveJobsPanelCallbacks) {
		super();
		this.#controller = controller;
		this.#requestRender = callbacks.requestRender;
		this.#now = callbacks.now ?? Date.now;
		this.#focusSelf = callbacks.focusSelf;
		this.#focusEditor = callbacks.focusEditor;
		this.#openManageJob = callbacks.openManageJob;
		this.#snapshot = controller.getSnapshot();
		this.#syncTimers();
	}

	/** Update the data snapshot, then reconcile visibility/selection/focus/timers. */
	setSnapshot(snapshot: JobsSnapshot): void {
		if (this.#disposed) return;
		this.#snapshot = snapshot;
		this.#reconcileAfterChange();
		this.#requestRender();
	}

	/**
	 * Single reconcile path shared by snapshot updates and the TTL/label timer.
	 * If the panel is no longer visible it auto-hides (and returns focus to the
	 * editor when it had focus); if it is visible and expanded it keeps the
	 * selection valid and on-screen. Always re-syncs timers.
	 */
	#reconcileAfterChange(): void {
		const now = this.#now();
		if (!hasVisibleJobs(this.#snapshot, now)) {
			this.#autoHide();
		} else if (this.#expanded) {
			this.#reconcileSelection();
			this.#ensureSelectedVisible(now);
		}
		this.#syncTimers();
	}

	/** Collapse because nothing is visible, returning focus to the editor if we held it. */
	#autoHide(): void {
		const hadFocus = this.#expanded || this.focused;
		this.#collapseState();
		if (hadFocus) this.#focusEditor?.();
	}

	/** Tighten the max panel height (interactive-mode feeds this from terminal rows). */
	setMaxRows(rows: number): void {
		this.#maxRows = Math.max(1, Math.floor(rows));
	}

	isVisible(): boolean {
		return hasVisibleJobs(this.#snapshot, this.#now());
	}

	isExpanded(): boolean {
		return this.#expanded;
	}

	/** The currently selected job while expanded (for tests/inspection). */
	selectedRef(): JobRef | undefined {
		return this.#expanded ? this.#selectedRef : undefined;
	}

	/** ctrl+up / up: expand from collapsed (and take focus), else move selection up. */
	onExpandUp(): void {
		if (this.#disposed || !this.isVisible()) return;
		if (!this.#expanded) {
			this.#expanded = true;
			this.#scrollOffset = 0;
			this.#reconcileSelection();
			this.#pollVisibleTails();
			this.#ensureSelectedVisible(this.#now());
			this.#focusSelf?.();
		} else {
			this.#move(-1);
		}
		this.#syncTimers();
		this.#requestRender();
	}

	/** ctrl+down / down: move selection down while expanded (no-op when collapsed). */
	onCollapseDown(): void {
		if (this.#disposed || !this.isVisible() || !this.#expanded) return;
		this.#move(1);
		this.#syncTimers();
		this.#requestRender();
	}

	/** Open the Manage Jobs overlay on the selected job, then collapse the panel. */
	activateSelected(): void {
		if (this.#disposed || !this.#expanded || !this.#selectedRef) return;
		const ref = this.#selectedRef;
		this.#collapseState();
		this.#syncTimers();
		this.#openManageJob?.(ref);
		this.#requestRender();
	}

	/** Collapse and hand focus back to the editor. */
	collapse(): void {
		if (!this.#expanded) return;
		this.#collapseState();
		this.#syncTimers();
		this.#focusEditor?.();
		this.#requestRender();
	}

	/** Focusable input handler: active only while the panel is expanded/focused. */
	handleInput(data: string): void {
		if (!this.#expanded) return;
		if (matchesKey(data, "up") || matchesKey(data, "ctrl+up")) {
			this.onExpandUp();
		} else if (matchesKey(data, "down") || matchesKey(data, "ctrl+down")) {
			this.onCollapseDown();
		} else if (matchesKey(data, "enter")) {
			this.activateSelected();
		} else if (matchesKey(data, "escape")) {
			this.collapse();
		}
	}

	#collapseState(): void {
		this.#expanded = false;
		this.#scrollOffset = 0;
		this.#selectedRef = undefined;
		this.#tailLines.clear();
		this.#visibleMonitorIds = [];
	}

	#reconcileSelection(): void {
		const refs = listVisibleJobRefs(this.#snapshot, this.#now());
		if (refs.length === 0) {
			this.#selectedRef = undefined;
			return;
		}
		const sel = this.#selectedRef;
		if (!sel || !refs.some(r => r.kind === sel.kind && r.id === sel.id)) {
			this.#selectedRef = refs[0];
		}
	}

	#move(delta: number): void {
		const now = this.#now();
		const refs = listVisibleJobRefs(this.#snapshot, now);
		if (refs.length === 0) return;
		const sel = this.#selectedRef;
		let idx = sel ? refs.findIndex(r => r.kind === sel.kind && r.id === sel.id) : 0;
		if (idx < 0) idx = 0;
		idx = Math.min(refs.length - 1, Math.max(0, idx + delta));
		this.#selectedRef = refs[idx];
		this.#ensureSelectedVisible(now);
	}

	#ensureSelectedVisible(now: number): void {
		const sel = this.#selectedRef;
		if (!sel) return;
		const flat = buildExpandedFlat(this.#snapshot, now, this.#tailRecord());
		const idx = flat.findIndex(
			r => (r.kind === "monitor" || r.kind === "cron") && r.kind === sel.kind && r.id === sel.id,
		);
		if (idx < 0) return;
		const budget = this.#expandedHeightBudget();
		if (idx < this.#scrollOffset) this.#scrollOffset = idx;
		else if (idx >= this.#scrollOffset + budget) this.#scrollOffset = idx - budget + 1;
		this.#scrollOffset = clampScrollOffset(this.#scrollOffset, flat.length, budget);
	}

	#expandedHeightBudget(): number {
		// Reserve one row for the header/scroll-indicator line.
		return Math.max(1, this.#maxRows - 1);
	}

	#tailRecord(): Record<string, string[]> {
		return Object.fromEntries(this.#tailLines);
	}

	render(width: number): string[] {
		const now = this.#now();
		if (!hasVisibleJobs(this.#snapshot, now)) return [];
		return this.#expanded ? this.#renderExpanded(width, now) : this.#renderCollapsed(width, now);
	}

	#renderCollapsed(width: number, now: number): string[] {
		const maxRows = Math.max(1, this.#maxRows);
		const full = buildCollapsedRows(this.#snapshot, now, { cap: COLLAPSED_JOB_ROW_CAP, width });
		const header = `Active jobs (${full.totalVisible}) — ctrl+↑ expand`;
		// On a tiny budget the header alone is the one-line summary.
		if (maxRows <= 1) return [header];
		// Reserve the header row; reserve one more for "+N more" only when needed.
		const rowBudget = maxRows - 1;
		let shown = full.rows.slice(0, rowBudget);
		let overflow = full.totalVisible - shown.length;
		if (overflow > 0 && shown.length === rowBudget) {
			shown = full.rows.slice(0, Math.max(0, rowBudget - 1));
			overflow = full.totalVisible - shown.length;
		}
		const lines: string[] = [header, ...shown.map(row => `  ${row.text}`)];
		if (overflow > 0) lines.push(`  +${overflow} more`);
		return lines;
	}

	#renderExpanded(width: number, now: number): string[] {
		const budget = this.#expandedHeightBudget();
		const win = buildExpandedWindow(this.#snapshot, now, this.#scrollOffset, budget, this.#tailRecord(), width);
		this.#visibleMonitorIds = win.visibleMonitorTailIds;
		// Keep internal scroll state aligned with the clamped window after job/tail churn.
		this.#scrollOffset = win.scrollOffset;
		const shownStart = win.totalRows === 0 ? 0 : win.scrollOffset + 1;
		const shownEnd = win.scrollOffset + win.visibleRows.length;
		const indicators = `${win.canScrollUp ? "↑" : " "}${win.canScrollDown ? "↓" : " "}`;
		const lines: string[] = [
			`Active jobs (${shownStart}-${shownEnd} of ${win.totalRows}) ${indicators} ↑↓ select · enter manage · esc close`,
		];
		const sel = this.#selectedRef;
		for (const row of win.visibleRows) {
			if (row.kind === "monitor-tail") {
				// Nest live-tail rows under their monitor with a deeper indent + marker.
				lines.push(`    ↳ ${row.text}`);
				continue;
			}
			const isSelected = sel !== undefined && row.kind === sel.kind && row.id === sel.id;
			lines.push(`${isSelected ? "› " : "  "}${row.text}`);
		}
		return lines;
	}

	#pollVisibleTails(): void {
		if (this.#disposed) return;
		// Determine which monitors are currently visible by building the window.
		const budget = this.#expandedHeightBudget();
		const win = buildExpandedWindow(this.#snapshot, this.#now(), this.#scrollOffset, budget, this.#tailRecord());
		this.#visibleMonitorIds = win.visibleMonitorTailIds;
		const live = new Set(this.#visibleMonitorIds);
		// Drop caches for monitors no longer in the window.
		for (const id of [...this.#tailLines.keys()]) {
			if (!live.has(id)) this.#tailLines.delete(id);
		}
		for (const id of this.#visibleMonitorIds) {
			const slice = this.#controller.getMonitorOutputTail(id, {
				maxBytes: TAIL_MAX_BYTES,
				maxLines: TAIL_MAX_LINES_PER_MONITOR,
			});
			const text = slice?.text ?? "";
			const lines = text.length === 0 ? [] : text.replace(/\n$/, "").split("\n").slice(-TAIL_MAX_LINES_PER_MONITOR);
			this.#tailLines.set(id, lines);
		}
	}

	#syncTimers(): void {
		if (this.#disposed) return; // never re-arm timers after teardown
		const visible = this.isVisible();
		// Minute/TTL-boundary label refresh while the panel is shown.
		if (visible && !this.#labelTimer) this.#scheduleLabelRefresh();
		if (!visible && this.#labelTimer) {
			clearTimeout(this.#labelTimer);
			this.#labelTimer = undefined;
		}
		// Live-tail poll only while expanded with at least one visible monitor row.
		const hasMonitors = visible && filterVisibleJobs(this.#snapshot, this.#now()).monitors.length > 0;
		const wantTail = hasMonitors && this.#expanded;
		if (wantTail && !this.#tailTimer) {
			this.#tailTimer = setInterval(() => {
				if (this.#disposed) return;
				this.#pollVisibleTails();
				if (this.#expanded) this.#ensureSelectedVisible(this.#now());
				this.#requestRender();
			}, TAIL_POLL_MS);
			this.#tailTimer.unref?.();
		}
		if (!wantTail && this.#tailTimer) {
			clearInterval(this.#tailTimer);
			this.#tailTimer = undefined;
		}
	}

	/**
	 * Next refresh delay: the earlier of the next minute label boundary and the
	 * nearest visible terminal-monitor TTL deadline, so completed/failed rows drop
	 * on time even without an upstream observer event.
	 */
	#nextRefreshDelay(now: number): number {
		let delay = MS_PER_MINUTE - (now % MS_PER_MINUTE);
		for (const monitor of filterVisibleJobs(this.#snapshot, now).monitors) {
			if (monitor.status === "running" || monitor.status === "paused" || monitor.endTime === undefined) continue;
			const ttl = monitor.status === "failed" ? FAILED_MONITOR_VISIBLE_MS : COMPLETED_MONITOR_VISIBLE_MS;
			const remaining = monitor.endTime + ttl - now;
			if (remaining > 0 && remaining < delay) delay = remaining;
		}
		return Math.max(1, delay);
	}

	#scheduleLabelRefresh(): void {
		const delay = this.#nextRefreshDelay(this.#now());
		this.#labelTimer = setTimeout(() => {
			if (this.#disposed) return;
			this.#labelTimer = undefined;
			// At the boundary, reconcile through the shared path: this collapses +
			// restores editor focus if the last job just expired, keeps the
			// selection valid otherwise, and re-arms timers (including this one).
			this.#reconcileAfterChange();
			this.#requestRender();
		}, delay);
		this.#labelTimer.unref?.();
	}

	dispose(): void {
		this.#disposed = true;
		if (this.#labelTimer) clearTimeout(this.#labelTimer);
		if (this.#tailTimer) clearInterval(this.#tailTimer);
		this.#labelTimer = undefined;
		this.#tailTimer = undefined;
		this.#tailLines.clear();
	}
}

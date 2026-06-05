/**
 * Session-level unattended control plane (#323 / G011 emission side).
 *
 * Bridges the gate EMISSION side (skill runtimes / ask tool emitting gates) to
 * the gate ANSWER side (the external agent's `workflow_gate_response` over RPC):
 *
 *  - `emitGate(input)` opens a gate on the durable broker, emits the gate frame
 *    to the transport, and returns a promise that resolves with the agent's
 *    answer once it arrives.
 *  - `resolveGate(response)` (called from RPC dispatch) validates + resolves the
 *    gate on the broker; the broker's `advance` hook resolves the pending
 *    `emitGate` promise with the answer.
 *
 * Also implements the dispatch-facing {@link RpcUnattendedControlPlane} so the
 * RPC server can route `negotiate_unattended` + `workflow_gate_response` here.
 */
import type {
	RpcUnattendedAccepted,
	RpcUnattendedDeclaration,
	RpcWorkflowGate,
	RpcWorkflowGateResolution,
	RpcWorkflowGateResponse,
} from "../../rpc/rpc-types";
import type { RpcUnattendedControlPlane } from "./command-dispatch";
import {
	type UnattendedAbortHooks,
	type UnattendedAuditEvent,
	UnattendedRunController,
} from "./unattended-run-controller";
import { type GateStore, MemoryGateStore, type OpenGateInput, WorkflowGateBroker } from "./workflow-gate-broker";

/** Minimal surface a skill runtime / ask tool uses to emit a gate and await its answer. */
export interface WorkflowGateEmitter {
	/** True only when unattended mode has been negotiated. */
	isUnattended(): boolean;
	/** Open + emit a gate; resolves with the agent's answer (from workflow_gate_response). */
	emitGate(input: OpenGateInput): Promise<unknown>;
}

export interface UnattendedSessionOptions {
	runId: string;
	sessionId?: string;
	/** Emit a workflow_gate frame to the transport so the agent receives it. */
	emitFrame: (gate: RpcWorkflowGate) => void;
	/** Durable gate store; defaults to in-memory. */
	store?: GateStore;
	/** Audit sink for controller + gate events. */
	audit?: (event: UnattendedAuditEvent | { event: string; [k: string]: unknown }) => void;
	abortHooks?: UnattendedAbortHooks;
	/** Whether the active provider reports token/cost usage (fail-closed when false/omitted). */
	providerSupportsTokenCostMetrics?: boolean;
}

export class UnattendedSessionControlPlane implements RpcUnattendedControlPlane, WorkflowGateEmitter {
	#controller: UnattendedRunController | undefined;
	#broker: WorkflowGateBroker | undefined;
	readonly #pending = new Map<string, { resolve: (answer: unknown) => void; reject: (err: Error) => void }>();

	constructor(private readonly opts: UnattendedSessionOptions) {}

	isUnattended(): boolean {
		return this.#controller !== undefined;
	}

	get controller(): UnattendedRunController | undefined {
		return this.#controller;
	}

	negotiate(declaration: RpcUnattendedDeclaration): RpcUnattendedAccepted {
		const controller = UnattendedRunController.negotiate(declaration, {
			runId: this.opts.runId,
			sessionId: this.opts.sessionId,
			audit: this.opts.audit,
			abortHooks: {
				...this.opts.abortHooks,
				// On abort (e.g. wall-time / budget breach) reject any gate still
				// awaiting an answer, so emitGate cannot hang forever.
				stopWorkflow: async reason => {
					await this.opts.abortHooks?.stopWorkflow?.(reason);
					this.#rejectAllPending(new Error(`unattended run aborted: ${reason}`));
				},
			},
			providerSupportsTokenCostMetrics: this.opts.providerSupportsTokenCostMetrics ?? true,
		});
		this.#controller = controller;
		this.#broker = new WorkflowGateBroker(this.opts.runId, this.opts.store ?? new MemoryGateStore(), {
			audit: e => this.opts.audit?.(e),
			advance: (gate, answer) => {
				const pending = this.#pending.get(gate.gate_id);
				if (pending) {
					this.#pending.delete(gate.gate_id);
					pending.resolve(answer);
				}
			},
		});
		return {
			run_id: this.opts.runId,
			actor: controller.actor,
			budget: controller.budget,
			scopes: [...controller.scopes],
			action_allowlist: [...controller.actionAllowlist],
			accepted_at: new Date().toISOString(),
		};
	}

	resolveGate(response: RpcWorkflowGateResponse): Promise<RpcWorkflowGateResolution> {
		if (!this.#broker) {
			return Promise.reject(new Error("workflow gates are not available until unattended mode is negotiated"));
		}
		return this.#broker.resolve(response);
	}

	emitGate(input: OpenGateInput): Promise<unknown> {
		if (!this.#broker) {
			return Promise.reject(new Error("cannot emit a workflow gate before unattended mode is negotiated"));
		}
		const gate = this.#broker.openGate(input);
		const promise = new Promise<unknown>((resolve, reject) => {
			this.#pending.set(gate.gate_id, { resolve, reject });
		});
		this.opts.emitFrame(gate);
		return promise;
	}

	#rejectAllPending(error: Error): void {
		for (const [gateId, pending] of this.#pending) {
			this.#pending.delete(gateId);
			pending.reject(error);
		}
	}
}

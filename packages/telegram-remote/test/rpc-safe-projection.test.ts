import { describe, expect, test } from "bun:test";
import type { RpcExtensionUIRequest, RpcWorkflowGate } from "@gajae-code/coding-agent/modes/rpc/rpc-types";
import {
	projectExtensionUiRequest,
	projectWorkflowGate,
	RPC_SENTINELS,
	renderRpcLiveCard,
	renderRpcOnboarding,
	safeCallbackAnswer,
	safeRpcLine,
} from "../src/rpc-safe-projection";
import type { AttachmentRecord } from "../src/types";

function hostileGate(): RpcWorkflowGate {
	return {
		type: "workflow_gate",
		gate_id: "gate-secret-1",
		stage: "ralplan",
		kind: "approval",
		schema: { type: "string" },
		schema_hash: "hash",
		options: [
			{ label: `Approve ${RPC_SENTINELS[0]}`, value: { raw: RPC_SENTINELS[1] } },
			{ label: "Reject", value: "reject" },
		],
		context: {
			title: `Deploy ${RPC_SENTINELS[4]}`,
			prompt: RPC_SENTINELS[0],
			summary: RPC_SENTINELS[3],
			stage_state: { raw: RPC_SENTINELS[10] },
			artifact_refs: [{ kind: "log", path: RPC_SENTINELS[8] }],
		},
		created_at: "2026-06-17T00:00:00Z",
		required: true,
	};
}

function assertNoSentinels(text: string): void {
	for (const sentinel of RPC_SENTINELS) expect(text).not.toContain(sentinel);
}

describe("rpc-safe-projection", () => {
	test("redacts forbidden sentinel strings from safe lines, callbacks, and onboarding", () => {
		const line = safeRpcLine(`before ${RPC_SENTINELS.join(" ")} after`, 500);
		const callback = safeCallbackAnswer(`done ${RPC_SENTINELS[5]}`);
		const onboarding = renderRpcOnboarding();
		assertNoSentinels(line);
		assertNoSentinels(callback);
		assertNoSentinels(onboarding);
		expect(onboarding).toContain("already-running local RPC session");
		expect(onboarding).toContain("host must stay awake");
	});

	test("workflow gates never project raw prompt, paths, secrets, or option payloads", () => {
		const projection = projectWorkflowGate(hostileGate(), 10, 1000);
		assertNoSentinels(projection.text);
		for (const option of projection.options) assertNoSentinels(option.label);
		expect(projection.text).toContain("approval");
		expect(projection.text).toContain("Choose an option below");
		expect(projection.summary.gateIdHash).toBeString();
		expect(projection.summary.dedupeKey).toStartWith("gate:");
		expect(JSON.stringify(projection.summary)).not.toContain("gate-secret-1");
		expect(JSON.stringify(projection.summary)).not.toContain(RPC_SENTINELS[1]);
	});

	test("extension UI cards sanitize displayed fields and persist only safe summaries", () => {
		const request: RpcExtensionUIRequest = {
			type: "extension_ui_request",
			id: "input-secret-id",
			method: "input",
			title: `Question ${RPC_SENTINELS[6]} ${RPC_SENTINELS[7]}`,
		};
		const projection = projectExtensionUiRequest(request, 20, 2000);
		expect(projection).not.toBeNull();
		assertNoSentinels(projection!.text);
		expect(projection!.summary?.requestIdHash).toBeString();
		expect(JSON.stringify(projection!.summary)).not.toContain("input-secret-id");
	});

	test("live cards show safe state without socket or backend object leakage", () => {
		const attachment: AttachmentRecord = {
			chatId: "900",
			userId: "100",
			socketPath: RPC_SENTINELS[7],
			stale: false,
			controllerState: "waiting_for_ui",
			liveness: { lastSeenAt: 5_000, timeoutMs: 60_000 },
			pendingGateIds: ["gate-secret-1"],
			deliveryIdentities: [],
			pendingActions: [
				{
					type: "workflow_gate",
					gateIdHash: "abc123",
					dedupeKey: "gate:abc123",
					label: `Approve ${RPC_SENTINELS[0]}`,
					createdAt: 0,
					expiresAt: 10_000,
					status: "pending",
				},
			],
			updatedAt: 5_000,
		};
		const card = renderRpcLiveCard({
			attachment,
			backendState: { connected: true, socketPath: RPC_SENTINELS[7], session: { raw: RPC_SENTINELS[9] } },
			now: 10_000,
			hostLabel: RPC_SENTINELS[4],
		});
		assertNoSentinels(card.text);
		expect(card.text).toContain("State: Attached");
		expect(card.text).toContain("Pending: 1");
		expect(card.fingerprint).toHaveLength(32);
	});
});

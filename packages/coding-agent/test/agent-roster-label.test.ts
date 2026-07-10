import { describe, expect, it } from "bun:test";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentRegistry } from "@gajae-code/coding-agent/registry/agent-registry";
import { createAgentSession } from "@gajae-code/coding-agent/sdk";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";

async function rosterLabelFor(options: { agentId: string; agentDisplayName: string; agentRosterLabel?: string }): Promise<string> {
	const registry = new AgentRegistry();
	const { session } = await createAgentSession({
		cwd: process.cwd(),
		settings: Settings.isolated(),
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		sessionManager: SessionManager.inMemory(process.cwd()),
		agentRegistry: registry,
		...options,
	});
	try {
		return registry.get(options.agentId)?.rosterLabel ?? "";
	} finally {
		await session.dispose();
	}
}

async function createRegisteredSession(registry: AgentRegistry, agentId: string) {
	return await createAgentSession({
		cwd: process.cwd(),
		settings: Settings.isolated(),
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		sessionManager: SessionManager.inMemory(process.cwd()),
		agentRegistry: registry,
		agentId,
	});
}

describe("agent roster labels", () => {
	it("sanitizes task descriptions and falls back through task id to display name", async () => {
		expect(
			await rosterLabelFor({
				agentId: "3-ReleaseNotes",
				agentDisplayName: "executor",
				agentRosterLabel: "  Prepare\nrelease\u0000 notes  ",
			}),
		).toBe("Prepare release notes");
		expect(
			await rosterLabelFor({ agentId: "3-ReleaseNotes", agentDisplayName: "executor", agentRosterLabel: "\n\u0000" }),
		).toBe("3 Release Notes");
		expect(
			await rosterLabelFor({ agentId: "\n\u0000", agentDisplayName: "executor", agentRosterLabel: "" }),
		).toBe("executor");
	});

	it("keeps child registration and roster visibility isolated by registry", async () => {
		const parentRegistry = new AgentRegistry();
		const otherRegistry = new AgentRegistry();
		const parent = await createRegisteredSession(parentRegistry, "0-Parent");
		const child = await createRegisteredSession(parentRegistry, "1-Child");
		const otherParent = await createRegisteredSession(otherRegistry, "0-Other");
		const otherChild = await createRegisteredSession(otherRegistry, "1-OtherChild");
		try {
			expect(parentRegistry.get("1-Child")?.session).toBe(child.session);
			expect(otherRegistry.get("1-Child")).toBeUndefined();
			expect(parentRegistry.listVisibleTo("0-Parent").map(peer => peer.id)).toEqual(["1-Child"]);
			expect(otherRegistry.listVisibleTo("0-Other").map(peer => peer.id)).toEqual(["1-OtherChild"]);
		} finally {
			await Promise.all([parent.session.dispose(), child.session.dispose(), otherParent.session.dispose(), otherChild.session.dispose()]);
		}
	});
});

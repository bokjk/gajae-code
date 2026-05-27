import { describe, expect, it } from "bun:test";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const agentsEntry = path.join(repoRoot, "packages", "coding-agent", "src", "task", "agents.ts");
const promptsDir = path.join(repoRoot, "packages", "coding-agent", "src", "prompts", "agents");

function extractEmbeddedAgentFileNames(source: string): string[] {
	const defsBlock = source.match(/const EMBEDDED_AGENT_DEFS: EmbeddedAgentDef\[\] = \[([\s\S]*?)\];/);
	if (!defsBlock) return [];
	return [...defsBlock[1].matchAll(/fileName: "([^"]+)"/g)].map(match => match[1]).sort();
}

describe("GJC bundled task agent surface", () => {
	it("ships only the retained four internal agent definitions", async () => {
		const source = await Bun.file(agentsEntry).text();
		expect(extractEmbeddedAgentFileNames(source)).toEqual(["explore.md", "plan.md", "reviewer.md", "task.md"]);

		const promptFiles = Array.from(new Bun.Glob("*.md").scanSync({ cwd: promptsDir })).sort();
		expect(promptFiles).toEqual(["explore.md", "frontmatter.md", "init.md", "plan.md", "reviewer.md", "task.md"]);
	});
});

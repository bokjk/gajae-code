import { describe, expect, it } from "bun:test";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const cliEntry = path.join(repoRoot, "packages", "coding-agent", "src", "cli.ts");

function extractRegisteredCommands(source: string): string[] {
	const commandsBlock = source.match(/const commands: CommandEntry\[\] = \[([\s\S]*?)\];/);
	if (!commandsBlock) return [];
	return [...commandsBlock[1].matchAll(/\{ name: "([^"]+)"/g)].map(match => match[1]);
}

describe("GJC public CLI command surface", () => {
	it("registers only launch plus retained workflow runtime endpoints", async () => {
		const source = await Bun.file(cliEntry).text();
		expect(extractRegisteredCommands(source)).toEqual([
			"question",
			"state",
			"team",
			"ultragoal",
			"ralplan",
			"deep-interview",
			"launch",
		]);
	});
});

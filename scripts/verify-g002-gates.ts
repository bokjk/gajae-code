#!/usr/bin/env bun

/**
 * Static verification helper for the G002 rebrand/MCP/local-tool gates.
 *
 * This script intentionally reports every gate before exiting non-zero when any
 * contract is still unmet. It is evidence-oriented: use it to support the team
 * verification lane without broad implementation changes.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const repoRoot = path.join(import.meta.dir, "..");
const EXPECTED_DEFINITIONS = ["deep-interview", "ralplan", "team", "ultragoal"] as const;
const REQUIRED_LOCAL_TOOL_FILES = [
	"packages/coding-agent/src/tools/read.ts",
	"packages/coding-agent/src/tools/write.ts",
	"packages/coding-agent/src/edit/index.ts",
	"packages/coding-agent/src/tools/bash.ts",
	"packages/coding-agent/src/tools/find.ts",
	"packages/coding-agent/src/tools/search.ts",
	"packages/coding-agent/src/tools/ast-grep.ts",
	"packages/coding-agent/src/tools/ast-edit.ts",
] as const;

interface GateResult {
	name: string;
	passed: boolean;
	details: string[];
}

const results: GateResult[] = [];

results.push(await verifyRebrandSurface());
results.push(await verifyVisibleDefinitions());
results.push(await verifyMcpQuarantine());
results.push(await verifyLocalToolsPreserved());
results.push(await verifyRustBoundary());

for (const result of results) {
	console.log(`${result.passed ? "PASS" : "FAIL"} ${result.name}`);
	for (const detail of result.details) {
		console.log(`  - ${detail}`);
	}
}

const failed = results.filter(result => !result.passed);
if (failed.length > 0) {
	console.error(`\nG002 gate verification failed: ${failed.map(result => result.name).join(", ")}`);
	process.exit(1);
}

console.log("\nG002 gate verification passed.");

async function verifyRebrandSurface(): Promise<GateResult> {
	const rootPackage = await readJson("package.json");
	const codingPackage = await readJson("packages/coding-agent/package.json");
	const bin = isRecord(codingPackage.bin) ? codingPackage.bin : {};
	const details: string[] = [];

	const rootName = typeof rootPackage.name === "string" ? rootPackage.name : "<missing>";
	const codingName = typeof codingPackage.name === "string" ? codingPackage.name : "<missing>";
	const hasGjcBin = typeof bin.gjc === "string";
	const hasLegacyOmpBin = "omp" in bin;

	details.push(`root package name: ${rootName}`);
	details.push(`coding-agent package name: ${codingName}`);
	details.push(`bin keys: ${Object.keys(bin).sort().join(", ") || "<none>"}`);

	return {
		name: "rebrand CLI/package surface",
		passed: rootName === "gajae-code" && codingName.includes("gajae") && hasGjcBin && !hasLegacyOmpBin,
		details,
	};
}

async function verifyVisibleDefinitions(): Promise<GateResult> {
	const visibleDefinitionRoots = [".omp/skills", ".omp/commands", ".codex/skills", ".codex/agents"];
	const discovered = new Set<string>();
	const details: string[] = [];

	for (const root of visibleDefinitionRoots) {
		const absolute = path.join(repoRoot, root);
		if (!fs.existsSync(absolute)) {
			details.push(`${root}: absent`);
			continue;
		}
		const entries = fs
			.readdirSync(absolute, { withFileTypes: true })
			.filter(entry => entry.isDirectory() || entry.name.endsWith(".md") || entry.name.endsWith(".toml"))
			.map(entry => entry.name.replace(/\.(md|toml)$/u, ""))
			.sort();
		for (const entry of entries) discovered.add(entry);
		details.push(`${root}: ${entries.join(", ") || "<empty>"}`);
	}

	const actual = [...discovered].sort();
	details.push(`expected visible definitions: ${EXPECTED_DEFINITIONS.join(", ")}`);
	details.push(`actual visible definitions: ${actual.join(", ") || "<none>"}`);

	return {
		name: "exact four visible definitions",
		passed: arraysEqual(actual, [...EXPECTED_DEFINITIONS].sort()),
		details,
	};
}

async function verifyMcpQuarantine(): Promise<GateResult> {
	const codingPackage = await readJson("packages/coding-agent/package.json");
	const exportsRecord = isRecord(codingPackage.exports) ? codingPackage.exports : {};
	const exportedMcpKeys = Object.keys(exportsRecord).filter(key => key === "./mcp" || key.startsWith("./mcp/"));
	const mcpPaths = [
		"packages/coding-agent/src/mcp",
		"packages/coding-agent/src/modes/controllers/mcp-command-controller.ts",
		"packages/coding-agent/src/modes/components/mcp-add-wizard.ts",
		"packages/coding-agent/src/mcp/discoverable-tool-metadata.ts",
	];
	const presentMcpPaths = mcpPaths.filter(relativePath => fs.existsSync(path.join(repoRoot, relativePath)));
	const details = [
		`exported MCP package keys: ${exportedMcpKeys.join(", ") || "<none>"}`,
		`present MCP runtime/UI paths: ${presentMcpPaths.join(", ") || "<none>"}`,
	];

	return {
		name: "MCP quarantine/no default discoverable MCP",
		passed: exportedMcpKeys.length === 0 && presentMcpPaths.length === 0,
		details,
	};
}

async function verifyLocalToolsPreserved(): Promise<GateResult> {
	const missing = REQUIRED_LOCAL_TOOL_FILES.filter(relativePath => !fs.existsSync(path.join(repoRoot, relativePath)));
	const toolIndex = await readText("packages/coding-agent/src/tools/index.ts");
	const requiredRegistryNames = ["read", "write", "edit", "bash", "find", "search", "ast_grep", "ast_edit"];
	const missingRegistryNames = requiredRegistryNames.filter(name => !toolIndex.includes(`${name}:`));

	return {
		name: "inline/local tools preserved",
		passed: missing.length === 0 && missingRegistryNames.length === 0,
		details: [
			`required local tool files missing: ${missing.join(", ") || "<none>"}`,
			`required local tool registry entries missing: ${missingRegistryNames.join(", ") || "<none>"}`,
		],
	};
}

async function verifyRustBoundary(): Promise<GateResult> {
	const runRsTask = await readText("scripts/run-rs-task.ts");
	const hasScopeHook = runRsTask.includes('runCommand(["bun", "scripts/check-rust-scope.ts"])');
	const hasScopeScript = fs.existsSync(path.join(repoRoot, "scripts/check-rust-scope.ts"));
	return {
		name: "TS/Rust boundary",
		passed: hasScopeHook && hasScopeScript,
		details: [
			`scripts/check-rust-scope.ts present: ${hasScopeScript}`,
			`check:rs invokes Rust scope guard: ${hasScopeHook}`,
		],
	};
}

async function readJson(relativePath: string): Promise<Record<string, unknown>> {
	const text = await readText(relativePath);
	return JSON.parse(text) as Record<string, unknown>;
}

async function readText(relativePath: string): Promise<string> {
	return Bun.file(path.join(repoRoot, relativePath)).text();
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

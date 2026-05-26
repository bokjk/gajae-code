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
const PUBLIC_DOC_FILES = ["README.md", "packages/coding-agent/README.md"] as const;
const FORBIDDEN_PUBLIC_DOC_PATTERNS: readonly RegExp[] = [
	/@oh-my-pi/u,
	/oh-my-pi/u,
	/pi-coding-agent/u,
	/omp\.sh/u,
	/qa\.omp\.sh/u,
	/MCP/u,
	/\/mcp/u,
	/mcp-config/u,
	/mcp-server/u,
];
const FORBIDDEN_SKILL_PATTERNS: readonly RegExp[] = [
	/\bomx\s+(team|state|question|ultragoal|ralplan|deep-interview)/u,
	/\$ralph/u,
	/\$autopilot/u,
	/\$autoresearch/u,
	/\$autoresearch-goal/u,
	/\$performance-goal/u,
	/\$ultraqa/u,
	/\$ultrawork/u,
	/MCP/u,
	/\/mcp/u,
];
const REQUIRED_PRIVATE_EXPORT_BLOCKS = [
	"./mcp",
	"./mcp/*",
	"./runtime-mcp",
	"./runtime-mcp/*",
	"./commands/gjc-runtime-bridge",
	"./capability/mcp",
	"./config/mcp-schema",
	"./discovery/mcp-json",
	"./exa/mcp-client",
	"./internal-urls/mcp-protocol",
	"./modes/components/runtime-mcp-add-wizard",
	"./modes/controllers/runtime-mcp-command-controller",
	"./slash-commands/helpers/mcp",
] as const;
const FORBIDDEN_PACKAGE_IMPORTS = [
	"@gajae-code/coding-agent/mcp",
	"@gajae-code/coding-agent/runtime-mcp/index",
	"@gajae-code/coding-agent/runtime-mcp/manager",
	"@gajae-code/coding-agent/commands/gjc-runtime-bridge",
	"@gajae-code/coding-agent/capability/mcp",
	"@gajae-code/coding-agent/config/mcp-schema",
	"@gajae-code/coding-agent/discovery/mcp-json",
	"@gajae-code/coding-agent/exa/mcp-client",
	"@gajae-code/coding-agent/internal-urls/mcp-protocol",
	"@gajae-code/coding-agent/modes/components/runtime-mcp-add-wizard",
	"@gajae-code/coding-agent/modes/controllers/runtime-mcp-command-controller",
	"@gajae-code/coding-agent/slash-commands/helpers/mcp",
] as const;
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
results.push(await verifyPublicDefinitionContent());
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
	const visibleDefinitionRoots = [
		".omp/skills",
		".codex/skills",
		".omp/agents",
		".codex/agents",
		".omp/commands",
		".codex/commands",
		".omp/rules",
		".codex/rules",
	];
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


async function verifyPublicDefinitionContent(): Promise<GateResult> {
	const findings: string[] = [];
	for (const definition of EXPECTED_DEFINITIONS) {
		const relativePath = `.omp/skills/${definition}/SKILL.md`;
		const text = await readText(relativePath);
		for (const pattern of FORBIDDEN_SKILL_PATTERNS) {
			if (pattern.test(text)) findings.push(`${relativePath}: ${pattern.source}`);
		}
	}

	return {
		name: "approved public skill content",
		passed: findings.length === 0,
		details: [`forbidden public skill references: ${findings.join(", ") || "<none>"}`],
	};
}

async function verifyMcpQuarantine(): Promise<GateResult> {
	const codingPackage = await readJson("packages/coding-agent/package.json");
	const exportsRecord = isRecord(codingPackage.exports) ? codingPackage.exports : {};
	const mcpExportKeys = Object.keys(exportsRecord).filter(key => key === "./mcp" || key.startsWith("./mcp/") || key === "./runtime-mcp" || key.startsWith("./runtime-mcp/") || key === "./commands/gjc-runtime-bridge");
	const exposedMcpKeys = mcpExportKeys.filter(key => exportsRecord[key] !== null);
	const blockedMcpKeys = REQUIRED_PRIVATE_EXPORT_BLOCKS.filter(key => exportsRecord[key] === null);
	const missingPrivateBlocks = REQUIRED_PRIVATE_EXPORT_BLOCKS.filter(key => exportsRecord[key] !== null);
	const builtinRegistry = await readText("packages/coding-agent/src/slash-commands/builtin-registry.ts");
	const acpBuiltins = await readText("packages/coding-agent/src/slash-commands/acp-builtins.ts");
	const exposesMcpBuiltin = /name:\s*["']mcp["']/.test(builtinRegistry);
	const importsMcpBuiltinHandler = builtinRegistry.includes("handleMcpAcp");
	const acpReferencesMcpHandler = acpBuiltins.includes("handleMcpAcp");
	const acpAdvertisesMcpCommand = /name:\s*["']mcp["']/.test(acpBuiltins);
	const internalMcpPaths = [
		"packages/coding-agent/src/runtime-mcp",
		"packages/coding-agent/src/slash-commands/helpers/mcp.ts",
	];
	const presentInternalMcpPaths = internalMcpPaths.filter(relativePath => fs.existsSync(path.join(repoRoot, relativePath)));
	const publicDocFindings = await findPublicDocFindings();
	const forbiddenImportFindings = await probeForbiddenPackageImports();
	const removedPublicDocsStillPresent = [
		"docs/mcp-config.md",
		"docs/mcp-runtime-lifecycle.md",
		"docs/mcp-server-tool-authoring.md",
		"docs/mcp-protocol-transports.md",
	].filter(relativePath => fs.existsSync(path.join(repoRoot, relativePath)));
	const details = [
		`exposed private package keys: ${exposedMcpKeys.join(", ") || "<none>"}`,
		`blocked private package keys: ${blockedMcpKeys.join(", ") || "<none>"}`,
		`missing private export blocks: ${missingPrivateBlocks.join(", ") || "<none>"}`,
		`default /mcp builtin registered: ${exposesMcpBuiltin}`,
		`default /mcp handler imported: ${importsMcpBuiltinHandler}`,
		`ACP /mcp command advertised: ${acpAdvertisesMcpCommand}`,
		`ACP MCP handler referenced: ${acpReferencesMcpHandler}`,
		`private MCP implementation paths retained: ${presentInternalMcpPaths.join(", ") || "<none>"}`,
		`public doc findings: ${publicDocFindings.join(", ") || "<none>"}`,
		`forbidden package imports still resolving: ${forbiddenImportFindings.join(", ") || "<none>"}`,
		`removed public MCP docs still present: ${removedPublicDocsStillPresent.join(", ") || "<none>"}`,
	];

	return {
		name: "MCP quarantine/no default discoverable MCP",
		passed:
			exposedMcpKeys.length === 0 &&
			missingPrivateBlocks.length === 0 &&
			forbiddenImportFindings.length === 0 &&
			publicDocFindings.length === 0 &&
			removedPublicDocsStillPresent.length === 0 &&
			!exposesMcpBuiltin &&
			!importsMcpBuiltinHandler &&
			!acpAdvertisesMcpCommand &&
			!acpReferencesMcpHandler,
		details,
	};
}


async function findPublicDocFindings(): Promise<string[]> {
	const findings: string[] = [];
	for (const relativePath of PUBLIC_DOC_FILES) {
		const text = await readText(relativePath);
		for (const pattern of FORBIDDEN_PUBLIC_DOC_PATTERNS) {
			if (pattern.test(text)) findings.push(`${relativePath}: ${pattern.source}`);
		}
	}
	return findings;
}

async function probeForbiddenPackageImports(): Promise<string[]> {
	const findings: string[] = [];
	for (const specifier of FORBIDDEN_PACKAGE_IMPORTS) {
		const proc = Bun.spawn({
			cmd: ["bun", "-e", `import(${JSON.stringify(specifier)}).then(() => process.exit(0)).catch(() => process.exit(1))`],
			cwd: repoRoot,
			stdout: "ignore",
			stderr: "ignore",
		});
		const exitCode = await proc.exited;
		if (exitCode === 0) findings.push(specifier);
	}
	return findings;
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

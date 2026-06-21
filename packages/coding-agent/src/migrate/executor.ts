/**
 * Execute planned migration actions.
 *
 * Consumes the planner's actions unchanged and performs only `create`/`update`
 * operations. It never re-plans. Writes are not transactional: on a write error
 * the offending action flips to `failed_io`, already-written actions remain, and
 * remaining actions still run (no rollback). Dry-run never calls this.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { upsertMCPServer } from "../runtime-mcp/config-writer";
import type { MigrateAction } from "./types";

export async function executeActions(actions: MigrateAction[]): Promise<MigrateAction[]> {
	const out: MigrateAction[] = [];
	for (const action of actions) {
		if (action.operation !== "create" && action.operation !== "update") {
			out.push(action);
			continue;
		}
		try {
			if (action.type === "mcp" && action.mcp && action.name && action.destination) {
				await upsertMCPServer(action.destination, action.name, action.mcp.config, {
					force: action.operation === "update",
				});
				out.push(action);
			} else if (action.type === "skill" && action.skill && action.destination) {
				await fs.mkdir(path.dirname(action.destination), { recursive: true });
				await fs.writeFile(action.destination, action.skill.content, "utf-8");
				out.push(action);
			} else {
				out.push(action);
			}
		} catch (error) {
			out.push({
				...action,
				operation: "fail",
				status: "failed_io",
				reason: `write failed: ${(error as Error).message}`,
			});
		}
	}
	return out;
}

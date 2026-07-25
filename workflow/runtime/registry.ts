import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkflowDefinition, WorkflowMeta, WorkflowScript } from "./types";

const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SCRIPT_EXTENSIONS = [".ts", ".js", ".mjs"];

/** Bundled workflows ship next to the runtime; user and project dirs override them by name. */
const BUNDLED_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "workflows");

export interface LoadedWorkflow {
	meta: WorkflowMeta;
	script: WorkflowScript;
	path: string;
}

export function workflowSearchPaths(cwd: string): Array<{ dir: string; level: WorkflowDefinition["level"] }> {
	return [
		{ dir: BUNDLED_DIR, level: "bundled" },
		{ dir: path.join(os.homedir(), ".omp", "agent", "workflows"), level: "user" },
		{ dir: path.join(cwd, ".omp", "workflows"), level: "project" },
	];
}

function readMeta(module: Record<string, unknown>, source: string): WorkflowMeta {
	const meta = module.meta;
	if (!meta || typeof meta !== "object") throw new Error(`${source}: missing \`export const meta\``);
	const record = meta as Record<string, unknown>;
	const { name, description, phases, whenToUse } = record;
	if (typeof name !== "string" || !NAME_PATTERN.test(name)) {
		throw new Error(`${source}: meta.name must be a slug of lowercase letters, digits and hyphens`);
	}
	if (typeof description !== "string" || description.trim() === "") {
		throw new Error(`${source}: meta.description is required`);
	}
	if (phases !== undefined && (!Array.isArray(phases) || phases.some(p => typeof p !== "string"))) {
		throw new Error(`${source}: meta.phases must be an array of strings`);
	}
	if (whenToUse !== undefined && typeof whenToUse !== "string") {
		throw new Error(`${source}: meta.whenToUse must be a string`);
	}
	return {
		name,
		description,
		...(phases ? { phases: phases as string[] } : {}),
		...(whenToUse ? { whenToUse } : {}),
	};
}

/** Import a workflow module and validate its authoring contract. */
export async function loadWorkflow(scriptPath: string): Promise<LoadedWorkflow> {
	const absolute = path.resolve(scriptPath);
	// Exception to static-import: a workflow definition is a user file discovered
	// at runtime, so the specifier cannot be known at author time. The query
	// string cache-busts so an author's edit is picked up without restarting omp.
	const module: Record<string, unknown> = await import(`${absolute}?v=${Date.now()}`);
	const meta = readMeta(module, path.basename(absolute));
	const script = module.default;
	if (typeof script !== "function") throw new Error(`${path.basename(absolute)}: missing default-exported function`);
	return { meta, script: script as WorkflowScript, path: absolute };
}

/**
 * Discover definitions across bundled, user and project scopes. Later scopes
 * win by name, so a project can shadow a bundled workflow.
 */
export async function discoverWorkflows(cwd: string): Promise<WorkflowDefinition[]> {
	const byName = new Map<string, WorkflowDefinition>();

	for (const { dir, level } of workflowSearchPaths(cwd)) {
		let entries: string[];
		try {
			entries = await fs.readdir(dir);
		} catch {
			continue;
		}
		for (const entry of entries.sort()) {
			if (entry.startsWith(".") || entry.endsWith(".d.ts") || entry.includes(".test.")) continue;
			if (!SCRIPT_EXTENSIONS.includes(path.extname(entry))) continue;
			const scriptPath = path.join(dir, entry);
			try {
				const { meta } = await loadWorkflow(scriptPath);
				byName.set(meta.name, {
					name: meta.name,
					description: meta.description,
					...(meta.whenToUse ? { whenToUse: meta.whenToUse } : {}),
					...(meta.phases ? { phases: meta.phases } : {}),
					path: scriptPath,
					level,
				});
			} catch {
				// A broken definition must not hide the working ones; `op:"validate"`
				// is where an author gets the diagnostic.
			}
		}
	}

	return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function resolveWorkflow(cwd: string, name: string): Promise<WorkflowDefinition> {
	const found = (await discoverWorkflows(cwd)).find(definition => definition.name === name);
	if (found) return found;
	const searched = workflowSearchPaths(cwd)
		.map(({ dir }) => dir)
		.join(", ");
	throw new Error(`unknown workflow \`${name}\`. Searched: ${searched}`);
}

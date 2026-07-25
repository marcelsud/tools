import * as fs from "node:fs/promises";
import { createTools } from "@oh-my-pi/pi-coding-agent/tools";
import { AgentBudget, DEFAULT_AGENT_BUDGET } from "./budget";
import type { RunEvent } from "./host";
import { WorkflowCompletion, WorkflowHostImpl } from "./host";
import { loadWorkflow, resolveWorkflow } from "./registry";
import { createWorkflowToolSession, type SessionShimInput } from "./session";
import { WORKFLOW_TOOL_NAMES } from "./types";
import type {
	AgentOptions,
	AgentResult,
	BudgetSnapshot,
	ParallelJob,
	ToolCallResult,
	ToolFn,
	ToolProxy,
	WorkflowDefinition,
	WorkflowHost,
	WorkflowMeta,
} from "./types";

/** Wall-clock and ambient-entropy reads make a run unreproducible; the validator flags them. */
const NON_DETERMINISM = [
	{ pattern: /\bMath\.random\s*\(/, hint: "Math.random() — vary parallel prompts by index instead" },
	{ pattern: /\bnew Date\s*\(\s*\)/, hint: "new Date() — pass timestamps in through args" },
	{ pattern: /\bDate\.now\s*\(/, hint: "Date.now() — pass timestamps in through args" },
	{ pattern: /\bperformance\.now\s*\(/, hint: "performance.now() — pass timestamps in through args" },
	{ pattern: /\bcrypto\.randomUUID\s*\(/, hint: "crypto.randomUUID() — derive ids from the work item" },
];

export interface RunRequest extends SessionShimInput {
	/** Registered workflow name. Mutually exclusive with `scriptPath`. */
	name?: string;
	/** Direct path to a definition. Mutually exclusive with `name`. */
	scriptPath?: string;
	args: unknown;
	agentBudget?: number;
	/** Default model for every agent call the script does not pin itself. */
	model?: string | string[];
	signal?: AbortSignal;
	onEvent?: (event: RunEvent) => void;
}

export interface RunOutcome {
	meta: WorkflowMeta;
	path: string;
	status: "completed" | "failed";
	/** The value passed to `complete()`, or the script's return value. */
	result?: unknown;
	error?: string;
	budget: BudgetSnapshot;
	events: RunEvent[];
	durationMs: number;
}

export interface ValidateOutcome {
	meta: WorkflowMeta;
	path: string;
	ok: boolean;
	/** Non-determinism findings from the source scan. */
	warnings: string[];
	/** What went wrong during the canned-host dry run. */
	error?: string;
	/** Agent calls the dry run would have made. */
	simulatedAgentCalls: number;
	events: RunEvent[];
	reachedComplete: boolean;
}

async function locate(request: Pick<RunRequest, "cwd" | "name" | "scriptPath">): Promise<WorkflowDefinition | string> {
	if (request.scriptPath && request.name) throw new Error("pass exactly one of `name` or `script_path`");
	if (request.scriptPath) return request.scriptPath;
	if (request.name) return resolveWorkflow(request.cwd, request.name);
	throw new Error("pass one of `name` or `script_path`");
}

/** Execute a workflow against real subagents. Blocks until the script completes or throws. */
export async function runWorkflow(request: RunRequest): Promise<RunOutcome> {
	const located = await locate(request);
	const scriptPath = typeof located === "string" ? located : located.path;
	const { meta, script, path } = await loadWorkflow(scriptPath);

	const budget = new AgentBudget(request.agentBudget ?? DEFAULT_AGENT_BUDGET);
	const session = createWorkflowToolSession(request);
	// The script gets the same built-in registry the agent loop would build from
	// this session, so `wf.tool.grep(...)` is literally omp's grep.
	const tools = await createTools(session);
	const host = new WorkflowHostImpl({
		session,
		budget,
		args: request.args,
		tools,
		onEvent: request.onEvent ?? (() => {}),
		...(request.model !== undefined ? { defaultModel: request.model } : {}),
		...(request.signal ? { signal: request.signal } : {}),
	});

	const started = Date.now();
	try {
		const returned = await script(host, request.args);
		// A script that falls off the end without `complete()` still has a result:
		// its return value. `undefined` means it produced nothing.
		return {
			meta,
			path,
			status: "completed",
			...(returned !== undefined ? { result: returned } : {}),
			budget: budget.snapshot(),
			events: host.events,
			durationMs: Date.now() - started,
		};
	} catch (error) {
		if (error instanceof WorkflowCompletion) {
			return {
				meta,
				path,
				status: "completed",
				result: error.value,
				budget: budget.snapshot(),
				events: host.events,
				durationMs: Date.now() - started,
			};
		}
		return {
			meta,
			path,
			status: "failed",
			error: error instanceof Error ? error.message : String(error),
			budget: budget.snapshot(),
			events: host.events,
			durationMs: Date.now() - started,
		};
	}
}

/**
 * Build a value satisfying a JSON Schema, so a dry run's canned agent output
 * survives the script's own field access (`output.findings.map(...)`) instead of
 * dying on `undefined` before it reaches the interesting control flow.
 */
function stubFromSchema(schema: unknown, depth = 0): unknown {
	if (depth > 6 || !schema || typeof schema !== "object") return "stub";
	const node = schema as Record<string, unknown>;
	if (Array.isArray(node.enum) && node.enum.length > 0) return node.enum[0];
	switch (node.type) {
		case "object": {
			const properties = (node.properties ?? {}) as Record<string, unknown>;
			const stub: Record<string, unknown> = {};
			for (const [key, child] of Object.entries(properties)) stub[key] = stubFromSchema(child, depth + 1);
			return stub;
		}
		case "array":
			return [stubFromSchema(node.items, depth + 1)];
		case "number":
		case "integer":
			return 1;
		case "boolean":
			return true;
		case "null":
			return null;
		default:
			return "stub";
	}
}

/**
 * Smoke-check without a live multi-agent run: validate the metadata, scan the
 * source for non-determinism, then execute *one* path with canned agent results.
 *
 * It does not enumerate branches, exercise real tools, or prove schema handling
 * for every agent shape. Pass representative `args`.
 */
export async function validateWorkflow(
	request: Pick<RunRequest, "cwd" | "name" | "scriptPath" | "args" | "agentBudget">,
): Promise<ValidateOutcome> {
	const located = await locate(request);
	const scriptPath = typeof located === "string" ? located : located.path;
	const { meta, script, path } = await loadWorkflow(scriptPath);

	const source = await fs.readFile(path, "utf8");
	const warnings = NON_DETERMINISM.filter(({ pattern }) => pattern.test(source)).map(({ hint }) => hint);
	if (meta.phases) {
		const missing = meta.phases.filter(title => !source.includes(title));
		if (missing.length > 0) warnings.push(`meta.phases not found in any phase() call: ${missing.join(", ")}`);
	}

	const events: RunEvent[] = [];
	const budget = new AgentBudget(request.agentBudget ?? DEFAULT_AGENT_BUDGET);
	let simulatedAgentCalls = 0;

	const cannedResult = (opts: AgentOptions, index: number): AgentResult => ({
		agentId: `dry-${index}`,
		success: true,
		output: Object.hasOwn(opts, "schema") ? stubFromSchema(opts.schema) : "dry-run output",
		tokensUsed: 0,
		durationMs: 0,
	});

	// The dry run never touches the workspace: every built-in reports success with
	// no output, so the script's happy path stays reachable.
	const dryTool: Record<string, ToolFn> = {};
	for (const name of WORKFLOW_TOOL_NAMES) {
		dryTool[name] = async (): Promise<ToolCallResult> => ({
			text: "",
			details: undefined,
			isError: false,
			truncated: false,
		});
	}

	const host: WorkflowHost = {
		args: request.args,
		cwd: request.cwd,
		agent: async (_prompt: string, opts: AgentOptions = {}) => {
			budget.admit(1);
			return cannedResult(opts, simulatedAgentCalls++);
		},
		parallel: async (jobs: ParallelJob[]) => {
			budget.admit(jobs.length);
			return jobs.map(({ prompt: _prompt, ...opts }) => cannedResult(opts, simulatedAgentCalls++));
		},
		phase: title => events.push({ kind: "phase", message: title, at: 0 }),
		log: message => events.push({ kind: "log", message, at: 0 }),
		complete: value => {
			throw new WorkflowCompletion(value);
		},
		budget: () => budget.snapshot(),
		json: value => JSON.stringify(value) ?? "null",
		fingerprint: text => `dry-${text.length}`,
		tool: dryTool as ToolProxy,
		sh: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
	};

	const finish = (outcome: Omit<ValidateOutcome, "warnings">): ValidateOutcome => {
		// Canned tools report empty output, so a script that short-circuits on
		// "nothing to do" never reaches its fan-out. Say so rather than let a
		// green check imply the agent phases were exercised.
		if (outcome.simulatedAgentCalls === 0) {
			warnings.push(
				"the exercised path made no agent calls — the canned tools return empty output, so a script that " +
					"short-circuits on an empty diff or a clean tree ends early. Pass args that reach the fan-out.",
			);
		}
		return { ...outcome, warnings };
	};

	try {
		await script(host, request.args);
		return finish({ meta, path, ok: true, simulatedAgentCalls, events, reachedComplete: false });
	} catch (error) {
		if (error instanceof WorkflowCompletion) {
			return finish({ meta, path, ok: true, simulatedAgentCalls, events, reachedComplete: true });
		}
		return finish({
			meta,
			path,
			ok: false,
			error: error instanceof Error ? error.message : String(error),
			simulatedAgentCalls,
			events,
			reachedComplete: false,
		});
	}
}

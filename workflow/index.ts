/**
 * `workflow` — deterministic multi-agent orchestration for omp.
 *
 * A workflow is a saved script that fans out self-contained subagents, barriers
 * on their structured results, verifies claims in code rather than in vibes, and
 * returns one artifact. The script owns scope, budget and gates; the agents only
 * supply judgement.
 *
 * Install: symlink this directory into `~/.omp/agent/tools/workflow` (user) or
 * `<repo>/.omp/tools/workflow` (project).
 */
import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { DEFAULT_AGENT_BUDGET, MAX_AGENT_BUDGET, MIN_AGENT_BUDGET } from "./runtime/budget";
import type { InflightAgent, RunEvent } from "./runtime/host";
import { discoverWorkflows, workflowSearchPaths } from "./runtime/registry";
import { type RunOutcome, runWorkflow, type ValidateOutcome, validateWorkflow } from "./runtime/run";
import type { WorkflowDefinition } from "./runtime/types";

function renderEvents(events: RunEvent[], inflight: InflightAgent[] = []): string {
	const lines: string[] = [];
	for (const event of events) {
		if (event.kind === "phase") lines.push(`\n── ${event.message} ──`);
		else if (event.kind === "agent") lines.push(`  · ${event.message}`);
		else lines.push(`  ${event.message}`);
	}
	for (const agent of inflight) {
		const where = agent.tool ? `${agent.tool}` : (agent.intent ?? "thinking");
		lines.push(
			`  ⋯ ${agent.label} — ${where}` +
				`  [${agent.toolCount} tools, ${agent.tokens} tok, ${(agent.elapsedMs / 1000).toFixed(0)}s]`,
		);
	}
	return lines.join("\n").trim();
}

function renderList(definitions: WorkflowDefinition[], cwd: string): string {
	if (definitions.length === 0) {
		return `No workflows found. Searched:\n${workflowSearchPaths(cwd)
			.map(({ dir, level }) => `  ${dir}  (${level})`)
			.join("\n")}`;
	}
	const lines = definitions.map(definition => {
		const phases = definition.phases?.length ? `  phases: ${definition.phases.join(" → ")}\n` : "";
		const when = definition.whenToUse ? `  when: ${definition.whenToUse}\n` : "";
		return `${definition.name}  [${definition.level}]\n  ${definition.description}\n${phases}${when}  ${definition.path}`;
	});
	return `${definitions.length} workflow(s):\n\n${lines.join("\n\n")}`;
}

function renderRun(outcome: RunOutcome): string {
	const { budget } = outcome;
	const header =
		`${outcome.meta.name} — ${outcome.status} in ${(outcome.durationMs / 1000).toFixed(1)}s ` +
		`(${budget.spent}/${budget.total} agent calls)`;
	const body = renderEvents(outcome.events);
	const tail =
		outcome.status === "completed"
			? `result:\n${JSON.stringify(outcome.result ?? null, null, 2)}`
			: `error: ${outcome.error}`;
	return [header, body, tail].filter(Boolean).join("\n\n");
}

function renderValidate(outcome: ValidateOutcome): string {
	const lines = [
		`${outcome.meta.name} — ${outcome.ok ? "smoke check passed" : "smoke check FAILED"}`,
		`  ${outcome.path}`,
		`  dry run: ${outcome.simulatedAgentCalls} agent call(s) on one path` +
			`${outcome.reachedComplete ? ", reached complete()" : ", never reached complete()"}`,
	];
	if (!outcome.reachedComplete && outcome.ok) {
		lines.push("  warning: the exercised path ended without complete() — the run would return no artifact");
	}
	for (const warning of outcome.warnings) lines.push(`  warning: ${warning}`);
	if (outcome.error) lines.push(`  error: ${outcome.error}`);
	const events = renderEvents(outcome.events);
	if (events) lines.push("", events);
	lines.push(
		"",
		"A smoke check validates metadata, scans for non-determinism, and runs ONE path with canned",
		"agent results. It does not enumerate branches, call real tools, or validate side effects.",
	);
	return lines.join("\n");
}

const factory: CustomToolFactory = pi => ({
	name: "workflow",
	label: "Workflow",
	description:
		"Run a deterministic multi-agent workflow: a saved script that fans out subagents, barriers on their " +
		"structured results, verifies findings adversarially, and returns one artifact under a hard agent-call budget. " +
		"Use it instead of ad-hoc `task` fan-out when the orchestration should be repeatable and the gates enforced by " +
		"code rather than by prompt text. `op:\"list\"` shows available workflows; `op:\"validate\"` smoke-checks a " +
		"definition without spending real agents; `op:\"run\"` executes it and blocks until it completes.",
	parameters: pi.zod.object({
		op: pi.zod.enum(["list", "run", "validate"]).describe("list definitions, smoke-check one, or run one"),
		name: pi.zod.string().optional().describe("registered workflow name; exclusive with script_path"),
		script_path: pi.zod.string().optional().describe("path to a definition file; exclusive with name"),
		args: pi.zod.unknown().optional().describe("launch payload bound to the script's `args`"),
		agent_budget: pi.zod
			.number()
			.int()
			.min(MIN_AGENT_BUDGET)
			.max(MAX_AGENT_BUDGET)
			.optional()
			.describe(`absolute cap on logical agent calls for the run (default ${DEFAULT_AGENT_BUDGET})`),
		model: pi.zod
			.string()
			.optional()
			.describe("model for every agent call the script does not pin itself, e.g. grok-composer-2.5-fast"),
	}),

	async execute(_toolCallId, params, onUpdate, ctx, signal) {
		const { op, name, script_path: scriptPath, args, agent_budget: agentBudget, model } = params;

		if (op === "list") {
			const definitions = await discoverWorkflows(pi.cwd);
			return {
				content: [{ type: "text", text: renderList(definitions, pi.cwd) }],
				details: { op, workflows: definitions },
			};
		}

		const located = {
			cwd: pi.cwd,
			...(name !== undefined ? { name } : {}),
			...(scriptPath !== undefined ? { scriptPath } : {}),
			args,
		};

		if (op === "validate") {
			const outcome = await validateWorkflow({
				...located,
				...(agentBudget !== undefined ? { agentBudget } : {}),
			});
			return {
				content: [{ type: "text", text: renderValidate(outcome) }],
				details: { op, ...outcome },
				isError: !outcome.ok,
			};
		}

		const events: RunEvent[] = [];
		let inflight: InflightAgent[] = [];
		const outcome = await runWorkflow({
			...located,
			...(agentBudget !== undefined ? { agentBudget } : {}),
			...(model !== undefined ? { model } : {}),
			...(signal ? { signal } : {}),
			...(ctx?.settings ? { settings: ctx.settings } : {}),
			...(ctx?.localProtocolOptions ? { localProtocolOptions: ctx.localProtocolOptions } : {}),
			artifactsDir: ctx?.sessionManager?.getArtifactsDir?.() ?? null,
			sessionFile: ctx?.sessionManager?.getSessionFile?.() ?? null,
			onEvent: event => {
				// Progress is a live snapshot, not history: it replaces the previous
				// one instead of appending, so the block shows current state.
				if (event.kind === "progress") inflight = event.inflight ?? [];
				else events.push(event);
				onUpdate?.({
					content: [{ type: "text", text: renderEvents(events, inflight) }],
					details: { op, phase: event.kind === "phase" ? event.message : undefined, events, inflight },
				});
			},
		});

		return {
			content: [{ type: "text", text: renderRun(outcome) }],
			details: { op, ...outcome },
			isError: outcome.status === "failed",
		};
	},
});

export default factory;

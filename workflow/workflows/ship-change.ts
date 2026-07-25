import * as path from "node:path";
import type { AgentResult, WorkflowHost, WorkflowMeta } from "../runtime/types";

export const meta: WorkflowMeta = {
	name: "ship-change",
	description: "Plan a change, implement it, then gate it behind independent QA and code review",
	phases: ["Plan", "Implement", "Gate", "Repair"],
	whenToUse:
		"Delivering a bounded code change end to end when you want the plan, the implementation, the test run and the review done by different models, and the ship decision made by code instead of by the implementer's own opinion.",
};

/**
 * Roles are pinned per phase, not per run: the point of this workflow is that
 * the implementer never grades its own work. Override with `args.models`.
 */
const DEFAULT_MODELS = {
	planner: "openai-codex/gpt-5.6-sol",
	coder: "xai-oauth/grok-4.5",
	qa: "openai-codex/gpt-5.6-sol",
	reviewer: "anthropic/claude-opus-5",
} as const;

type Role = keyof typeof DEFAULT_MODELS;

const PLAN_SCHEMA = {
	type: "object",
	properties: {
		steps: {
			type: "array",
			maxItems: 10,
			items: {
				type: "object",
				properties: {
					file: { type: "string", description: "repository-relative path this step edits or creates" },
					change: { type: "string", description: "what to change, concretely" },
				},
				required: ["file", "change"],
			},
		},
		acceptance: {
			type: "array",
			maxItems: 8,
			items: { type: "string", description: "one observable, checkable criterion" },
		},
		risks: { type: "array", maxItems: 5, items: { type: "string" } },
	},
	required: ["steps", "acceptance"],
} as const;

const IMPL_SCHEMA = {
	type: "object",
	properties: {
		summary: { type: "string" },
		filesTouched: { type: "array", items: { type: "string" } },
	},
	required: ["summary", "filesTouched"],
} as const;

const QA_SCHEMA = {
	type: "object",
	properties: {
		pass: { type: "boolean", description: "true only if the verify command exited 0 and every criterion holds" },
		command: { type: "string", description: "the exact command you ran" },
		output: { type: "string", description: "the tail of its output" },
		failures: { type: "array", items: { type: "string" } },
	},
	required: ["pass", "command", "failures"],
} as const;

const REVIEW_SCHEMA = {
	type: "object",
	properties: {
		blockers: {
			type: "array",
			maxItems: 8,
			items: {
				type: "object",
				properties: { file: { type: "string" }, issue: { type: "string" }, evidence: { type: "string" } },
				required: ["file", "issue", "evidence"],
			},
		},
		material: {
			type: "array",
			maxItems: 8,
			items: {
				type: "object",
				properties: { file: { type: "string" }, issue: { type: "string" } },
				required: ["file", "issue"],
			},
		},
	},
	required: ["blockers", "material"],
} as const;

interface Step {
	file: string;
	change: string;
}
interface Blocker {
	file: string;
	issue: string;
	evidence: string;
}

interface Args {
	task: string;
	verify: string[];
	models: Record<Role, string>;
	maxRepairRounds: number;
}

function readArgs(raw: unknown): Args {
	const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	const task = record.task;
	if (typeof task !== "string" || task.trim() === "") {
		throw new Error('ship-change needs args.task, e.g. {"task":"fix the bugs in src/cart.js","verify":["bun","test"]}');
	}
	const verify = Array.isArray(record.verify) && record.verify.every(v => typeof v === "string") ? record.verify : [];
	if (verify.length === 0) {
		throw new Error('ship-change needs args.verify as an argv array, e.g. ["bun","test"]');
	}
	const overrides = record.models && typeof record.models === "object" ? (record.models as Record<string, unknown>) : {};
	const models = { ...DEFAULT_MODELS } as Record<Role, string>;
	for (const role of Object.keys(models) as Role[]) {
		const override = overrides[role];
		if (typeof override === "string" && override.trim() !== "") models[role] = override;
	}
	const rounds = record.maxRepairRounds;
	return {
		task,
		verify,
		models,
		maxRepairRounds: typeof rounds === "number" && rounds >= 0 ? Math.trunc(rounds) : 1,
	};
}

/** A path is in scope only if it stays under the workspace root. Planners drift; the script does not. */
function inScope(cwd: string, file: string): boolean {
	if (typeof file !== "string" || file.trim() === "" || path.isAbsolute(file)) return false;
	const resolved = path.resolve(cwd, file);
	return resolved === cwd || resolved.startsWith(`${cwd}${path.sep}`);
}

function readSteps(wf: WorkflowHost, output: unknown): { steps: Step[]; acceptance: string[]; dropped: string[] } {
	const record = output && typeof output === "object" ? (output as Record<string, unknown>) : {};
	const steps: Step[] = [];
	const dropped: string[] = [];
	if (Array.isArray(record.steps)) {
		for (const entry of record.steps) {
			if (!entry || typeof entry !== "object") continue;
			const { file, change } = entry as Record<string, unknown>;
			if (typeof file !== "string" || typeof change !== "string" || change.trim() === "") continue;
			if (!inScope(wf.cwd, file)) {
				dropped.push(file);
				continue;
			}
			steps.push({ file, change });
		}
	}
	const acceptance = Array.isArray(record.acceptance)
		? record.acceptance.filter((a): a is string => typeof a === "string" && a.trim() !== "")
		: [];
	return { steps, acceptance, dropped };
}

function readBlockers(wf: WorkflowHost, result: AgentResult | null): Blocker[] {
	if (!result?.success || !result.output || typeof result.output !== "object") return [];
	const list = (result.output as Record<string, unknown>).blockers;
	if (!Array.isArray(list)) return [];
	const blockers: Blocker[] = [];
	for (const entry of list) {
		if (!entry || typeof entry !== "object") continue;
		const { file, issue, evidence } = entry as Record<string, unknown>;
		if (typeof file !== "string" || typeof issue !== "string") continue;
		// A blocker with no evidence is an opinion. Reviews that cannot show the
		// code do not get to hold up a ship.
		if (typeof evidence !== "string" || evidence.trim() === "") continue;
		if (!inScope(wf.cwd, file)) continue;
		blockers.push({ file, issue, evidence });
	}
	return blockers;
}

/** Working-tree state as ground truth, rather than whatever the implementer claims it did. */
async function worktreeState(wf: WorkflowHost): Promise<{ diff: string; untracked: string[]; changed: boolean }> {
	const [diffCall, untrackedCall] = await Promise.all([
		wf.sh("git diff --no-color HEAD"),
		wf.sh("git ls-files --others --exclude-standard"),
	]);
	if (diffCall.exitCode !== 0 || untrackedCall.exitCode !== 0) {
		const failed = diffCall.exitCode !== 0 ? diffCall : untrackedCall;
		const detail = failed.stderr.trim() || failed.stdout.trim() || `exit ${failed.exitCode}`;
		throw new Error(`git inspection failed: ${detail}`);
	}
	const diff = diffCall.stdout;
	const untracked = untrackedCall.stdout.split("\n").filter(line => line.trim() !== "");
	return { diff, untracked, changed: diff.trim() !== "" || untracked.length > 0 };
}

export default async function shipChange(wf: WorkflowHost, rawArgs: unknown): Promise<void> {
	const args = readArgs(rawArgs);
	const verifyCommand = args.verify.join(" ");

	const baseline = await worktreeState(wf);
	if (baseline.changed) {
		throw new Error(
			"working tree is dirty; ship-change needs a clean tree so the diff it reviews is the change it made",
		);
	}

	// ── Plan ────────────────────────────────────────────────────────────────
	wf.phase("Plan");
	const planning = await wf.agent(
		`Plan this change to the repository at ${wf.cwd}:\n\n${args.task}\n\n` +
			`Read the relevant code first — you have read-only tools and no shell.\n` +
			`Return concrete steps as {file, change} using repository-relative paths that exist or that you ` +
			`explicitly intend to create, plus acceptance criteria that ${wf.json(verifyCommand)} can demonstrate.\n` +
			`Plan the smallest change that satisfies the task. Do not plan refactors nobody asked for.`,
		{ label: "plan", capability: "read-only", model: args.models.planner, schema: PLAN_SCHEMA },
	);
	if (!planning.success) {
		wf.complete({ shipped: false, reason: `planning failed: ${planning.error}` });
	}

	// Re-filter the planner's output against our own invariants before acting on it.
	const { steps, acceptance, dropped } = readSteps(wf, planning.output);
	if (dropped.length > 0) wf.log(`dropped ${dropped.length} out-of-scope planned path(s): ${dropped.join(", ")}`);
	if (steps.length === 0) {
		wf.complete({ shipped: false, reason: "planner produced no in-scope steps" });
	}
	wf.log(`plan: ${steps.length} step(s), ${acceptance.length} acceptance criteria`);

	// ── Implement ───────────────────────────────────────────────────────────
	wf.phase("Implement");
	const planText = steps.map((step, i) => `${i + 1}. ${step.file} — ${step.change}`).join("\n");
	const acceptanceText = acceptance.map(item => `- ${item}`).join("\n");
	const implementation = await wf.agent(
		`Implement this plan in ${wf.cwd}. Edit the files directly; do not commit.\n\n` +
			`TASK\n${args.task}\n\nPLAN\n${planText}\n\n` +
			`ACCEPTANCE\n${acceptanceText || "- the task is satisfied"}\n\n` +
			`Run ${wf.json(verifyCommand)} yourself and keep working until it passes. ` +
			`Stay inside the plan's files unless a file it names does not compile without another edit.`,
		{ label: "implement", capability: "read-write", model: args.models.coder, schema: IMPL_SCHEMA },
	);
	if (!implementation.success) {
		wf.complete({ shipped: false, reason: `implementation failed: ${implementation.error}`, steps });
	}

	let state = await worktreeState(wf);
	if (!state.changed) {
		wf.complete({ shipped: false, reason: "implementer reported success but the working tree is unchanged", steps });
	}
	wf.log(`working tree: ${state.diff.length} chars of diff, ${state.untracked.length} new file(s)`);

	// ── Gate ────────────────────────────────────────────────────────────────
	// QA and review are independent observers of the same tree, so they run as one
	// panel. Neither sees the other's verdict.
	let round = 0;
	let blockers: Blocker[] = [];
	let qa: AgentResult | null = null;

	for (;;) {
		wf.phase(round === 0 ? "Gate" : "Repair");
		const gate = await wf.parallel([
			{
				prompt:
					`Verify the uncommitted change in ${wf.cwd}.\n\n` +
					`Run exactly: ${verifyCommand}\n\n` +
					`Then check each acceptance criterion against what actually happened:\n${acceptanceText || "- the task is satisfied"}\n\n` +
					`Set pass=true only if the command exited 0 AND every criterion holds. ` +
					`Report the exact command you ran and the tail of its output. Do not edit any files.`,
				label: `qa:r${round}`,
				capability: "execute",
				model: args.models.qa,
				schema: QA_SCHEMA,
			},
			{
				prompt:
					`Review this uncommitted change in ${wf.cwd} for correctness and risk.\n\n` +
					`TASK THE CHANGE CLAIMS TO DO\n${args.task}\n\n` +
					`Read the touched files in the working tree — the diff below is context, the files are the truth. ` +
					`New files: ${state.untracked.join(", ") || "none"}.\n\n` +
					`A blocker is something factually wrong or that will break a user, and it requires \`evidence\`: ` +
					`the lines you read and why they are wrong. Anything you cannot evidence is not a blocker. ` +
					`Style preferences are neither. Do not edit any files.\n\n` +
					`--- BEGIN DIFF ---\n${state.diff.slice(0, 60_000)}\n--- END DIFF ---`,
				label: `review:r${round}`,
				capability: "read-only",
				model: args.models.reviewer,
				schema: REVIEW_SCHEMA,
			},
		]);

		qa = gate[0] ?? null;
		blockers = readBlockers(wf, gate[1] ?? null);

		// Proof gate, fails closed: a missing or failed QA slot is not a pass.
		const qaPassed =
			qa?.success === true &&
			typeof qa.output === "object" &&
			qa.output !== null &&
			(qa.output as Record<string, unknown>).pass === true;
		wf.log(`round ${round}: qa ${qaPassed ? "pass" : "FAIL"}, ${blockers.length} evidenced blocker(s)`);

		if (qaPassed && blockers.length === 0) {
			wf.complete({
				shipped: true,
				summary: `Change implemented and cleared QA plus review in ${round + 1} round(s).`,
				steps,
				acceptance,
				repairRounds: round,
				filesTouched: state.untracked,
				diffChars: state.diff.length,
			});
		}

		if (round >= args.maxRepairRounds) break;
		round++;

		const failures = qaPassed ? [] : [`${verifyCommand} did not pass`];
		const repairBrief =
			[
				...failures.map(f => `- QA: ${f}`),
				...blockers.map(b => `- BLOCKER ${b.file}: ${b.issue}\n  evidence: ${b.evidence}`),
			].join("\n") || "- unspecified failure";

		const repair = await wf.agent(
			`Your change in ${wf.cwd} did not pass the gate. Fix exactly these findings and nothing else:\n\n` +
				`${repairBrief}\n\n` +
				`Then run ${wf.json(verifyCommand)} and confirm it passes. Do not commit.`,
			{ label: `repair:r${round}`, capability: "read-write", model: args.models.coder, schema: IMPL_SCHEMA },
		);
		if (!repair.success) {
			wf.log(`repair round ${round} failed: ${repair.error}`);
			break;
		}
		state = await worktreeState(wf);
	}

	// Out of repair rounds. Fail closed: the change stays uncommitted for a human.
	wf.complete({
		shipped: false,
		reason: "change did not clear the gate within the repair budget",
		repairRounds: round,
		qa: qa?.output ?? null,
		blockers,
		steps,
		acceptance,
	});
}

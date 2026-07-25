import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { WorkflowHost, WorkflowMeta } from "../runtime/types";

export const meta: WorkflowMeta = {
	name: "review-changes",
	description: "Review a diff target across independent dimensions, then adversarially verify every finding",
	phases: ["Review", "Verify"],
	whenToUse:
		"Reviewing a branch, diff range or path where confirmation bias is the risk: the reviewers and the skeptics are different agents, and a finding only survives with independently inspected evidence.",
};

const FINDINGS_SCHEMA = {
	type: "object",
	properties: {
		findings: {
			type: "array",
			maxItems: 8,
			items: {
				type: "object",
				properties: {
					file: { type: "string" },
					issue: { type: "string" },
				},
				required: ["file", "issue"],
			},
		},
	},
	required: ["findings"],
} as const;

const VERDICT_SCHEMA = {
	type: "object",
	properties: {
		real: { type: "boolean" },
		reason: { type: "string" },
		evidence: { type: "string" },
	},
	required: ["real", "reason", "evidence"],
} as const;

const DIMENSIONS = ["correctness bugs", "error handling gaps", "performance problems"];

interface Finding {
	file: string;
	issue: string;
}

/** Agents will report files outside the target; the script, not the prompt, is the boundary. */
function readFindings(output: unknown): Finding[] {
	if (!output || typeof output !== "object") return [];
	const list = (output as Record<string, unknown>).findings;
	if (!Array.isArray(list)) return [];
	const findings: Finding[] = [];
	for (const entry of list) {
		if (!entry || typeof entry !== "object") continue;
		const { file, issue } = entry as Record<string, unknown>;
		if (typeof file !== "string" || typeof issue !== "string") continue;
		if (file.trim() === "" || issue.trim() === "") continue;
		findings.push({ file, issue });
	}
	return findings;
}

/** Big diffs blow the child's context before it can reason; cut with a visible notice. */
const MAX_DIFF_CHARS = 60_000;

export default async function reviewChanges(wf: WorkflowHost, args: unknown): Promise<void> {
	const target = args && typeof args === "object" ? (args as Record<string, unknown>).target : undefined;
	if (typeof target !== "string" || target.trim() === "") {
		throw new Error('review-changes needs args.target, e.g. {"target":"origin/main...HEAD"}');
	}

	// The diff is deterministic data, so the script computes it once with omp's own
	// bash tool and hands it over. Asking read-only children to "go run git diff"
	// gives them a job their tool set cannot do: they burn the budget spelunking
	// .git objects by hand.
	const diffCall = await wf.tool.bash({
		command: `git diff --no-color ${target}`,
		i: "Reading the diff under review",
	});
	if (diffCall.isError) {
		throw new Error(`git diff ${target} failed: ${diffCall.text.trim()}`);
	}
	const rawDiff = diffCall.text;
	if (rawDiff.trim() === "") {
		wf.complete({ target, summary: `No changes in ${target}.`, confirmed: [] });
	}
	const diff =
		rawDiff.length > MAX_DIFF_CHARS
			? `${rawDiff.slice(0, MAX_DIFF_CHARS)}\n\n[diff truncated at ${MAX_DIFF_CHARS} chars]`
			: rawDiff;
	if (rawDiff.length > MAX_DIFF_CHARS) {
		wf.log(`diff truncated: ${rawDiff.length} chars → ${MAX_DIFF_CHARS}`);
	}
	wf.log(`reviewing ${target} (${rawDiff.length} chars of diff)`);

	wf.phase("Review");
	const reviews = await wf.parallel(
		DIMENSIONS.map(dimension => ({
			prompt:
				`Review this change for ${dimension}. The complete diff of ${wf.json(target)} is below — ` +
				`you have no shell, so this diff is the change; do not try to reconstruct it.\n\n` +
				`Open the touched files with your read tools to see the surrounding code before judging: ` +
				`the repository root is ${wf.cwd}.\n` +
				`Report at most 8 findings as {file, issue}, where \`file\` is a repository-relative path ` +
				`that appears in the diff. An empty findings list is a valid answer, but only after you have ` +
				`read the code.\n\n` +
				`--- BEGIN DIFF ---\n${diff}\n--- END DIFF ---`,
			label: `review:${dimension.split(" ")[0]}`,
			capability: "read-only" as const,
			schema: FINDINGS_SCHEMA,
		})),
	);

	// Guard every slot: a failed panel member is null, and a successful one can
	// still return a shape the schema permitted but we cannot use.
	const seen = new Set<string>();
	const findings: Finding[] = [];
	for (const review of reviews) {
		if (!review?.success) continue;
		for (const finding of readFindings(review.output)) {
			const resolved = path.resolve(wf.cwd, finding.file);
			// Re-check scope in the script. A prompt saying "stay in the repo" is not enforcement.
			if (!resolved.startsWith(`${wf.cwd}${path.sep}`)) continue;
			if (!(await fs.stat(resolved).catch(() => null))?.isFile()) continue;
			const key = `${finding.file}::${finding.issue}`;
			if (seen.has(key)) continue;
			seen.add(key);
			findings.push(finding);
		}
	}

	wf.log(`${findings.length} finding(s) from ${reviews.filter(Boolean).length}/${DIMENSIONS.length} reviewers`);
	if (findings.length === 0) {
		wf.complete({ target, summary: "No findings survived review.", confirmed: [] });
	}

	wf.phase("Verify");
	const verdicts = await wf.parallel(
		findings.map(finding => ({
			prompt:
				`Adversarially verify this claim about ${wf.json(target)}:\n\n` +
				`  file: ${finding.file}\n  issue: ${wf.json(finding.issue)}\n\n` +
				`Open ${finding.file} under ${wf.cwd} yourself and inspect the code. ` +
				`Assume the claim is wrong until the code proves otherwise.\n` +
				`Set real=true ONLY if you independently confirmed it, and put the concrete proof ` +
				`(the lines you read, and why they are wrong) in \`evidence\`. Leave evidence empty if you could not verify.`,
			label: `verify:${path.basename(finding.file)}`,
			capability: "read-only" as const,
			schema: VERDICT_SCHEMA,
		})),
	);

	// Proof gate: fails closed. A missing verdict, a failed skeptic, or a real=true
	// with no evidence all leave the claim unconfirmed.
	const confirmed: Array<Finding & { evidence: string; reason: string }> = [];
	for (const [index, finding] of findings.entries()) {
		const verdict = verdicts[index];
		if (!verdict?.success || !verdict.output || typeof verdict.output !== "object") continue;
		const { real, reason, evidence } = verdict.output as Record<string, unknown>;
		if (real !== true) continue;
		if (typeof evidence !== "string" || evidence.trim() === "") continue;
		confirmed.push({ ...finding, evidence, reason: typeof reason === "string" ? reason : "" });
	}

	wf.log(`${confirmed.length}/${findings.length} findings survived verification`);
	wf.complete({
		target,
		summary: `${confirmed.length} of ${findings.length} findings confirmed by independent verification.`,
		confirmed,
	});
}

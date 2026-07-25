/**
 * Public authoring surface for workflow scripts.
 *
 * A workflow is a plain ES module:
 *
 *   export const meta: WorkflowMeta = { name: "review-changes", description: "..." };
 *   export default async function (wf: WorkflowHost, args: unknown) { ... }
 *
 * The script orchestrates; agents judge. Scope, budgets, filters and gates live
 * here in script code — never in a prompt.
 */

/** Metadata every workflow module must export as `meta`. */
export interface WorkflowMeta {
	/** Slug: lowercase letters, digits, hyphens. Matches the file stem by convention. */
	name: string;
	/** One-line purpose, shown by `workflow{op:"list"}`. */
	description: string;
	/** UI rail; titles should match the `wf.phase()` calls. */
	phases?: string[];
	/** Discovery hint for the model choosing between workflows. */
	whenToUse?: string;
}

/**
 * Tool classes granted to a child agent. Enforced by resolving to an agent
 * definition whose tool set the host restricts — not by asking the prompt
 * nicely.
 */
export type CapabilityMode = "read-only" | "read-write" | "execute" | "all";

/** Effort selector forwarded to the child's model. */
export type Effort = "lo" | "med" | "hi";

export interface AgentOptions {
	/** UI / log label; also seeds the `agent://<id>` handle. */
	label?: string;
	/** Tool classes for the child. Default `read-only`. */
	capability?: CapabilityMode;
	/** Explicit agent type. Overrides the `capability` mapping. */
	agent?: string;
	/** Model selector, e.g. `@smol` / `@slow` / a provider string. */
	model?: string | string[];
	/** JSON Schema. When set, `output` is the validated object. */
	schema?: unknown;
	/** Schema enforcement. Default `permissive`. */
	schemaMode?: "permissive" | "strict";
	/** Per-spawn reasoning effort. */
	effort?: Effort;
	/** Shared background rendered into the child's system prompt. */
	context?: string;
}

/** One job in a `parallel` panel: agent options plus the prompt. */
export interface ParallelJob extends AgentOptions {
	prompt: string;
}

/**
 * Outcome of one logical agent call. Agent-level failure is *data*: `success`
 * is false and the script decides fail-open vs fail-closed. Only infrastructure
 * failures throw.
 */
export interface AgentResult {
	agentId: string;
	success: boolean;
	/** Validated object when `schema` was set, else the child's final text. */
	output: unknown;
	/** Present when `success` is false. */
	error?: string;
	tokensUsed: number;
	durationMs: number;
}

export interface BudgetSnapshot {
	/** Absolute logical-agent cap for this run. */
	total: number;
	/** Admitted launches so far. */
	spent: number;
	/** Always 0; reserved for future pre-allocation. */
	reserved: number;
	remaining: number;
}

/** What a built-in returns to a script: the text the agent would see, plus its structured details. */
export interface ToolCallResult {
	text: string;
	/** Tool-specific structured payload, e.g. `bash` reports `{ exitCode }` on failure. */
	details: unknown;
	/** True when the tool reported failure. `bash` sets it for any non-zero exit. */
	isError: boolean;
}

export type ToolFn = (args: unknown) => Promise<ToolCallResult>;

/**
 * Built-ins a workflow may call. Every name is always present on {@link ToolProxy};
 * one that this run's settings did not construct throws when called, naming
 * itself, rather than being silently absent.
 */
export const WORKFLOW_TOOL_NAMES = [
	"ast_edit",
	"ast_grep",
	"bash",
	"browser",
	"debug",
	"edit",
	"eval",
	"glob",
	"grep",
	"hub",
	"lsp",
	"read",
	"task",
	"todo",
	"web_search",
	"write",
] as const;

export type WorkflowToolName = (typeof WORKFLOW_TOOL_NAMES)[number];

/** omp's built-in registry, keyed by tool name. */
export type ToolProxy = Readonly<Record<WorkflowToolName, ToolFn>> & Readonly<Record<string, ToolFn | undefined>>;

/** The host API handed to a workflow script. Every call blocks. */
export interface WorkflowHost {
	/** Launch payload, verbatim. `undefined` when the run was started without args. */
	readonly args: unknown;

	/**
	 * Workspace root for this run. Use it for every path check — `process.cwd()`
	 * is the omp process, not the workspace the run targets.
	 */
	readonly cwd: string;

	/** One logical agent call. Spends 1 budget unit. */
	agent(prompt: string, opts?: AgentOptions): Promise<AgentResult>;

	/**
	 * Fan out, then barrier. Results come back in input order; a failed slot is
	 * `null`. Admission is atomic: if the whole panel would exceed the remaining
	 * budget, nothing launches and the call throws.
	 */
	parallel(jobs: ParallelJob[]): Promise<(AgentResult | null)[]>;

	/** Group subsequent work under a title in the run log. */
	phase(title: string): void;

	/** Progress line for the human reading the run. */
	log(message: string): void;

	/** Terminal success. Never returns. */
	complete(value: unknown): never;

	/** Live budget view. */
	budget(): BudgetSnapshot;

	/** Deterministic JSON, for quoting untrusted data into a prompt. */
	json(value: unknown): string;

	/** Stable hash, for stall/oscillation detection across rounds. */
	fingerprint(text: string): string;

	/**
	 * omp's own built-in tools — `read`, `grep`, `glob`, `bash`, `edit`, `write`,
	 * `ast_edit`, `browser`, `debug`, `eval`, `task`, `todo`, `web_search`, `hub`
	 * — callable directly from the script:
	 *
	 * ```ts
	 * const { text, isError } = await wf.tool.bash({ command: "git diff HEAD", i: "Reading diff" });
	 * ```
	 *
	 * This is how a script computes deterministic inputs — a work list, a diff, a
	 * test result — instead of paying an agent to go discover them. `Object.keys`
	 * lists what this run can call.
	 */
	readonly tool: ToolProxy;
}

/** Signature of a workflow module's default export. */
export type WorkflowScript = (wf: WorkflowHost, args: unknown) => Promise<unknown> | unknown;

/** A workflow definition located on disk. */
export interface WorkflowDefinition {
	name: string;
	description: string;
	whenToUse?: string;
	phases?: string[];
	path: string;
	level: "bundled" | "user" | "project";
}

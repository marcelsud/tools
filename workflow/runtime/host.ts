import { createHash } from "node:crypto";
import { runStructuredSubagent } from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import type { Tool, ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { AgentBudget } from "./budget";
import { WORKFLOW_TOOL_NAMES } from "./types";
import type {
	AgentOptions,
	AgentResult,
	BudgetSnapshot,
	CapabilityMode,
	ParallelJob,
	ToolCallResult,
	ToolFn,
	ToolProxy,
	WorkflowHost,
} from "./types";

/** A `complete()` call in flight. Not an Error, so a script's `catch` cannot swallow it. */
export class WorkflowCompletion {
	constructor(readonly value: unknown) {}
}

/** A child agent currently running, as last reported by the executor. */
export interface InflightAgent {
	label: string;
	agent: string;
	/** Tool the child is running right now, if any. */
	tool?: string;
	/** Short gist of what the child says it is doing. */
	intent?: string;
	toolCount: number;
	tokens: number;
	elapsedMs: number;
}

/**
 * `phase`/`log`/`agent` are the durable run log. `progress` is a live snapshot
 * of what the children are doing right now — it is streamed, never recorded,
 * because a long fan-out would otherwise bury the log in tool-by-tool noise.
 */
export interface RunEvent {
	kind: "phase" | "log" | "agent" | "progress";
	message: string;
	at: number;
	inflight?: InflightAgent[];
}

/** Children report per tool call; a wide panel would otherwise emit faster than anything can read. */
const PROGRESS_COALESCE_MS = 1000;

export interface HostOptions {
	session: ToolSession;
	budget: AgentBudget;
	args: unknown;
	/** omp's built-in tools, built from {@link HostOptions.session}. */
	tools: Tool[];
	/** Model used by any agent call that does not name its own. Overrides the session default. */
	defaultModel?: string | string[];
	signal?: AbortSignal;
	/** Called for every phase/log/agent event, for streaming into the tool block. */
	onEvent: (event: RunEvent) => void;
}

/**
 * Capability modes map to agent definitions, because the subagent executor has
 * no per-spawn tool override — a mode enforced only by prompt text is not
 * enforced at all. `read-only` lands on the bundled `scout`, whose definition
 * carries the read-only tool set; the writing modes land on `task`.
 *
 * Override per call with `opts.agent` when a project ships a purpose-built
 * agent definition.
 */
const CAPABILITY_AGENTS: Record<CapabilityMode, string> = {
	"read-only": "scout",
	"read-write": "task",
	execute: "task",
	all: "task",
};

function describeError(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

/** Run thunks with a bounded width, preserving input order. `width <= 0` means unbounded. */
async function boundedAll<T>(thunks: Array<() => Promise<T>>, width: number): Promise<T[]> {
	if (width <= 0 || width >= thunks.length) return Promise.all(thunks.map(thunk => thunk()));

	const results = new Array<T>(thunks.length);
	let next = 0;
	const workers = Array.from({ length: width }, async () => {
		for (;;) {
			const index = next++;
			const thunk = thunks[index];
			if (!thunk) return;
			results[index] = await thunk();
		}
	});
	await Promise.all(workers);
	return results;
}

/**
 * Remove a trailing notice plus one surrounding newline on each side. Mirrors
 * `stripTrailingNotice` in `tools/bash.ts`, which is private: the notice is
 * reconstructed from the value the result was tagged with, so a literal
 * substring match can never strip a coincidental token out of real output.
 */
function stripNotice(text: string, notice: string): string {
	const index = text.lastIndexOf(notice);
	if (index === -1) return text;
	let start = index;
	let end = index + notice.length;
	if (text[start - 1] === "\n") start -= 1;
	if (text[end] === "\n") end += 1;
	return (text.slice(0, start) + text.slice(end)).trimEnd();
}

/**
 * Undo `bash`'s display affordances so a script parses real output.
 *
 * - `Wall time: …` and `Command exited with code …` are appended for the TUI
 *   footer (`tools/bash.ts`); a script reading `git ls-files` would otherwise
 *   treat "Wall time: 0.06 seconds" as a filename. Both stay on `details`.
 * - Empty output becomes the literal `(no output)` (`tools/bash.ts:539`), which
 *   made an empty `git diff` read as a dirty working tree.
 */
function stripToolNotices(text: string, details: unknown): string {
	if (details === null || typeof details !== "object") return text;
	const { wallTimeMs, exitCode } = details as { wallTimeMs?: unknown; exitCode?: unknown };
	let output = text;
	if (typeof exitCode === "number") output = stripNotice(output, `Command exited with code ${exitCode}`);
	if (typeof wallTimeMs === "number") {
		output = stripNotice(output, `Wall time: ${(wallTimeMs / 1000).toFixed(2)} seconds`);
	}
	return output.trim() === "(no output)" ? "" : output;
}

export class WorkflowHostImpl implements WorkflowHost {
	readonly args: unknown;
	readonly cwd: string;
	readonly tool: ToolProxy;
	readonly events: RunEvent[] = [];
	#currentPhase: string | undefined;
	readonly #options: HostOptions;
	/** Live children, keyed by label. Entries appear on launch and vanish on settle. */
	readonly #inflight = new Map<string, InflightAgent>();
	#lastProgressAt = 0;
	#toolCallSeq = 0;

	constructor(options: HostOptions) {
		this.#options = options;
		this.args = options.args;
		this.cwd = options.session.cwd;

		// A plain object, not a Proxy, so `Object.keys(wf.tool)` lists what this run
		// can call. Every known built-in gets an entry: one the settings did not
		// construct throws and names itself, instead of surfacing as
		// "undefined is not a function" three frames away.
		const proxy: Record<string, ToolFn> = {};
		for (const name of WORKFLOW_TOOL_NAMES) {
			proxy[name] = () => {
				throw new Error(
					`tool \`${name}\` is not available in this run (built: ${options.tools.map(t => t.name).join(", ")})`,
				);
			};
		}
		for (const tool of options.tools) {
			proxy[tool.name] = argsForTool => this.#callTool(tool, argsForTool);
		}
		this.tool = proxy as ToolProxy;
	}

	/** Invoke one built-in exactly as the agent loop would, and hand the script the result. */
	async #callTool(tool: Tool, args: unknown): Promise<ToolCallResult> {
		const result = await tool.execute(`wf-${tool.name}-${this.#toolCallSeq++}`, args, this.#options.signal);
		const raw = result.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map(block => block.text)
			.join("");
		const details = result.details;
		const isError =
			result.isError === true ||
			(details !== null && typeof details === "object" && (details as { isError?: unknown }).isError === true);
		return { text: stripToolNotices(raw, details), details, isError };
	}

	get currentPhase(): string | undefined {
		return this.#currentPhase;
	}

	phase(title: string): void {
		this.#currentPhase = title;
		this.#emit("phase", title);
	}

	log(message: string): void {
		this.#emit("log", message);
	}

	complete(value: unknown): never {
		throw new WorkflowCompletion(value);
	}

	budget(): BudgetSnapshot {
		return this.#options.budget.snapshot();
	}

	json(value: unknown): string {
		return JSON.stringify(value) ?? "null";
	}

	fingerprint(text: string): string {
		return createHash("sha256").update(text).digest("hex").slice(0, 16);
	}

	async agent(prompt: string, opts: AgentOptions = {}): Promise<AgentResult> {
		this.#options.budget.admit(1);
		return this.#launch(prompt, opts);
	}

	async parallel(jobs: ParallelJob[]): Promise<(AgentResult | null)[]> {
		if (jobs.length === 0) return [];
		// Atomic admission: the whole panel, or nothing.
		this.#options.budget.admit(jobs.length);

		const width = this.#options.session.settings.get("task.maxConcurrency") ?? 0;
		this.#emit("log", `parallel: ${jobs.length} agent(s), width ${width || "unbounded"}`);

		return boundedAll(
			jobs.map(({ prompt, ...opts }) => async (): Promise<AgentResult | null> => {
				const result = await this.#launch(prompt, opts);
				return result.success ? result : null;
			}),
			typeof width === "number" ? width : 0,
		);
	}

	#emit(kind: Exclude<RunEvent["kind"], "progress">, message: string): void {
		const event: RunEvent = { kind, message, at: Date.now() };
		this.events.push(event);
		this.#options.onEvent(event);
	}

	/**
	 * Stream a snapshot of every live child. Coalesced: children report on every
	 * tool call, and three of them together will emit far faster than a human or
	 * a transcript can absorb.
	 */
	#emitProgress(force: boolean): void {
		const now = Date.now();
		if (!force && now - this.#lastProgressAt < PROGRESS_COALESCE_MS) return;
		this.#lastProgressAt = now;
		const inflight = [...this.#inflight.values()];
		this.#options.onEvent({
			kind: "progress",
			message: `${inflight.length} agent(s) in flight`,
			at: now,
			inflight,
		});
	}

	async #launch(prompt: string, opts: AgentOptions): Promise<AgentResult> {
		const capability = opts.capability ?? "read-only";
		const agentName = opts.agent ?? CAPABILITY_AGENTS[capability];
		const label = opts.label ?? agentName;
		const model = opts.model ?? this.#options.defaultModel;
		const started = Date.now();
		this.#inflight.set(label, { label, agent: agentName, toolCount: 0, tokens: 0, elapsedMs: 0 });
		this.#emitProgress(true);

		try {
			const execution = await runStructuredSubagent({
				session: this.#options.session,
				invocationKind: "eval",
				assignment: prompt,
				agent: agentName,
				identity: { label },
				keepAlive: false,
				shareEvalSession: false,
				enableIrc: false,
				maxRuntimeMs: 0,
				...(model !== undefined ? { model } : {}),
				...(opts.context !== undefined ? { context: opts.context } : {}),
				...(opts.effort !== undefined ? { effort: opts.effort } : {}),
				...(Object.hasOwn(opts, "schema") ? { outputSchema: opts.schema } : {}),
				...(opts.schemaMode !== undefined ? { schemaMode: opts.schemaMode } : {}),
				...(this.#options.signal ? { signal: this.#options.signal } : {}),
				onProgress: progress => {
					const entry = this.#inflight.get(label);
					if (!entry) return;
					entry.toolCount = progress.toolCount;
					entry.tokens = progress.tokens;
					entry.elapsedMs = Date.now() - started;
					if (progress.currentTool) entry.tool = progress.currentTool;
					else delete entry.tool;
					if (progress.lastIntent) entry.intent = progress.lastIntent;
					this.#emitProgress(false);
				},
			});

			const { result } = execution;
			const durationMs = Date.now() - started;
			const failed = result.exitCode !== 0 || Boolean(result.error) || Boolean(result.aborted);
			if (failed) {
				const error = result.error ?? result.stderr.trim() ?? "subagent failed";
				this.#emit("agent", `${label} failed: ${error}`);
				return { agentId: result.id, success: false, output: result.output, error, tokensUsed: result.tokens, durationMs };
			}

			const structured = result.structuredOutput;
			const hasData = structured !== undefined && structured.source !== "none" && Object.hasOwn(structured, "data");
			this.#emit("agent", `${label} ok (${result.tokens} tok, ${durationMs}ms)`);
			return {
				agentId: result.id,
				success: true,
				output: hasData ? structured.data : result.output,
				tokensUsed: result.tokens,
				durationMs,
			};
		} catch (error) {
			// Cancellation is infrastructure failure: it must abort the run, not
			// look like a reviewer who found nothing.
			if (this.#options.signal?.aborted) throw error;
			const message = describeError(error);
			this.#emit("agent", `${label} failed: ${message}`);
			return {
				agentId: label,
				success: false,
				output: undefined,
				error: message,
				tokensUsed: 0,
				durationMs: Date.now() - started,
			};
		} finally {
			this.#inflight.delete(label);
			this.#emitProgress(true);
		}
	}
}

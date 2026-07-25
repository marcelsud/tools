import type { BudgetSnapshot } from "./types";

export const DEFAULT_AGENT_BUDGET = 128;
export const MIN_AGENT_BUDGET = 1;
export const MAX_AGENT_BUDGET = 1024;

/** Thrown when a launch would exceed the run's absolute agent-call cap. */
export class BudgetExhaustedError extends Error {
	constructor(
		readonly requested: number,
		readonly snapshot: BudgetSnapshot,
	) {
		super(
			`agent budget exhausted: needed ${requested}, ${snapshot.remaining} of ${snapshot.total} remaining ` +
				`(spent ${snapshot.spent}). Raise agent_budget or shrink the fan-out.`,
		);
		this.name = "BudgetExhaustedError";
	}
}

/**
 * One absolute cumulative cap on logical agent calls for a whole run.
 *
 * A live `agent()` spends 1. Every slot of a `parallel()` panel spends 1,
 * admitted *before* anything launches — a panel that would overrun the cap
 * launches nothing, so a fan-out can never half-run and strand the verification
 * phase with no budget left.
 *
 * Schema-correction retries inside one logical call do not spend.
 */
export class AgentBudget {
	readonly total: number;
	#spent = 0;

	constructor(total: number = DEFAULT_AGENT_BUDGET) {
		if (!Number.isFinite(total)) throw new RangeError("agent budget must be a finite number");
		this.total = Math.min(MAX_AGENT_BUDGET, Math.max(MIN_AGENT_BUDGET, Math.trunc(total)));
	}

	get spent(): number {
		return this.#spent;
	}

	get remaining(): number {
		return this.total - this.#spent;
	}

	snapshot(): BudgetSnapshot {
		return { total: this.total, spent: this.#spent, reserved: 0, remaining: this.remaining };
	}

	/** Atomically admit `count` launches, or admit none and throw. */
	admit(count: number): void {
		if (count <= 0) return;
		if (count > this.remaining) throw new BudgetExhaustedError(count, this.snapshot());
		this.#spent += count;
	}
}

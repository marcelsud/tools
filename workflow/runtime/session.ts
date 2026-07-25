import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

/**
 * Inputs a custom tool can actually reach: `CustomToolAPI` gives cwd, and
 * `CustomToolContext` gives settings, the readonly session manager and the
 * caller's `local://` root.
 */
export interface SessionShimInput {
	cwd: string;
	settings?: Settings;
	artifactsDir?: string | null;
	sessionId?: string | null;
	sessionFile?: string | null;
	localProtocolOptions?: ToolSession["localProtocolOptions"];
}

/**
 * The `ToolSession` a workflow run executes against — for its own tool registry
 * and for every child it spawns.
 *
 * A custom tool is never handed the live `ToolSession` the built-in tools close
 * over, so we synthesize one. Three settings are load-bearing, and all three
 * were verified by spawning a `scout` (declared tools:
 * `read, grep, glob, web_search, yield`) and asking it to write a file:
 *
 * - **`tools.xdev: false`** — with xdev on, `createTools` mounts built-ins under
 *   `xd://` and then force-adds `write` so `write xd://<tool>` can dispatch
 *   (`tools/index.ts:643`). The scout got `write` and created the file. An agent
 *   definition's tool list is only honored with xdev off. Turning it off also
 *   keeps every built-in top-level in our own registry instead of hidden behind
 *   the device mount.
 * - **`enableMCP: false`** — otherwise children inherit the process's MCP tools.
 *   A "read-only" reviewer was handed `memory_write_page` and
 *   `memory_delete_page`.
 * - **`customToolPaths: []`** — otherwise children rediscover `workflow` itself
 *   from disk and can launch nested runs outside the parent's budget.
 *
 * `taskDepth: 1` marks children one level below the caller so omp's own
 * recursion gating still applies. LSP is off: workflow children are short-lived
 * and would each pay a cold language-server start.
 */
export function createWorkflowToolSession(input: SessionShimInput): ToolSession {
	// Derived rather than reused: the caller's settings have xdev on, which
	// silently defeats per-agent tool restriction.
	const settings = Settings.isolated({
		"async.enabled": false,
		"task.isolation.mode": "none",
		"tools.xdev": false,
		"task.maxConcurrency": input.settings?.get("task.maxConcurrency") ?? 32,
	});
	const artifactsDir = input.artifactsDir ?? null;
	const sessionFile = input.sessionFile ?? null;
	const sessionId = input.sessionId ?? null;

	return {
		cwd: input.cwd,
		hasUI: false,
		settings,
		taskDepth: 1,
		enableLsp: false,
		enableIrc: false,
		enableMCP: false,
		customToolPaths: [],
		suppressSpawnAdvisory: true,
		getSessionFile: () => sessionFile,
		getSessionId: () => sessionId,
		getSessionSpawns: () => "*",
		getArtifactsDir: () => artifactsDir,
		...(input.localProtocolOptions ? { localProtocolOptions: input.localProtocolOptions } : {}),
	};
}

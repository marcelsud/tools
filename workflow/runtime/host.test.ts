import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Settings, resetSettingsForTest } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createTools } from "@oh-my-pi/pi-coding-agent/tools";
import { AgentBudget } from "./budget";
import { WorkflowHostImpl } from "./host";
import { createWorkflowToolSession } from "./session";

let host: WorkflowHostImpl;
let cwd: string;

beforeAll(async () => {
	// executeBash reads Settings.instance for output caps; pin the regression
	// condition so user config cannot disable column or head truncation.
	resetSettingsForTest();
	await Settings.init({
		inMemory: true,
		overrides: {
			"tools.outputMaxColumns": 768,
			"tools.artifactHeadBytes": 20,
		},
	});

	cwd = await mkdtemp(join(tmpdir(), "wf-host-test-"));
	const session = createWorkflowToolSession({
		cwd,
		settings: Settings.isolated({
			"tools.outputMaxColumns": 768,
			"tools.artifactHeadBytes": 20,
			"async.enabled": false,
			"task.isolation.mode": "none",
			"tools.xdev": false,
		}),
	});
	const tools = await createTools(session);
	host = new WorkflowHostImpl({
		session,
		budget: new AgentBudget(1),
		args: undefined,
		tools,
		onEvent: () => {},
	});
});

afterAll(async () => {
	await rm(cwd, { recursive: true, force: true });
	resetSettingsForTest();
});

describe("WorkflowHost tool truncation + sh", () => {
	test("short bash output is not truncated", async () => {
		const result = await host.tool.bash({ command: "printf short", i: "short output" });
		expect(result.isError).toBe(false);
		expect(result.truncated).toBe(false);
		expect(result.text).toContain("short");
	});

	test("a 5000-char single line sets truncated via column metadata", async () => {
		const result = await host.tool.bash({
			command: "printf 'x%.0s' $(seq 1 5000)",
			i: "wide line",
		});
		expect(result.isError).toBe(false);
		expect(result.truncated).toBe(true);
		expect(result.text.length).toBeLessThan(5000);
	});

	test("seq 1 40000 sets truncated via total-length metadata", async () => {
		const result = await host.tool.bash({
			command: "seq 1 40000",
			i: "long output",
		});
		expect(result.isError).toBe(false);
		expect(result.truncated).toBe(true);
	});

	test("wf.sh returns complete streams and real exit codes", async () => {
		const result = await host.sh("printf 'x%.0s' $(seq 1 5000); printf boom >&2; exit 7");
		expect(result.stdout).toHaveLength(5000);
		expect(result.stdout).toBe("x".repeat(5000));
		expect(result.stderr).toBe("boom");
		expect(result.exitCode).toBe(7);
	});
});

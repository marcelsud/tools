# omp custom tools

## `workflow` — deterministic multi-agent workflows

A workflow is a saved script that fans out self-contained subagents, barriers on their
structured results, verifies claims in code rather than in prose, and returns one artifact
under a hard agent-call budget.

The split that makes it worth having: **scripts orchestrate, agents judge.** Scope, budgets,
filters and gates live in the script. An invariant stated only in a prompt is not enforced.

### Bundled workflows

**`review-changes`** — reviews a diff target across three dimensions in parallel, then makes
independent skeptics verify every finding. A finding survives only with quoted evidence.

```jsonc
{ "op": "run", "name": "review-changes", "args": { "target": "origin/main...HEAD" } }
```

**`ship-change`** — plans, implements, then gates behind QA and code review by four different
models, so the implementer never grades its own work. Fails closed: if the gate does not
clear within the repair budget, the change stays uncommitted.

| phase | role | default model |
|---|---|---|
| Plan | read-only planner | `openai-codex/gpt-5.6-sol` |
| Implement | read-write coder | `xai-oauth/grok-4.5` |
| Gate | QA, runs the verify command | `openai-codex/gpt-5.6-sol` |
| Gate | code reviewer, read-only | `anthropic/claude-opus-5` |

QA and review run as one parallel panel and never see each other's verdict. Override any role
via `args.models`.

```jsonc
{ "op": "run", "name": "ship-change", "agent_budget": 12,
  "args": { "task": "Fix the bugs in src/cart.js and add tests proving each fix",
            "verify": ["bun", "test"], "maxRepairRounds": 1 } }
```

It requires a clean working tree, so the diff it reviews is the change it made, and it never
commits.

### Install

The loader scans `<config>/tools/<name>/index.ts`, and `entry.isDirectory()` rejects a
symlinked directory — so link the *entry file*, not the folder:

```bash
mkdir -p ~/.omp/agent/tools/workflow
ln -sfn "$PWD/workflow/index.ts" ~/.omp/agent/tools/workflow/index.ts
```

Node resolves the module's relative imports against the symlink's realpath, so the runtime
loads from this repo and edits take effect on the next omp start.

Project scope works the same way under `<repo>/.omp/tools/workflow/index.ts`.

### Using it

```jsonc
{ "op": "list" }                                            // definitions across all scopes
{ "op": "validate", "name": "review-changes",               // smoke check, no real agents
  "args": { "target": "origin/main...HEAD" } }
{ "op": "run", "name": "review-changes",                    // blocking real run
  "args": { "target": "origin/main...HEAD" },
  "agent_budget": 24, "model": "grok-composer-2.5-fast" }
```

`model` sets the default for every agent call the script does not pin itself.
`agent_budget` is an absolute cap on logical agent calls (default 128, range 1–1024).

`validate` checks the metadata, scans the source for wall-clock and RNG use, then runs **one**
path with canned agent results and built-ins that return empty output. It does not enumerate
branches or touch the workspace. A script that short-circuits on an empty diff or a clean tree
will end early under those canned values — the report warns when the dry path reached no agent
call at all.

### Writing one

Definitions are plain ES modules. Discovery order, later scopes shadowing earlier ones:

| Scope | Path |
|---|---|
| bundled | `workflow/workflows/*.ts` |
| user | `~/.omp/agent/workflows/*.ts` |
| project | `<repo>/.omp/workflows/*.ts` |

```ts
import type { WorkflowHost, WorkflowMeta } from "../runtime/types";

export const meta: WorkflowMeta = {
  name: "my-workflow",          // slug: lowercase, digits, hyphens
  description: "One line.",
  phases: ["Gather", "Decide"], // UI rail; titles should match phase() calls
};

export default async function (wf: WorkflowHost, args: unknown) {
  // Compute the work list with omp's own tools, deterministically.
  const { text, isError } = await wf.tool.bash({ command: "git diff HEAD", i: "Reading diff" });
  if (isError) throw new Error(text);

  wf.phase("Gather");
  const results = await wf.parallel(
    ["a", "b"].map(item => ({
      prompt: `Do ${item}. …`,
      label: `gather:${item}`,
      capability: "read-only",
      model: "openai-codex/gpt-5.6-sol",
      schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
    })),
  );
  wf.complete({ hits: results.filter(r => r?.success).length });
}
```

Host API: `agent`, `parallel`, `phase`, `log`, `complete`, `budget`, `json`, `fingerprint`,
plus `args`, `cwd`, and `tool`. Every call blocks; `parallel` is the only concurrency and it
is a barrier.

### `wf.tool` — omp's built-ins, callable from the script

A run builds the same built-in registry the agent loop would (`read`, `grep`, `glob`, `bash`,
`edit`, `write`, `ast_edit`, `eval`, `task`, `todo`, `web_search`, `hub`, `browser`, `debug`).
There is no bespoke `exec` or `gitDiffSince`: anything the agent can do, the script can do,
deterministically and without spending budget.

```ts
const hits = await wf.tool.grep({ pattern: "TODO\\(perf\\)", path: "src", i: "Finding work" });
const run  = await wf.tool.bash({ command: "bun test", i: "Running tests" });
if (run.isError) wf.log(`tests failed with ${(run.details as { exitCode?: number }).exitCode}`);
```

Each call returns `{ text, details, isError }`. Two `bash` display affordances are undone so
`text` is parseable: the `Wall time:`/`Command exited with code` footers are stripped (both
values remain on `details`), and the literal `(no output)` placeholder becomes `""` — without
that, an empty `git diff` reads as a dirty tree.

Every name in the list above always exists on `wf.tool`. One this run's settings did not
construct throws and names itself rather than being silently absent.

### Rules that are load-bearing

- **Compute deterministic data in the script.** `capability: "read-only"` resolves to the
  `scout` agent, which has no shell. Telling such a child to "run `git diff`" makes it
  reconstruct the diff by hand out of `.git` objects: measured at 310s and 240k tokens for
  zero findings. Passing the diff in-script took the same run to 27s.
- **Guard every result.** A failed `parallel` slot is `null`, and a schema-valid output can
  still be unusable. Check `null`, then `success`, then the fields.
- **Re-check scope in code.** Filter agent-reported paths against `wf.cwd` yourself.
- **Use `wf.cwd`, never `process.cwd()`** — the latter is the omp process, not the workspace
  the run targets.
- **Leave budget for verification.** `parallel` admission is atomic: a panel that would
  overrun the cap launches nothing, so an oversized discovery phase fails loudly instead of
  half-running.
- **Proof gates fail closed.** Missing verdict, failed skeptic, or `real: true` with empty
  evidence all leave a claim unconfirmed.

### Capability modes, and how they are actually enforced

`capability` picks the agent definition a child runs as:

| mode | agent | tools |
|---|---|---|
| `read-only` (default) | `scout` | `read, grep, glob, web_search, yield` |
| `read-write` / `execute` / `all` | `task` | full set |

Override with `opts.agent` to use any discovered agent (`reviewer` adds `bash`, `lsp` and
`ast_grep` to a read-only set).

The restriction is real, but only because the run's session disables three things. Verified
by spawning a `scout` and asking it to write a file — with stock settings it **did**:

- `tools.xdev: false` — with xdev on, `createTools` mounts built-ins under `xd://` and then
  force-adds `write` so `write xd://<tool>` can dispatch (`tools/index.ts:643`). That handed
  a read-only reviewer a working `write`.
- `enableMCP: false` — otherwise children inherit process MCP tools; a reviewer was given
  `memory_write_page` and `memory_delete_page`.
- `customToolPaths: []` — otherwise children rediscover `workflow` itself and can launch
  nested runs outside the parent's budget.

With all three set, the child reports exactly its declared tools and the write fails. This is
tool-set restriction, not a sandbox: an `execute`-capable child has a real shell.

### Scope of this cut

Present: `list` / `validate` / `run`, absolute agent-call budget with atomic panel
admission, `parallel` barrier with `task.maxConcurrency` width, phases, live per-child
progress streaming, schema-validated structured output, capability→agent mapping,
three-scope discovery.

Absent by design:

- **No pause / resume.** Runs are blocking.
- **No journal.** Unnecessary while a run lives in-process; process death ends it.
- **No run dashboard.** A custom tool cannot own persistent UI; that needs an extension.
- **No sandbox.** Definitions are user-authored code running in the omp process, the same
  trust boundary as the custom tool loading them. `validate` scans for wall-clock and RNG
  use, which is a determinism check, not a security one.

### Verifying a change

```bash
bunx tsc --noEmit -p tsconfig.json     # must be clean
scripts/demo-repo.sh                   # fixture at /tmp/wf-demo: clean tree, 3 known bugs
```

Then exercise a workflow against the fixture. Expected results, both measured:

| workflow | expectation |
|---|---|
| `review-changes` on `HEAD~1...HEAD` | confirms the off-by-one, the unbounded discount and the uncaught `JSON.parse`, each with quoted evidence |
| `ship-change` with `verify: ["bun","test"]` | ships, and `bun test` in the fixture is green afterwards |

`AGENTS.md` has the module map, the in-process dev loop (drive `runWorkflow` directly instead
of restarting omp), and the traps worth knowing before editing the runtime.

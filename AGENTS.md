# Repo context

Custom tools for omp (oh-my-pi), plus standalone CLIs. **`workflow`** provides deterministic
multi-agent orchestration; **`viewdiff`** is a local Go/browser Git diff viewer, and
**`mdview`** is a local Markdown viewer and browser editor.
`README.md` is the reference; this file is what you need before touching code.

`viewdiff/` is an independent Go module with embedded browser assets in `web/`.
For ViewDiff changes, run `make -C viewdiff check` (Go vet, race tests, and Node.js
tests) and `make -C viewdiff build`. Its generated `bin/` directory is gitignored.

`mdview/` is an independent Go 1.25 module with embedded assets, Markdown editing,
and optional save events. Run `make -C mdview check` (Go vet, race tests, and Node.js
tests) and `make -C mdview build`. Its generated `bin/` directory is gitignored.

```
workflow/
  index.ts              the custom tool: op = list | validate | run
  runtime/
    types.ts            authoring surface (WorkflowHost) — the contract scripts see
    session.ts          synthetic ToolSession; three hardening settings, all load-bearing
    budget.ts           absolute agent-call cap, atomic panel admission
    host.ts             agent/parallel/phase/log/complete/sh + wf.tool proxy + progress
    registry.ts         discover + import definitions across bundled/user/project
    run.ts              runWorkflow (real) and validateWorkflow (canned dry run)
  workflows/            bundled definitions: review-changes, ship-change
scripts/demo-repo.sh    recreates the verification fixture
```

## Verify

```bash
scripts/setup.sh                       # only on a fresh clone: links @oh-my-pi
bunx tsc --noEmit -p tsconfig.json     # must be clean
scripts/demo-repo.sh                   # fixture at /tmp/wf-demo, tree clean, 3 known bugs
```

`node_modules/@oh-my-pi/*` are symlinks to your globally installed omp and are gitignored, so
a fresh clone needs `setup.sh` before anything typechecks.

Then exercise a workflow (see "Dev loop" below). `review-changes` on the fixture should
confirm the off-by-one, the unbounded discount and the uncaught `JSON.parse`. `ship-change`
should ship and leave `bun test` green in `/tmp/wf-demo`.

## Dev loop

Do **not** restart omp to test a runtime change. Import the runtime directly and drive it
with a synthetic session — this is how every claim in the README was verified:

```js
const RT = "<repo>/workflow/runtime";
const { runWorkflow } = await import(`${RT}/run.ts`);
const outcome = await runWorkflow({
  cwd: "/tmp/wf-demo", name: "review-changes",
  args: { target: "HEAD~1...HEAD" },
  agentBudget: 16, model: "grok-composer-2.5-fast",   // cheap model while iterating
  onEvent: e => console.log(e.kind, e.message),
});
```

Use a cheap model (`grok-composer-2.5-fast`) while iterating; the pinned per-role models in
`ship-change` are slow and expensive.

## Traps that already cost time

- **Module cache in the eval harness.** `import("run.ts?v=" + Date.now())` cache-busts only
  that specifier — its `./host` import still resolves to the stale module. Symptom was a
  bogus `paths[0] must be of type string` from a field that clearly existed. **Reset the JS
  VM instead of cache-busting.**
- **Install links the entry file, not the folder.** The loader's `entry.isDirectory()` skips
  a symlinked directory, so `~/.omp/agent/tools/workflow/` must be a real dir containing a
  symlink to `workflow/index.ts`.
- **Never `process.cwd()` in a workflow** — that is the omp process, not the run's workspace.
  Use `wf.cwd`.
- **`wf.tool.bash` is display-shaped; `wf.sh` is complete.** The host strips the
  `Wall time:` / `Command exited with code` footers and maps the literal `(no output)` to
  `""`, and sets `truncated` when omp reports total-length or per-line column cuts. Scripts
  that machine-parse command output must use `wf.sh(command)` for complete stdout/stderr —
  never parse truncated `wf.tool.bash` text. Removing the notice normalization still makes an
  empty `git diff` read as a dirty tree.
- **Capability restriction depends on three session settings** (`tools.xdev: false`,
  `enableMCP: false`, `customToolPaths: []`). Drop any one and a "read-only" child silently
  regains `write` or MCP mutators. See `runtime/session.ts` for the verified reasoning; do
  not "simplify" it away.
- **`validate` is one path with canned values**, not branch coverage. It warns when the dry
  path reached no agent call.

## Conventions

TypeScript, tabs, no `any`, `import type` for type-only imports. Comments explain *why*
(especially the non-obvious upstream behaviours above), never *what*.

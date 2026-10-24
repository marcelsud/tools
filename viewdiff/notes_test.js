const assert = require("node:assert/strict");
const test = require("node:test");
require("./web/notes.js");
const { Drafts, markdown, lineSelection } = globalThis.ViewdiffNotes;

const comparison = { repo: "/work/project", base: "main", mode: "branch", label: "main … feature + local changes", oldRevision: "abc123" };
const file = { path: "src/app.go", fingerprint: "first-version" };
const data = { ...comparison, files: [file] };
const note = { id: "one", path: file.path, side: "new", start: 2, end: 3, snippet: "first()\nsecond()", text: "Simplify this.", comparison, snapshot: JSON.stringify([comparison.oldRevision, file.fingerprint]) };
const lines = [{ number: 2, text: "first()" }, { number: 3, text: "second()" }, { number: 4, text: "third()" }];
function memoryStorage() {
  const values = new Map();
  return { getItem: (key) => values.get(key) || null, setItem: (key, value) => values.set(key, value) };
}

// Browser-authored review notes: inclusive source ranges and exact snippets, ready to paste into an agent.
test("given one line when selecting its gutter then its full source text is captured", () => {
  assert.deepEqual(lineSelection(lines, 2, 2), { start: 2, end: 2, snippet: "first()" });
});
test("given a reversed line range when selecting then endpoints are inclusive and ordered", () => {
  assert.deepEqual(lineSelection(lines, 4, 2), { start: 2, end: 4, snippet: "first()\nsecond()\nthird()" });
});
test("given a partial multiline snippet when selecting then only selected characters are captured", () => {
  assert.deepEqual(lineSelection(lines, 2, 3, 2, 4), { start: 2, end: 3, snippet: "rst()\nseco" });
});
test("given a selection ending at the next line start then the unselected line is excluded", () => {
  assert.deepEqual(lineSelection(lines, 2, 4, 2, 0), { start: 2, end: 3, snippet: "rst()\nsecond()" });
});
test("given a partial single line then both character boundaries are respected", () => {
  assert.deepEqual(lineSelection(lines, 2, 2, 1, 4), { start: 2, end: 2, snippet: "irs" });
});
test("given blank lines when selecting then their whitespace is preserved", () => {
  assert.deepEqual(lineSelection([{ number: 1, text: "\t" }, { number: 2, text: "" }], 1, 2), { start: 1, end: 2, snippet: "\t\n" });
});
test("given hidden context inside a selection then quoting the incomplete range is refused", () => {
  assert.throws(() => lineSelection([lines[0], lines[2]], 2, 4), /Expand the hidden context/);
});
test("given a saved note when refreshing the same viewer then it survives", () => {
  const storage = memoryStorage();
  new Drafts(storage, "launch-one").save(note);
  assert.deepEqual(new Drafts(storage, "launch-one").notes, [note]);
  assert.deepEqual(new Drafts(storage, "launch-two").notes, []);
});
test("given overlapping notes when editing or deleting then each note remains independent", () => {
  const drafts = new Drafts(memoryStorage(), "session");
  drafts.save(note);
  drafts.save({ ...note, id: "two", text: "Another concern." });
  drafts.save({ ...note, text: "Updated." });
  assert.deepEqual(drafts.notes.map((note) => note.text), ["Updated.", "Another concern."]);
  drafts.remove("one");
  assert.deepEqual(drafts.notes.map((note) => note.id), ["two"]);
});
test("given whitespace-only text then no empty note is added", () => {
  const drafts = new Drafts(memoryStorage(), "session");
  assert.throws(() => drafts.save({ ...note, text: " \n\t" }), /Write a note/);
  assert.equal(drafts.notes.length, 0);
});
test("given notes from multiple comparisons when clearing all then they stay cleared after reload without changing other storage", () => {
  const storage = memoryStorage();
  storage.setItem("preferences", "preserve me");
  const drafts = new Drafts(storage, "session");
  drafts.save(note);
  drafts.save({ ...note, id: "two", comparison: { ...comparison, mode: "staged" } });

  assert.equal(drafts.clear(), true);

  assert.deepEqual(drafts.notes, []);
  assert.deepEqual(new Drafts(storage, "session").notes, []);
  assert.equal(storage.getItem("preferences"), "preserve me");
});
test("given unavailable browser storage then drafts remain usable in memory", () => {
  const storage = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("quota"); } };
  const drafts = new Drafts(storage, "session");
  assert.equal(drafts.save(note), false);
  assert.deepEqual(drafts.notes, [note]);
});
test("given corrupted saved data then the notes UI can still start", () => {
  for (const value of ["not JSON", "null", "{}", '[{},null,{"id":1}]']) {
    const drafts = new Drafts({ getItem: () => value }, "session");
    assert.deepEqual(drafts.notes, []);
  }
});
test("given unchanged source when listing notes then their anchors remain current", () => {
  const drafts = new Drafts(memoryStorage(), "session");
  drafts.save(note);
  assert.equal(drafts.list(data)[0].stale, false);
});
test("given changed source or base revision then the original snippet is preserved and marked stale", () => {
  const drafts = new Drafts(memoryStorage(), "session");
  drafts.save(note);
  for (const changed of [{ ...data, files: [{ ...file, fingerprint: "changed" }] }, { ...data, oldRevision: "new-base" }, { ...data, files: [] }]) {
    const result = drafts.list(changed)[0];
    assert.equal(result.stale, true);
    assert.equal(result.snippet, note.snippet);
  }
});
test("given a different repository or comparison then notes never attach to its source", () => {
  const drafts = new Drafts(memoryStorage(), "session");
  drafts.save(note);
  for (const changed of [{ ...data, repo: "/different/repo" }, { ...data, mode: "staged" }, { ...data, label: "main … other" }]) {
    assert.equal(drafts.list(changed)[0].sameComparison, false);
    assert.equal(drafts.list(changed)[0].stale, true);
  }
});
test("given notes for removed or renamed code then Markdown identifies the original side and path", () => {
  const text = markdown([{ ...note, sourcePath: "src/before.go", side: "old", stale: true }]);
  assert.ok(text.includes("src/before.go · old lines 2–3"));
  assert.ok(text.includes("Repository: /work/project"));
  assert.ok(text.includes("Comparison: main … feature + local changes"));
  assert.ok(text.includes("Base revision: abc123"));
  assert.ok(text.includes("Location may be stale"));
  assert.ok(text.includes("```\nfirst()\nsecond()\n```\n\nSimplify this."));
});
test("given snippets containing Markdown fences then export keeps the complete code block intact", () => {
  const text = markdown([{ ...note, snippet: "```js\nconst text = `hello`;\n```" }]);
  assert.ok(text.includes("````\n```js\nconst text = `hello`;\n```\n````"));
});
test("given multiple notes then Markdown preserves their order and multiline feedback", () => {
  const text = markdown([note, { ...note, start: 9, end: 9, text: "Check this.\nAnd this." }]);
  assert.ok(text.indexOf("## 1.") < text.indexOf("## 2."));
  assert.ok(text.includes("new line 9"));
  assert.ok(text.includes("Check this.\nAnd this."));
  assert.equal(markdown([]), "");
});

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

class Element {
  constructor(tag) {
    this.tag = tag;
    this.attrs = {};
    this.children = [];
    this.classes = new Set();
    this.classList = {
      add: (value) => this.classes.add(value),
      contains: (value) => this.classes.has(value),
      toggle: (value, force = !this.classes.has(value)) => { force ? this.classes.add(value) : this.classes.delete(value); return force; },
    };
  }
  setAttribute(key, value) { this.attrs[key] = String(value); if (key === "class") this.classes = new Set(value.split(" ")); }
  getAttribute(key) { return this.attrs[key] ?? null; }
  set title(value) { this.attrs.title = value; }
  get title() { return this.attrs.title ?? ""; }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return (this.text ?? "") + this.children.map((child) => child.textContent).join(""); }
  get firstChild() { return this.children[0] || null; }
  append(...children) { for (const child of children) this.insertBefore(child, null); }
  insertBefore(child, anchor) {
    if (child === anchor) return;
    if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1);
    const index = anchor ? this.children.indexOf(anchor) : this.children.length;
    assert.ok(index >= 0, "anchor belongs to parent");
    this.children.splice(index, 0, child); child.parent = this;
  }
  replaceChildren(...children) { this.children = []; this.text = ""; this.append(...children); }
  addEventListener() {}
  querySelectorAll(selector) {
    const match = (element) => {
      if (selector.startsWith("tr[")) return element.tag === "tr" && (element.attrs["data-old-line"] || element.attrs["data-new-line"]);
      const side = selector.match(/^\[data-side="(old|new)"\]$/);
      if (side) return element.attrs["data-side"] === side[1];
      if (selector.startsWith(".")) return element.classes.has(selector.slice(1));
      return element.tag === selector;
    };
    const result = [];
    const walk = (element) => { for (const child of element.children) { if (match(child)) result.push(child); walk(child); } };
    walk(this); return result;
  }
}

function viewer(layout = "split") {
  const elements = new Map();
  const context = vm.createContext({
    console, URL, AbortController,
    location: { href: "http://127.0.0.1:12345/session/" },
    localStorage: { getItem: () => null },
    matchMedia: () => ({ matches: false }),
    fetch: async () => { const error = new Error("skip initial load"); error.name = "AbortError"; throw error; },
    ViewdiffPreferences: class { get(name, fallback) { return fallback; } async load() {} set() {} },
    document: {
      documentElement: { dataset: {} },
      createElement: (tag) => new Element(tag),
      createTextNode: (text) => { const node = new Element("#text"); node.textContent = text; return node; },
      addEventListener() {},
      querySelector(selector) { if (!elements.has(selector)) elements.set(selector, new Element("div")); return elements.get(selector); },
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "web/notes.js"), "utf8"), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "web/app.js"), "utf8"), context);
  context.testLayout = layout;
  vm.runInContext("state.layout = testLayout", context);
  return context;
}

function comment(start, end, text, side = "new") { return { start, end, text, side }; }

test("split view anchors repeated overlapping notes on the correct side", () => {
  const context = viewer();
  const body = new Element("tbody");
  context.row(body, { type: "deletion", oldLine: 99, text: "old" }, { type: "addition", newLine: 2, text: "new" });
  context.row(body, null, { type: "addition", newLine: 3, text: "more" });
  const rows = body.children.slice();
  context.annotateRows({ comments: [comment(2, 3, "first"), comment(3, 3, "second")] }, body);
  assert.equal(body.querySelectorAll(".review-note").length, 2);
  assert.ok(rows[0].querySelectorAll('[data-side="new"]').every((cell) => cell.classes.has("annotated")));
  assert.ok(rows[0].querySelectorAll('[data-side="old"]').every((cell) => !cell.classes.has("annotated")));
  assert.equal(rows[1].querySelectorAll('[data-side="new"]')[0].title, "first\n\nsecond");
  assert.equal(body.children[0].querySelectorAll(".note-label")[0].textContent, "Review note");
});

test("unified view can annotate removed lines", () => {
  const context = viewer("unified");
  const body = new Element("tbody");
  context.row(body, { type: "deletion", oldLine: 99, text: "removed" }, null);
  context.annotateRows({ comments: [comment(99, 99, "reason for removal", "old")] }, body);
  assert.equal(body.querySelectorAll(".review-note").length, 1);
  assert.equal(body.querySelectorAll(".note-range")[0].textContent, "Old lines 99–99");
  assert.ok(body.querySelectorAll('[data-side="old"]').every((cell) => cell.classes.has("annotated")));
  assert.ok(body.querySelectorAll('[data-side="new"]').every((cell) => !cell.classes.has("annotated")));
});

test("comment markup stays literal and multi-line text is preserved", () => {
  const context = viewer();
  const text = '<img src=x onerror="alert(1)">\n<script>literal</script>';
  const note = context.reviewNote(comment(1, 2, text));
  assert.equal(note.querySelectorAll("img").length, 0);
  assert.equal(note.querySelectorAll("script").length, 0);
  assert.equal(note.querySelectorAll(".note-text")[0].textContent, text);
  assert.equal(note.querySelectorAll("summary")[0].title, text);
});

test("callout labels are arbitrary literal text", () => {
  const context = viewer();
  for (const label of ["Notes", "Context: API", "説明 ✓", '<img src=x onerror="alert(1)">']) {
    const note = context.reviewNote({ ...comment(123, 456, "something something"), label });
    assert.equal(note.querySelectorAll(".note-label")[0].textContent, label);
    assert.equal(note.querySelectorAll("img").length, 0);
    assert.equal(note.querySelectorAll(".note-range")[0].textContent, "New lines 123–456");
    assert.equal(note.querySelectorAll(".note-text")[0].textContent, "something something");
  }
});

test("stale notes remain readable without highlighting changed source", () => {
  const context = viewer();
  const body = new Element("tbody");
  context.row(body, null, { type: "addition", newLine: 2, text: "changed again" });
  context.annotateRows({ comments: [{ ...comment(2, 2, "old explanation"), stale: true }] }, body);
  assert.equal(body.querySelectorAll(".annotated").length, 0);
  assert.equal(body.querySelectorAll(".note-warning")[0].textContent, "Diff changed · check this note");
});

test("notes outside the visible diff preserve argument order", () => {
  const context = viewer();
  const body = new Element("tbody");
  context.row(body, null, { type: "addition", newLine: 1, text: "visible" });
  context.annotateRows({ comments: [comment(123, 456, "first"), comment(456, 457, "second")] }, body);
  assert.deepEqual(body.querySelectorAll(".note-text").map((note) => note.textContent), ["first", "second"]);
});

test("hidden-context notes move beside their source when context expands", () => {
  const context = viewer();
  const file = { id: "0", path: "app.go", status: "M", comments: [comment(2, 2, "hidden section")], hunks: [{ oldStart: 4, newStart: 4, header: "@@ -4 +4 @@", lines: [{ type: "context", oldLine: 4, newLine: 4, text: "four" }] }] };
  const memo = { gaps: new Set(), full: false, content: null };
  context.testMemo = memo;
  vm.runInContext("state.files.set('0', testMemo)", context);
  const target = new Element("div");
  context.renderBody(file, target);
  assert.equal(target.querySelectorAll(".annotated").length, 0);
  assert.ok(target.textContent.includes("Outside visible diff"));
  memo.content = ["one", "two", "three", "four"];
  memo.gaps.add("1:3");
  context.renderBody(file, target);
  assert.ok(target.querySelectorAll(".annotated").length > 0);
  assert.ok(!target.textContent.includes("Outside visible diff"));
  assert.equal(target.querySelectorAll(".review-note").length, 1);
});

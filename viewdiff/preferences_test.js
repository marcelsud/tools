const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "web/preferences.js"), "utf8");
function viewer(fetch, stored = new Map(), storageDisabled = false) {
  const context = vm.createContext({
    URL, fetch, console,
    location: { href: "http://127.0.0.1:12345/session/" },
    localStorage: {
      getItem(key) { if (storageDisabled) throw new Error("blocked"); return stored.get(key) ?? null; },
      setItem(key, value) { if (storageDisabled) throw new Error("blocked"); stored.set(key, value); },
    },
  });
  vm.runInContext(source, context);
  return new context.ViewdiffPreferences();
}

test("shared preferences restore on a fresh origin and mirror into localStorage", async () => {
  const stored = new Map();
  const prefs = viewer(async () => ({ ok: true, json: async () => ({ theme: "dark", layout: "unified", wrap: true, sidebar: false }) }), stored);
  await prefs.load();
  assert.equal(prefs.get("theme"), "dark");
  assert.equal(prefs.get("layout"), "unified");
  assert.equal(prefs.get("wrap"), true);
  assert.equal(prefs.get("sidebar"), false);
  assert.equal(stored.get("viewdiff.wrap"), "true");
  assert.equal(stored.get("viewdiff.layout"), "unified");
});

test("rapid changes persist in order and include explicit false", async () => {
  const updates = [];
  const stored = new Map();
  const prefs = viewer(async (url, options) => {
    assert.equal(url.pathname, "/session/api/preferences");
    assert.equal(options.method, "PATCH");
    assert.equal(options.keepalive, true);
    updates.push(JSON.parse(options.body));
    return { ok: true };
  }, stored);
  prefs.set("layout", "unified");
  prefs.set("layout", "split");
  prefs.set("wrap", true);
  prefs.set("wrap", false);
  await prefs.pending;
  assert.deepEqual(updates, [{ layout: "unified" }, { layout: "split" }, { wrap: true }, { wrap: false }]);
  assert.equal(stored.get("viewdiff.wrap"), "false");
  assert.equal(prefs.get("layout"), "split");
});

test("a pending initial load does not overwrite user choices", async () => {
  let resolve;
  const response = new Promise((done) => { resolve = done; });
  const prefs = viewer(async (url, options) => options ? { ok: true } : response);
  const loading = prefs.load();
  prefs.set("theme", "light");
  resolve({ ok: true, json: async () => ({ theme: "dark", wrap: true }) });
  await loading;
  await prefs.pending;
  assert.equal(prefs.get("theme"), "light");
  assert.equal(prefs.get("wrap"), true);
});

test("unavailable shared store falls back to localStorage", async () => {
  const prefs = viewer(async () => { throw new Error("offline"); }, new Map([["viewdiff.theme", "dark"], ["viewdiff.wrap", "false"]]));
  await prefs.load();
  assert.equal(prefs.get("theme"), "dark");
  assert.equal(prefs.get("wrap"), false);
  assert.equal(prefs.get("layout", "split"), "split");
});

test("blocked localStorage and invalid preferences do not break the viewer", async () => {
  const prefs = viewer(async () => ({ ok: true, json: async () => ({ layout: "invalid", theme: "invalid", wrap: "yes", sidebar: false }) }), new Map(), true);
  await prefs.load();
  assert.equal(prefs.get("layout", "split"), "split");
  assert.equal(prefs.get("theme", "light"), "light");
  assert.equal(prefs.get("wrap", false), false);
  assert.equal(prefs.get("sidebar"), false);
});

test("toolbar restores preferences and persists mouse and keyboard changes", async () => {
  const values = { theme: "dark", layout: "unified", wrap: true, sidebar: false };
  const elements = new Map();
  const documentEvents = {};
  const document = {
    documentElement: { dataset: {} },
    addEventListener(name, callback) { documentEvents[name] = callback; },
    querySelector(selector) {
      if (!elements.has(selector)) {
        const classes = new Set();
        elements.set(selector, {
          events: {}, attrs: {},
          addEventListener(name, callback) { this.events[name] = callback; },
          setAttribute(name, value) { this.attrs[name] = value; },
          classList: {
            contains(name) { return classes.has(name); },
            toggle(name, force = !classes.has(name)) { if (force) classes.add(name); else classes.delete(name); return force; },
          },
        });
      }
      return elements.get(selector);
    },
  };
  const context = vm.createContext({
    document, URL, AbortController,
    location: { href: "http://127.0.0.1:12345/session/" },
    matchMedia: () => ({ matches: false }),
    fetch: async () => { const error = new Error("skip diff fixture"); error.name = "AbortError"; throw error; },
    ViewdiffPreferences: class {
      get(name, fallback) { return values[name] ?? fallback; }
      set(name, value) { values[name] = value; }
      async load() {}
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "web/app.js"), "utf8"), context);
  await new Promise(setImmediate);
  assert.equal(document.documentElement.dataset.theme, "dark");
  assert.equal(elements.get("#unified").attrs["aria-pressed"], "true");
  assert.equal(elements.get("#wrap").checked, true);
  assert.equal(elements.get("#diffs").classList.contains("wrap"), true);
  assert.equal(elements.get(".workspace").classList.contains("no-sidebar"), true);

  elements.get("#theme").events.click();
  elements.get("#split").events.click();
  elements.get("#wrap").checked = false;
  elements.get("#wrap").events.change();
  elements.get("#sidebar-toggle").events.click();
  assert.deepEqual(values, { theme: "light", layout: "split", wrap: false, sidebar: true });
  assert.equal(elements.get("#diffs").classList.contains("wrap"), false);
  documentEvents.keydown({ key: "u", target: { tagName: "BODY" } });
  assert.equal(values.layout, "unified");
});

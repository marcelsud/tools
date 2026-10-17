// localStorage is scoped to a port. The local API shares preferences across
// viewdiff launches, while localStorage remains a fallback for each origin.
globalThis.ViewdiffPreferences = class {
  constructor() {
    this.values = {};
    this.changed = new Set();
    this.pending = Promise.resolve();
    for (const name of ["theme", "layout", "wrap", "sidebar"]) {
      try {
        const value = localStorage.getItem(`viewdiff.${name}`);
        this.assign(name, ["wrap", "sidebar"].includes(name) ? (value === null ? undefined : value === "true") : value);
      } catch { /* Storage may be disabled; preferences still work in memory. */ }
    }
  }

  assign(name, value) {
    if (name === "theme" && !["dark", "light"].includes(value)) return;
    if (name === "layout" && !["split", "unified"].includes(value)) return;
    if (["wrap", "sidebar"].includes(name) && typeof value !== "boolean") return;
    if (!["theme", "layout", "wrap", "sidebar"].includes(name)) return;
    this.values[name] = value;
    try { localStorage.setItem(`viewdiff.${name}`, String(value)); } catch { /* Best effort. */ }
  }

  get(name, fallback) { return this.values[name] ?? fallback; }

  async load() {
    try {
      const response = await fetch(new URL("api/preferences", location.href));
      if (!response.ok) return;
      for (const [name, value] of Object.entries(await response.json())) {
        if (!this.changed.has(name)) this.assign(name, value);
      }
    } catch { /* Keep the localStorage fallback if the shared store is unavailable. */ }
  }

  set(name, value) {
    this.assign(name, value);
    this.changed.add(name);
    // Serialize writes so rapid toggles persist the final choice, not a stale one.
    this.pending = this.pending.then(async () => {
      try {
        const response = await fetch(new URL("api/preferences", location.href), {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ [name]: value }),
          keepalive: true,
        });
        if (!response.ok) console.warn("viewdiff: could not save shared preferences");
      } catch { console.warn("viewdiff: could not save shared preferences"); }
    });
  }
};

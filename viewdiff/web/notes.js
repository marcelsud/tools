(() => {
  const comparisonKey = (data) => JSON.stringify([data.repo, data.base, data.mode, data.label]);
  const snapshot = (data, file) => JSON.stringify([data.oldRevision, file.fingerprint]);
  const locationLabel = (note) => `${note.sourcePath || note.path} · ${note.side} ${note.start === note.end ? `line ${note.start}` : `lines ${note.start}–${note.end}`}`;
  const fenced = (text) => {
    const runs = text.match(/`+/g) || [];
    const fence = "`".repeat(Math.max(3, ...runs.map((run) => run.length + 1)));
    return `${fence}\n${text}\n${fence}`;
  };

  function markdown(notes) {
    if (!notes.length) return "";
    return "# Viewdiff review notes\n\n" + notes.map((note, index) => [
      `## ${index + 1}. ${locationLabel(note)}`,
      `Repository: ${note.comparison.repo}\nComparison: ${note.comparison.label}\nBase revision: ${note.comparison.oldRevision}`,
      ...(note.stale ? ["Location may be stale: the diff or comparison changed. The excerpt below is the original selection."] : []),
      fenced(note.snippet),
      note.text,
    ].join("\n\n")).join("\n\n") + "\n";
  }

  class Drafts {
    constructor(storage, key) {
      this.storage = storage;
      this.key = key;
      this.notes = [];
      try {
        const saved = JSON.parse(storage?.getItem(key) || "[]");
        if (Array.isArray(saved)) this.notes = saved.filter((note) =>
          note && ["id", "path", "snippet", "text", "snapshot"].every((key) => typeof note[key] === "string") &&
          ["old", "new"].includes(note.side) && Number.isInteger(note.start) && note.start > 0 &&
          Number.isInteger(note.end) && note.end >= note.start &&
          note.comparison && ["repo", "base", "mode", "label", "oldRevision"].every((key) => typeof note.comparison[key] === "string"));
      } catch { /* Drafts still work in memory when browser storage is unavailable. */ }
    }
    persist() {
      try { this.storage?.setItem(this.key, JSON.stringify(this.notes)); return Boolean(this.storage); }
      catch { return false; }
    }
    save(note) {
      if (!note.text.trim()) throw new Error("Write a note before adding it.");
      const value = { ...note, text: note.text.trim() };
      const index = this.notes.findIndex((item) => item.id === value.id);
      if (index === -1) this.notes.push(value); else this.notes[index] = value;
      return this.persist();
    }
    remove(id) { this.notes = this.notes.filter((note) => note.id !== id); return this.persist(); }
    clear() { this.notes = []; return this.persist(); }
    list(data) {
      return this.notes.map((note) => {
        const sameComparison = comparisonKey(note.comparison) === comparisonKey(data);
        const file = sameComparison && data.files.find((file) => file.path === note.path);
        return { ...note, sameComparison, stale: !file || note.snapshot !== snapshot(data, file) };
      });
    }
  }

  // A range belongs to one source side. Gaps must be expanded before their code can be quoted.
  function lineSelection(lines, start, end, startColumn = 0, endColumn = null) {
    const first = Math.min(start, end), last = Math.max(start, end);
    const selected = lines.filter((line) => line.number >= first && line.number <= last);
    if (selected.length !== last - first + 1 || selected.some((line, i) => line.number !== first + i)) {
      throw new Error("Expand the hidden context before selecting this range.");
    }
    const text = selected.map((line) => line.text);
    if (endColumn === 0 && text.length > 1) { text.pop(); selected.pop(); endColumn = null; }
    const finalIndex = text.length - 1;
    if (endColumn !== null) text[finalIndex] = text[finalIndex].slice(0, endColumn);
    text[0] = text[0].slice(startColumn);
    return { start: first, end: selected.at(-1).number, snippet: text.join("\n") };
  }

  const $ = (selector) => document.querySelector(selector);
  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function sourceCells(table, side) {
    return [...table.querySelectorAll(`tr[data-${side}-line]`)].flatMap((row) => {
      const cell = row.querySelector(`td.code[data-side="${side}"]`) || row.querySelector("td.code.context");
      return cell ? [{ cell, number: Number(row.getAttribute(`data-${side}-line`)), text: cell.textContent }] : [];
    });
  }
  function codeCell(node) { return (node.nodeType === 1 ? node : node.parentElement)?.closest("td.code"); }
  function column(cell, container, offset) {
    const range = document.createRange();
    range.selectNodeContents(cell);
    range.setEnd(container, offset);
    return range.toString().length;
  }

  class Controller {
    constructor(hooks) {
      this.hooks = hooks;
      this.pending = null;
      this.anchor = null;
      this.editing = null;
      let storage;
      try { storage = globalThis.sessionStorage; } catch { /* Use in-memory drafts. */ }
      this.drafts = new Drafts(storage, `viewdiff.notes:${new URL(location.href).pathname}`);
      $("#notes-toggle").addEventListener("click", () => this.toggle());
      $("#notes-close").addEventListener("click", () => this.toggle(false));
      $("#notes-copy").addEventListener("click", () => this.copy());
      $("#notes-clear").addEventListener("click", () => {
        const saved = this.drafts.clear();
        this.hooks.render();
        this.status(saved ? "All notes cleared." : "Notes cleared in memory; browser storage is unavailable.");
      });
      $("#selection-note").addEventListener("mousedown", (event) => event.preventDefault());
      $("#selection-note").addEventListener("click", () => this.open(this.pending));
      $("#note-cancel").addEventListener("click", () => $("#note-dialog").close());
      $("#note-dialog").addEventListener("close", () => { this.editing = null; $("#notes-toggle").focus(); });
      $("#copy-close").addEventListener("click", () => $("#copy-dialog").close());
      $("#note-form").addEventListener("submit", (event) => { event.preventDefault(); this.save(); });
      $("#note-text").addEventListener("input", () => $("#note-text").setCustomValidity(""));
      document.addEventListener("click", (event) => this.gutter(event));
      document.addEventListener("mouseup", (event) => {
        if (!event.target.closest("button, input, textarea, dialog, .line-number")) this.selection(event);
      });
      document.addEventListener("keyup", (event) => {
        if (event.key === "Shift" && !event.target.closest("input, textarea, dialog")) this.selection(event);
      });
      document.addEventListener("keydown", (event) => {
        if (this.editing && (event.metaKey || event.ctrlKey) && event.key === "Enter") {
          event.preventDefault(); $("#note-form").requestSubmit();
        } else if (event.key === "Escape" && !this.editing) this.clearSelection();
      });
    }
    data() { return this.hooks.data(); }
    list() { return this.data() ? this.drafts.list(this.data()) : []; }
    comments(file) { return this.list().filter((note) => note.sameComparison && note.path === file.path).map((note) => ({ ...note, label: "Your note" })); }
    clearSelection() {
      this.pending = null;
      this.anchor = null;
      $("#selection-note").hidden = true;
      for (const cell of document.querySelectorAll(".note-selected")) cell.classList.remove("note-selected");
    }
    pick(file, side, range, cells, event) {
      this.pending = {
        ...range, path: file.path, sourcePath: side === "old" ? file.oldPath : file.path, side,
        snapshot: snapshot(this.data(), file),
        comparison: Object.fromEntries(["repo", "base", "mode", "label", "oldRevision"].map((key) => [key, this.data()[key]])),
      };
      for (const cell of document.querySelectorAll(".note-selected")) cell.classList.remove("note-selected");
      for (const item of cells) if (item.number >= range.start && item.number <= range.end) item.cell.classList.add("note-selected");
      const action = $("#selection-note");
      const rect = cells.find((item) => item.number === range.start).cell.getBoundingClientRect();
      action.textContent = `Add note · ${range.start === range.end ? "line " + range.start : range.start + "–" + range.end}`;
      action.hidden = false;
      action.style.left = `${Math.max(8, Math.min(event.clientX || rect.left, innerWidth - action.offsetWidth - 12))}px`;
      action.style.top = `${Math.max(8, Math.min((event.clientY || rect.bottom) + 10, innerHeight - action.offsetHeight - 12))}px`;
    }
    selection(event) {
      if (this.editing) return;
      const selection = document.getSelection();
      if (!selection || selection.isCollapsed || !selection.rangeCount) { this.clearSelection(); return; }
      const range = selection.getRangeAt(0);
      const first = codeCell(range.startContainer), last = codeCell(range.endContainer);
      if (!first || !last) { this.clearSelection(); return; }
      const card = first.closest(".file-card"), side = first.dataset.side;
      if (last.closest(".file-card") !== card || last.dataset.side !== side) {
        this.clearSelection(); this.status("Select code within one file and one side of the diff."); return;
      }
      const file = this.data().files.find((file) => `file-${file.id}` === card.id);
      const cells = sourceCells(first.closest("table"), side);
      try {
        const chosen = lineSelection(cells, Number(first.closest("tr").getAttribute(`data-${side}-line`)),
          Number(last.closest("tr").getAttribute(`data-${side}-line`)), column(first, range.startContainer, range.startOffset), column(last, range.endContainer, range.endOffset));
        if (!chosen.snippet.length) { this.clearSelection(); return; }
        this.anchor = null;
        this.pick(file, side, chosen, cells, event);
      } catch (error) { this.clearSelection(); this.status(error.message); }
    }
    gutter(event) {
      const gutter = event.target.closest("td.line-number");
      if (!gutter || this.editing) return;
      const side = gutter.dataset.side, row = gutter.closest("tr"), card = gutter.closest(".file-card");
      const number = Number(row.getAttribute(`data-${side}-line`));
      if (!number) return;
      const file = this.data().files.find((file) => `file-${file.id}` === card.id);
      const cells = sourceCells(gutter.closest("table"), side);
      const anchor = event.shiftKey && this.anchor?.path === file.path && this.anchor.side === side ? this.anchor.number : number;
      try {
        this.pick(file, side, lineSelection(cells, anchor, number), cells, event);
        this.anchor = { path: file.path, side, number: anchor };
        document.getSelection()?.removeAllRanges();
      } catch (error) { this.clearSelection(); this.status(error.message); }
    }
    open(note) {
      if (!note) return;
      this.editing = { ...note };
      $("#note-location").textContent = locationLabel(note);
      $("#note-snippet").textContent = note.snippet;
      $("#note-text").value = note.text || "";
      $("#note-save").textContent = note.id ? "Save note" : "Add note";
      $("#selection-note").hidden = true;
      $("#note-dialog").showModal();
      $("#note-text").focus();
    }
    save() {
      if (!this.editing) return;
      const input = $("#note-text");
      input.setCustomValidity(input.value.trim() ? "" : "Write a note before adding it.");
      if (!input.reportValidity()) return;
      const saved = this.drafts.save({ ...this.editing, id: this.editing.id || crypto.randomUUID(), text: input.value });
      $("#note-dialog").close();
      this.clearSelection();
      this.hooks.render();
      this.toggle(true);
      this.status(saved ? "Note saved." : "Note saved in memory; browser storage is unavailable.");
    }
    toggle(open = $("#notes-panel").hidden) {
      $("#notes-panel").hidden = !open;
      $("#notes-toggle").setAttribute("aria-expanded", String(open));
      if (open) this.renderList();
    }
    status(text) { $("#notes-status").textContent = text; this.toggle(true); }
    renderList() {
      const notes = this.list(), list = $("#notes-list");
      list.replaceChildren();
      $("#notes-toggle").textContent = `Notes (${notes.length})`;
      $("#notes-copy").disabled = notes.length === 0;
      $("#notes-clear").disabled = notes.length === 0;
      if (!notes.length) list.append(element("p", "notes-empty", "Select code or click a line number, then choose Add note. Shift-click another line number to select a range."));
      for (const [index, note] of notes.entries()) {
        const item = element("article", "note-entry");
        const jump = element("button", "note-location", `${index + 1}. ${locationLabel(note)}`);
        jump.disabled = note.stale;
        jump.addEventListener("click", async () => {
          try { await this.hooks.jump(note); this.toggle(false); }
          catch (error) { this.status(error.message); }
        });
        item.append(jump);
        if (note.stale) item.append(element("p", "note-warning", note.sameComparison ? "Diff changed · original selection preserved" : "Different comparison · original selection preserved"));
        const details = element("details", "note-excerpt");
        const pre = element("pre"); pre.append(element("code", "", note.snippet));
        details.append(element("summary", "", "Selected code"), pre);
        const actions = element("div", "note-actions");
        const edit = element("button", "button", "Edit"); edit.addEventListener("click", () => this.open(note));
        const remove = element("button", "button", "Delete"); remove.addEventListener("click", () => {
          this.drafts.remove(note.id); this.hooks.render(); this.status("Note deleted.");
        });
        actions.append(edit, remove);
        item.append(details, element("p", "note-body", note.text), actions);
        list.append(item);
      }
    }
    async copy() {
      const text = markdown(this.list());
      if (!text) return;
      try { await navigator.clipboard.writeText(text); this.status("All notes copied as Markdown."); }
      catch {
        $("#copy-text").value = text;
        $("#copy-dialog").showModal();
        $("#copy-text").focus(); $("#copy-text").select();
        this.status("Clipboard unavailable. Copy the selected Markdown manually.");
      }
    }
  }

  globalThis.ViewdiffNotes = { Drafts, Controller, markdown, lineSelection };
})();

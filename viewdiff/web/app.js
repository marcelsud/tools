const $ = (selector) => document.querySelector(selector);
const preferences = new ViewdiffPreferences();
const state = { data: null, layout: preferences.get("layout", "split"), files: new Map(), reviewed: {}, request: 0, controller: null, active: null };
const statusNames = { A: "Added", D: "Deleted", M: "Modified", R: "Renamed", C: "Copied", T: "Type changed", U: "Unmerged", "?": "Untracked" };

function node(tag, attrs = {}, text) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value);
  if (text !== undefined) element.textContent = text;
  return element;
}

function storageKey() { return `viewdiff.reviewed:${state.data.repo}:${state.data.base}:${state.data.mode}`; }
function fingerprint(file) {
  let value = 2166136261;
  const add = (text) => { for (let i = 0; i < text.length; i++) value = Math.imul(value ^ text.charCodeAt(i), 16777619); };
  add(file.status + file.oldPath + file.message);
  for (const hunk of file.hunks) { add(hunk.header); for (const line of hunk.lines) add(line.type + line.text); }
  return String(value);
}
function isReviewed(file) { return state.reviewed[file.path] === file.fingerprint; }
function visibleFiles() {
  const filter = $("#filter").value.toLowerCase();
  return (state.data?.files || []).filter((file) => (file.path + " " + file.oldPath).toLowerCase().includes(filter));
}
function showError(error) { $("#error").textContent = error.message || String(error); $("#error").hidden = false; }

async function load(initial = false) {
  state.controller?.abort();
  state.controller = new AbortController();
  const request = ++state.request;
  $("#refresh").disabled = true;
  $("#error").hidden = true;
  try {
    const url = new URL("api/diff", location.href);
    if (!initial) { url.searchParams.set("mode", $("#mode").value); url.searchParams.set("base", $("#base").value); }
    const response = await fetch(url, { signal: state.controller.signal });
    if (!response.ok) throw new Error(await response.text());
    const data = await response.json();
    if (request !== state.request) return;
    state.data = data;
    state.files.clear();
    state.active = null;
    try { state.reviewed = JSON.parse(localStorage.getItem(storageKey()) || "{}"); } catch { state.reviewed = {}; }
    for (const file of data.files) { file.fingerprint = fingerprint(file); state.files.set(file.id, { collapsed: false, gaps: new Set(), content: null, full: false }); }
    document.title = `${data.repo.split("/").pop()} · viewdiff`;
    $("#repo-name").textContent = data.repo.split("/").pop();
    $("#repo-name").title = data.repo;
    $("#branch").textContent = data.branch;
    $("#mode").value = data.mode;
    $("#mode option[value=branch]").textContent = data.label.includes("+ local changes") ? "Branch + local changes" : "Branch comparison";
    $("#base").value = data.base;
    $("#base-form").hidden = data.mode !== "branch";
    $("#collapse-all").textContent = "Collapse all";
    $("#comparison-label").textContent = data.label;
    $("#file-count").textContent = `${data.files.length} changed file${data.files.length === 1 ? "" : "s"}`;
    $("#totals").replaceChildren(node("span", { class: "add-count" }, `+${data.additions}`), document.createTextNode("  "), node("span", { class: "del-count" }, `−${data.deletions}`));
    render();
  } catch (error) { if (error.name !== "AbortError") showError(error); }
  finally { if (request === state.request) $("#refresh").disabled = false; }
}

function render() {
  if (!state.data) return;
  const diffs = $("#diffs");
  diffs.replaceChildren();
  if (!state.data.files.length) {
    const empty = node("div", { class: "empty-state" });
    empty.append(node("h2", {}, "No changes to review"), node("p", {}, "Choose another base or comparison mode, or refresh after editing files."));
    diffs.append(empty);
  }
  for (const file of state.data.files) diffs.append(fileCard(file));
  setLayoutButtons();
  filterFiles();
}

function fileCard(file) {
  const memo = state.files.get(file.id);
  const card = node("article", { class: `file-card${memo.collapsed ? " collapsed" : ""}`, id: `file-${file.id}` });
  const header = node("div", { class: "file-header" });
  const collapse = node("button", { class: "collapse", "aria-label": `Toggle ${file.path}`, "aria-expanded": String(!memo.collapsed) }, memo.collapsed ? "▸" : "▾");
  collapse.addEventListener("click", () => {
    memo.collapsed = !memo.collapsed;
    card.classList.toggle("collapsed", memo.collapsed);
    collapse.textContent = memo.collapsed ? "▸" : "▾";
    collapse.setAttribute("aria-expanded", String(!memo.collapsed));
  });
  const title = node("span", { class: "file-title" });
  if (file.oldPath !== file.path) title.append(node("span", { class: "old-path" }, file.oldPath + " → "));
  title.append(document.createTextNode(file.path));
  const stats = node("span", { class: "file-stats" });
  stats.append(node("span", { class: "add-count" }, `+${file.additions}`), node("span", { class: "del-count" }, `−${file.deletions}`));
  const viewed = node("label", { class: "viewed" });
  const checkbox = node("input", { type: "checkbox", "aria-label": `Mark ${file.path} viewed` });
  checkbox.checked = isReviewed(file);
  checkbox.addEventListener("change", () => {
    if (checkbox.checked) state.reviewed[file.path] = file.fingerprint; else delete state.reviewed[file.path];
    localStorage.setItem(storageKey(), JSON.stringify(state.reviewed));
    renderTree();
  });
  viewed.append(checkbox, document.createTextNode("Viewed"));
  header.append(collapse, node("span", { class: `file-status status-${file.status}`, title: statusNames[file.status] || file.status }, file.status), title, stats, viewed);
  if (file.comments?.length) {
    header.insertBefore(node("span", { class: "comment-count", title: "Local review notes" }, `${file.comments.length} note${file.comments.length === 1 ? "" : "s"}`), stats);
  }
  const body = node("div", { class: "file-body" });
  card.append(header, body);
  renderBody(file, body);
  return card;
}

const tokenPattern = /(?:\/\/.*|#.*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b(?:abstract|async|await|break|case|catch|class|const|continue|default|defer|do|else|enum|export|extends|false|final|finally|for|from|func|function|if|implements|import|in|interface|internal|let|message|new|nil|null|optional|override|package|private|protected|public|record|repeated|return|rpc|sealed|static|struct|super|switch|this|throw|throws|true|try|type|val|var|void|when|while|yield)\b|\b\d+(?:\.\d+)?\b)/g;
function code(text) {
  const element = node("code", { class: "line-text" });
  let cursor = 0;
  for (const match of text.matchAll(tokenPattern)) {
    if (match.index > cursor) element.append(document.createTextNode(text.slice(cursor, match.index)));
    const token = match[0];
    const kind = token.startsWith("//") || token.startsWith("#") ? "comment" : /^["'`]/.test(token) ? "string" : /^\d/.test(token) ? "number" : "keyword";
    element.append(node("span", { class: `token-${kind}` }, token));
    cursor = match.index + token.length;
  }
  if (cursor < text.length) element.append(document.createTextNode(text.slice(cursor)));
  return element;
}

function half(line, side) {
  const type = line?.type || "blank";
  const number = side === "old" ? line?.oldLine : line?.newLine;
  const numberCell = node("td", { class: `line-number ${type}${side === "new" ? " right-start" : ""}`, "data-side": side }, number || "");
  const sign = type === "addition" ? "+" : type === "deletion" ? "−" : "";
  const signCell = node("td", { class: `sign ${type}`, "data-side": side }, sign);
  const contentCell = node("td", { class: `code ${type}`, "data-side": side });
  contentCell.append(code(line?.text || ""));
  return [numberCell, signCell, contentCell];
}
function row(body, old, fresh) {
  const tr = node("tr");
  if (old?.oldLine) tr.setAttribute("data-old-line", old.oldLine);
  if (fresh?.newLine) tr.setAttribute("data-new-line", fresh.newLine);
  if (state.layout === "split") tr.append(...half(old, "old"), ...half(fresh, "new"));
  else {
    const line = fresh || old;
    const type = line.type;
    const sign = type === "addition" ? "+" : type === "deletion" ? "−" : "";
    const content = node("td", { class: `code ${type}`, "data-side": type === "deletion" ? "old" : "new" });
    content.append(code(line.text));
    tr.append(node("td", { class: `line-number ${type}`, "data-side": "old" }, line.oldLine || ""), node("td", { class: `line-number ${type}`, "data-side": "new" }, line.newLine || ""), node("td", { class: `sign ${type}`, "data-side": type === "deletion" ? "old" : "new" }, sign), content);
  }
  body.append(tr);
}
function fullRow(body, className, content) {
  const tr = node("tr", { class: className });
  const td = node("td", { colspan: state.layout === "split" ? "6" : "4" });
  td.append(typeof content === "string" ? document.createTextNode(content) : content);
  tr.append(td); body.append(tr);
  return tr;
}

function reviewNote(comment, visible = true) {
  const details = node("details", { class: `review-note${comment.stale ? " stale-note" : ""}` });
  const range = `${comment.side === "old" ? "Old" : "New"} lines ${comment.start}–${comment.end}`;
  const summary = node("summary", { title: comment.text });
  summary.append(node("span", { class: "note-label" }, comment.label || "Review note"), node("span", { class: "note-range" }, range), node("span", { class: "note-preview" }, comment.text.split("\n")[0]));
  if (comment.stale) summary.append(node("span", { class: "note-warning" }, "Diff changed · check this note"));
  else if (!visible) summary.append(node("span", { class: "note-range" }, "Outside visible diff · expand context to locate"));
  details.append(summary, node("div", { class: "note-text" }, comment.text));
  return details;
}

function annotateRows(file, body) {
  const rows = [...body.querySelectorAll("tr[data-old-line], tr[data-new-line]")];
  const firstRow = body.firstChild;
  for (const comment of file.comments || []) {
    const matching = comment.stale ? [] : rows.filter((row) => {
      const number = Number(row.getAttribute(`data-${comment.side}-line`));
      return number >= comment.start && number <= comment.end;
    });
    for (const row of matching) {
      for (const cell of row.querySelectorAll(`[data-side="${comment.side}"]`)) {
        cell.classList.add("annotated");
        cell.title = cell.title ? `${cell.title}\n\n${comment.text}` : comment.text;
      }
    }
    const note = fullRow(body, "review-note-row", reviewNote(comment, matching.length > 0));
    body.insertBefore(note, matching[0] || firstRow);
  }
}

async function context(file) {
  const memo = state.files.get(file.id);
  if (memo.content !== null) return memo.content;
  const url = new URL("api/context", location.href);
  url.searchParams.set("id", file.id);
  url.searchParams.set("path", file.oldPath);
  url.searchParams.set("revision", state.data.oldRevision);
  const response = await fetch(url, { signal: state.controller.signal });
  if (!response.ok) throw new Error(await response.text());
  const { content } = await response.json();
  memo.content = content === "" ? [] : content.split("\n");
  if (content.endsWith("\n")) memo.content.pop();
  return memo.content;
}
function gap(file, body, start, end, newStart, tail = false) {
  const memo = state.files.get(file.id);
  const key = tail ? "tail" : `${start}:${end}`;
  if (tail && memo.content !== null) end = memo.content.length;
  if (tail && memo.content !== null && start > end) return;
  if ((memo.full || memo.gaps.has(key)) && memo.content !== null) {
    let newLine = newStart;
    for (let oldLine = start; oldLine <= end; oldLine++, newLine++) {
      const line = { type: "context", oldLine, newLine, text: memo.content[oldLine - 1] ?? "" };
      row(body, line, line);
    }
    return;
  }
  const button = node("button", { class: "gap-button" }, tail ? "↕ Show remaining context" : `↕ Expand ${end - start + 1} hidden lines`);
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await context(file);
      memo.gaps.add(key);
      renderBody(file, $(`#file-${file.id} .file-body`));
    } catch (error) { if (error.name !== "AbortError") showError(error); }
    finally { button.disabled = false; }
  });
  fullRow(body, "gap-row", button);
}

function renderBody(file, target) {
  if (!target) return;
  target.replaceChildren();
  if (!file.hunks.length) {
    for (const comment of file.comments || []) target.append(reviewNote(comment, false));
    target.append(node("div", { class: "file-message" }, file.message || (file.status === "R" ? "File renamed without content changes" : "No textual changes")));
    return;
  }
  const table = node("table", { class: "diff-table", "aria-label": `${file.path} diff` });
  const cols = node("colgroup");
  for (const kind of state.layout === "split" ? ["number", "sign", "code", "number", "sign", "code"] : ["number", "number", "sign", "code"]) cols.append(node("col", { class: `col-${kind}` }));
  const body = node("tbody"); table.append(cols, body);
  let oldCursor = 1, newCursor = 1;
  for (const hunk of file.hunks) {
    if (hunk.oldStart > oldCursor) gap(file, body, oldCursor, hunk.oldStart - 1, newCursor);
    fullRow(body, "hunk-row", hunk.header);
    for (let i = 0; i < hunk.lines.length;) {
      const line = hunk.lines[i];
      if (line.type === "context") { row(body, line, line); i++; }
      else if (line.type === "meta") { fullRow(body, "meta-row", line.text); i++; }
      else if (state.layout === "unified") { row(body, line.type === "deletion" ? line : null, line.type === "addition" ? line : null); i++; }
      else {
        const removed = [], added = [], notes = [];
        while (i < hunk.lines.length && hunk.lines[i].type !== "context") {
          const changed = hunk.lines[i++];
          if (changed.type === "deletion") removed.push(changed);
          else if (changed.type === "addition") added.push(changed);
          else notes.push(changed.text);
        }
        for (let j = 0; j < Math.max(removed.length, added.length); j++) row(body, removed[j], added[j]);
        for (const note of notes) fullRow(body, "meta-row", note);
      }
    }
    for (const line of hunk.lines) {
      if (line.oldLine) oldCursor = line.oldLine + 1;
      if (line.newLine) newCursor = line.newLine + 1;
    }
  }
  if (!["A", "?", "D"].includes(file.status)) gap(file, body, oldCursor, 0, newCursor, true);
  annotateRows(file, body);
  const scroll = node("div", { class: "table-scroll" }); scroll.append(table); target.append(scroll);
}

function renderTree() {
  if (!state.data) return;
  const tree = { directories: new Map(), files: [] };
  for (const file of visibleFiles()) {
    const parts = file.path.split("/");
    const name = parts.pop();
    let branch = tree;
    for (const part of parts) {
      if (!branch.directories.has(part)) branch.directories.set(part, { directories: new Map(), files: [] });
      branch = branch.directories.get(part);
    }
    branch.files.push({ file, name });
  }
  function appendTree(parent, branch) {
    for (const [name, child] of [...branch.directories].sort(([a], [b]) => a.localeCompare(b))) {
      let folderName = name, compact = child;
      while (compact.files.length === 0 && compact.directories.size === 1) {
        const [nextName, nextChild] = compact.directories.entries().next().value;
        folderName += "/" + nextName;
        compact = nextChild;
      }
      const folder = node("details", { class: "folder", open: "" });
      const children = node("div", { class: "folder-children" });
      folder.append(node("summary", { title: folderName }, folderName), children);
      appendTree(children, compact); parent.append(folder);
    }
    for (const { file, name } of branch.files) {
      const button = node("button", { class: `file-link${isReviewed(file) ? " reviewed" : ""}${state.active === file.id ? " active" : ""}`, title: `${statusNames[file.status]}: ${file.path}`, "data-file-id": file.id });
      button.append(node("span", { class: `file-status status-${file.status}` }, file.status), node("span", { class: "name" }, name), node("span", { class: "review-dot" }, isReviewed(file) ? "✓" : ""));
      button.addEventListener("click", () => activate(file.id)); parent.append(button);
    }
  }
  const root = $("#file-tree"); root.replaceChildren(); appendTree(root, tree);
  if (!visibleFiles().length && state.data.files.length) root.append(node("p", {}, "No matching files"));
  $("#review-count").textContent = `${state.data.files.filter(isReviewed).length}/${state.data.files.length} viewed`;
}
function filterFiles() {
  const visible = new Set(visibleFiles().map((file) => file.id));
  for (const file of state.data?.files || []) $(`#file-${file.id}`).hidden = !visible.has(file.id);
  renderTree();
}
function activate(id) {
  const file = $(`#file-${id}`);
  if (!file) return;
  state.active = id; file.scrollIntoView({ behavior: "smooth", block: "start" }); renderTree();
}
function setLayoutButtons() {
  $("#split").setAttribute("aria-pressed", String(state.layout === "split"));
  $("#unified").setAttribute("aria-pressed", String(state.layout === "unified"));
}
function layout(value) { state.layout = value; preferences.set("layout", value); setLayoutButtons(); render(); }

function applyPreferences() {
  state.layout = preferences.get("layout", "split");
  document.documentElement.dataset.theme = preferences.get("theme", matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  $("#wrap").checked = preferences.get("wrap", false);
  $("#diffs").classList.toggle("wrap", $("#wrap").checked);
  $(".workspace").classList.toggle("no-sidebar", !preferences.get("sidebar", true));
  setLayoutButtons();
}

$("#refresh").addEventListener("click", () => load());
$("#mode").addEventListener("change", () => load());
$("#base-form").addEventListener("submit", (event) => { event.preventDefault(); load(); });
$("#filter").addEventListener("input", filterFiles);
$("#split").addEventListener("click", () => layout("split"));
$("#unified").addEventListener("click", () => layout("unified"));
$("#wrap").addEventListener("change", () => {
  preferences.set("wrap", $("#wrap").checked);
  $("#diffs").classList.toggle("wrap", $("#wrap").checked);
});
$("#collapse-all").addEventListener("click", () => {
  const collapse = [...state.files.values()].some((memo) => !memo.collapsed);
  for (const memo of state.files.values()) memo.collapsed = collapse;
  $("#collapse-all").textContent = collapse ? "Expand all" : "Collapse all";
  render();
});
$("#sidebar-toggle").addEventListener("click", () => {
  const hidden = $(".workspace").classList.toggle("no-sidebar");
  preferences.set("sidebar", !hidden);
});
$("#theme").addEventListener("click", () => {
  const theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = theme; preferences.set("theme", theme);
});
document.addEventListener("keydown", (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey || /INPUT|SELECT|TEXTAREA/.test(event.target.tagName)) return;
  if (event.key === "/") { event.preventDefault(); $("#filter").focus(); }
  else if (event.key.toLowerCase() === "u") layout("unified");
  else if (event.key.toLowerCase() === "s") layout("split");
  else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault(); const files = visibleFiles(); const index = files.findIndex((file) => file.id === state.active);
    const next = event.key === "ArrowDown" ? Math.min(index + 1, files.length - 1) : Math.max(index - 1, 0);
    if (files[next]) activate(files[next].id);
  }
});
applyPreferences();
preferences.load().then(() => { applyPreferences(); load(true); });

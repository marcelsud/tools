const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function browser() {
  function element() {
    return {
      value: '', textContent: '', hidden: false, disabled: false, dataset: {}, listeners: {},
      addEventListener(type, callback) { this.listeners[type] = callback; },
      focus() {},
      click() { if (!this.disabled) return this.listeners.click(); },
    };
  }
  const edit = element(), save = element(), cancel = element();
  const status = element(), editor = element(), article = element();
  const toolbar = {
    dataset: { token: 'session-token' },
    querySelector: (selector) => ({ '[data-edit]': edit, '[data-save]': save,
      '[data-cancel]': cancel, '[role="status"]': status })[selector],
  };
  const documentListeners = {}, windowListeners = {}, requests = [], responses = [];
  const window = {
    reloads: 0, allowDiscard: true,
    location: { reload() { window.reloads++; } },
    confirm() { return window.allowDiscard; },
    addEventListener(type, callback) { windowListeners[type] = callback; },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'editor.js'), 'utf8'), {
    document: {
      querySelector: (selector) => selector === 'article' ? article : toolbar,
      getElementById: () => editor,
      addEventListener(type, callback) { documentListeners[type] = callback; },
    },
    window,
    fetch: async (url, options) => {
      requests.push({ url, options });
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return { ok: next.ok !== false, json: async () => next.body };
    },
  });
  const fixture = {
    edit, save, cancel, status, editor, article, window, requests, responses, windowListeners, documentListeners,
    type(markdown) { editor.value = markdown; editor.listeners.input(); },
    async open() {
      responses.push({ body: { markdown: '# Original\n', revision: 'initial-revision' } });
      await edit.click();
    },
  };
  return fixture;
}

test('browser edit saves exact Markdown with its revision and refreshes the preview', async () => {
  const b = browser();
  await b.open();
  assert.equal(b.editor.value, '# Original\n');
  assert.equal(b.editor.hidden, false);
  assert.equal(b.article.hidden, true);
  assert.equal(b.save.disabled, true);

  b.type('# Saved café\n');
  assert.equal(b.save.disabled, false);
  assert.equal(b.status.textContent, 'Unsaved changes');
  b.responses.push({ body: { markdown: '# Saved café\n', revision: 'new-revision' } });
  await b.save.click();

  const request = b.requests[1];
  assert.equal(request.url, '/_mdview/document');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers['X-Mdview-Token'], 'session-token');
  assert.deepEqual(JSON.parse(request.options.body), { markdown: '# Saved café\n', revision: 'initial-revision' });
  assert.equal(b.window.reloads, 1);
  let prevented = false;
  b.windowListeners.beforeunload({ preventDefault() { prevented = true; } });
  assert.equal(prevented, false);
});

test('a conflicting save keeps the browser draft for recovery', async () => {
  const b = browser();
  await b.open();
  b.type('# Unsaved browser draft\n');
  b.responses.push({ ok: false, body: { error: 'The source changed; copy your edits before reloading.' } });
  await b.save.click();

  assert.equal(b.editor.value, '# Unsaved browser draft\n');
  assert.equal(b.editor.readOnly, false);
  assert.equal(b.editor.hidden, false);
  assert.equal(b.save.disabled, false);
  assert.match(b.status.textContent, /source changed/);
  assert.equal(b.status.dataset.error, 'true');
  assert.equal(b.window.reloads, 0);
});

test('a failed request preserves edits and warns before leaving', async () => {
  const b = browser();
  await b.open();
  b.type('# My changes\n');
  b.responses.push(new Error('Connection lost'));
  await b.save.click();

  assert.equal(b.editor.value, '# My changes\n');
  assert.equal(b.status.textContent, 'Connection lost');
  assert.equal(b.window.reloads, 0);
  let prevented = false;
  b.windowListeners.beforeunload({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
});

test('cancel only discards a dirty draft after confirmation', async () => {
  const b = browser();
  await b.open();
  b.type('# My changes\n');
  b.window.allowDiscard = false;
  b.cancel.click();
  assert.equal(b.editor.hidden, false);
  assert.equal(b.editor.value, '# My changes\n');
  b.window.allowDiscard = true;
  b.cancel.click();
  assert.equal(b.editor.hidden, true);
  assert.equal(b.article.hidden, false);
  assert.equal(b.editor.value, '# Original\n');
  assert.equal(b.requests.length, 1);
});

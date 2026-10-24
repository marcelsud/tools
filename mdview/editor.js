(() => {
  'use strict';

  const toolbar = document.querySelector('[data-mdview-editor]');
  if (!toolbar) return;
  const edit = toolbar.querySelector('[data-edit]');
  const save = toolbar.querySelector('[data-save]');
  const cancel = toolbar.querySelector('[data-cancel]');
  const status = toolbar.querySelector('[role="status"]');
  const editor = document.getElementById('markdown-editor');
  const article = document.querySelector('article');
  let savedText = '';
  let revision = '';
  let editing = false;
  let busy = false;

  const dirty = () => editing && editor.value !== savedText;
  function message(text, error = false) {
    status.textContent = text;
    status.dataset.error = String(error);
  }
  function update() {
    edit.hidden = editing;
    save.hidden = cancel.hidden = !editing;
    save.disabled = busy || !dirty();
    cancel.disabled = busy;
    editor.readOnly = busy;
    editor.hidden = !editing;
    article.hidden = editing;
  }
  async function request(options = {}) {
    const response = await fetch('/_mdview/document', {
      ...options,
      cache: 'no-store',
      headers: { 'X-Mdview-Token': toolbar.dataset.token, ...options.headers },
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'The request failed. Your edits have not been discarded.');
    return body;
  }

  edit.addEventListener('click', async () => {
    edit.disabled = true;
    message('Loading source…');
    try {
      const source = await request();
      savedText = editor.value = source.markdown;
      revision = source.revision;
      editing = true;
      message('Editing Markdown. Save writes to the original file.');
      update();
      editor.focus();
    } catch (error) {
      message(error.message, true);
    } finally {
      edit.disabled = false;
    }
  });

  editor.addEventListener('input', () => {
    message(dirty() ? 'Unsaved changes' : 'No changes');
    update();
  });
  cancel.addEventListener('click', () => {
    if (dirty() && !window.confirm('Discard your unsaved changes?')) return;
    editing = false;
    editor.value = savedText;
    message('');
    update();
    edit.focus();
  });
  save.addEventListener('click', async () => {
    if (busy || !dirty()) return;
    busy = true;
    update();
    message('Saving…');
    try {
      const result = await request({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ markdown: editor.value, revision }),
      });
      savedText = result.markdown;
      revision = result.revision;
      message('Saved');
      window.location.reload();
    } catch (error) {
      message(error.message, true);
    } finally {
      busy = false;
      update();
    }
  });
  document.addEventListener('keydown', (event) => {
    if (editing && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      save.click();
    }
  });
  window.addEventListener('beforeunload', (event) => {
    if (dirty()) {
      event.preventDefault();
      event.returnValue = '';
    }
  });
})();

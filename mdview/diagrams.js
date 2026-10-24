(() => {
  'use strict';

  const cards = [...document.querySelectorAll('.diagram-card')];
  const modal = document.querySelector('.diagram-modal');
  const viewport = modal.querySelector('.diagram-modal-viewport');
  const modalCanvas = modal.querySelector('.diagram-modal-canvas');
  const zoomLabel = modal.querySelector('.diagram-zoom-label');
  let expanded = null;
  let scale = 1;
  let fitting = true;

  function selectTab(card, view, focus = false) {
    card.querySelectorAll('[role="tab"]').forEach((tab) => {
      const selected = tab.dataset.view === view;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      document.getElementById(tab.getAttribute('aria-controls')).hidden = !selected;
      if (selected && focus) tab.focus();
    });
  }

  function setScale(value) {
    scale = Math.min(5, Math.max(0.1, value));
    modalCanvas.style.width = `${expanded.width * scale}px`;
    modalCanvas.style.height = `${expanded.height * scale}px`;
    zoomLabel.textContent = `${Math.round(scale * 100)}%`;
  }

  function fit() {
    fitting = true;
    setScale(Math.min((viewport.clientWidth - 64) / expanded.width,
      (viewport.clientHeight - 64) / expanded.height));
    viewport.scrollTo(0, 0);
  }

  function expand(card) {
    const canvas = card.querySelector('.diagram-canvas');
    const svg = canvas.querySelector('svg');
    if (!svg) return;
    const box = svg.viewBox.baseVal;
    const bounds = svg.getBoundingClientRect();
    expanded = {
      canvas,
      opener: card.querySelector('.diagram-expand'),
      width: box.width || bounds.width || 800,
      height: box.height || bounds.height || 600,
    };
    // Move the SVG so its internal IDs stay unique, then return it on close.
    modalCanvas.replaceChildren(svg);
    document.body.classList.add('diagram-modal-open');
    modal.showModal();
    fit();
    modal.querySelector('[data-close]').focus();
  }

  modal.querySelector('[data-close]').addEventListener('click', () => modal.close());
  modal.addEventListener('close', () => {
    if (!expanded) return;
    expanded.canvas.append(...modalCanvas.childNodes);
    document.body.classList.remove('diagram-modal-open');
    expanded.opener.focus();
    expanded = null;
  });
  modal.querySelectorAll('[data-zoom]').forEach((button) => {
    button.addEventListener('click', () => {
      if (!expanded) return;
      if (button.dataset.zoom === 'fit') return fit();
      fitting = false;
      setScale(scale * (button.dataset.zoom === 'in' ? 1.25 : 0.8));
    });
  });
  window.addEventListener('resize', () => {
    if (expanded && fitting) fit();
  });

  async function copyCode(card, button) {
    const source = card.querySelector('.language-mermaid').textContent;
    try {
      await navigator.clipboard.writeText(source);
      button.textContent = '✓ Copied';
      card.querySelector('.diagram-feedback').textContent = 'Mermaid code copied';
      window.setTimeout(() => { button.textContent = '⧉ Copy'; }, 1800);
    } catch {
      selectTab(card, 'code');
      const range = document.createRange();
      range.selectNodeContents(card.querySelector('.language-mermaid'));
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      card.querySelector('.diagram-feedback').textContent = 'Clipboard unavailable. Code selected; press Copy on your keyboard.';
    }
  }

  for (const card of cards) {
    const tabs = [...card.querySelectorAll('[role="tab"]')];
    for (const [index, tab] of tabs.entries()) {
      tab.addEventListener('click', () => selectTab(card, tab.dataset.view));
      tab.addEventListener('keydown', (event) => {
        let next;
        if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
        if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
        if (event.key === 'Home') next = 0;
        if (event.key === 'End') next = tabs.length - 1;
        if (next === undefined) return;
        event.preventDefault();
        selectTab(card, tabs[next].dataset.view, true);
      });
    }
    card.querySelector('.diagram-copy').addEventListener('click', (event) => copyCode(card, event.currentTarget));
    card.querySelector('.diagram-expand').addEventListener('click', () => expand(card));
  }

  function renderDiagrams() {
    for (const [index, card] of cards.entries()) {
      const status = card.querySelector('.diagram-status');
      const canvas = card.querySelector('.diagram-canvas');
      try {
        if (!window.pele) throw new Error('Renderer unavailable');
        const source = card.querySelector('.language-mermaid').textContent;
        const result = window.pele.render(source, {
          idPrefix: `mdview-pele-${index + 1}`,
          fontFamily: window.getComputedStyle(canvas).fontFamily,
          maxWidth: canvas.clientWidth || 800,
          autoDirection: false,
          links: false,
          images: false,
        });
        canvas.innerHTML = result.svg;
        status.hidden = true;
        card.querySelector('.diagram-expand').disabled = false;
      } catch {
        canvas.replaceChildren();
        status.textContent = 'Unable to render this diagram. Open Code to inspect or copy its source.';
      }
    }
  }
  renderDiagrams();
})();

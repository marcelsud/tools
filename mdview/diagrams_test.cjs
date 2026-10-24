const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const context = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, 'assets/pele.global.js'), 'utf8'), context);
const render = (source) => context.pele.render(source, {
  idPrefix: 'mdview-test', links: false, images: false,
});

test('renders flowcharts and sequence branches as accessible SVG', () => {
  for (const [source, type] of [
    ['flowchart LR\n A[Authenticate] --> B{Approved?}\n B -->|Yes| C[Entry]', 'flowchart'],
    ['sequenceDiagram\n participant B as Bespoke\n participant C as Check-in\n B->>C: Authorize\n alt Approved\n C-->>B: Allow\n else Denied\n C-->>B: Refuse\n end', 'sequence'],
  ]) {
    const result = render(source);
    assert.equal(result.type, type);
    assert.ok(result.width > 0 && result.height > 0);
    assert.match(result.svg, /^<svg /);
    assert.match(result.svg, /aria-roledescription=/);
  }
});

test('preserves custom node color and bold labels', () => {
  const { svg } = render('flowchart TD\n A[Check-in change]\n classDef change fill:#27163f,stroke:#a855f7,color:#d8b4fe,font-weight:bold;\n class A change;');
  assert.match(svg, /fill:#27163f/);
  assert.match(svg, /stroke:#a855f7/);
  assert.match(svg, /fill:#d8b4fe;font-weight:bold/);
  assert.match(svg, /var\(--pele-fg/);
});

test('does not emit active HTML, diagram links, or click callbacks', () => {
  const { svg, links } = render('flowchart TD\n A["<script>alert(1)</script>"] --> B[Safe]\n click A "https://example.com"\n click B call alert()');
  assert.doesNotMatch(svg, /<script|<foreignObject|<a[\s>]|<image[\s>]|\son\w+=/i);
  assert.equal(links.length, 0);
});

test('rejects unsupported source without HTML insertion', () => {
  assert.throws(() => render('<img src=x onerror=alert(1)>'),
    (error) => error instanceof context.pele.PeleError);
});

test('a failed diagram keeps its source and does not block later diagrams', () => {
  const noop = () => {};
  function card(source) {
    const nodes = {
      '.diagram-status': { hidden: false, textContent: 'Rendering diagram…' },
      '.diagram-canvas': { clientWidth: 800, innerHTML: '', replaceChildren() { this.innerHTML = ''; } },
      '.language-mermaid': { textContent: source },
      '.diagram-expand': { disabled: true, addEventListener: noop },
      '.diagram-copy': { addEventListener: noop },
    };
    return { nodes, querySelector: (selector) => nodes[selector], querySelectorAll: () => [] };
  }
  const cards = [card('not a diagram'), card('flowchart LR\n A --> B')];
  const modal = { querySelector: () => ({ addEventListener: noop }), querySelectorAll: () => [], addEventListener: noop };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'diagrams.js'), 'utf8'), {
    document: { querySelectorAll: () => cards, querySelector: () => modal },
    window: { pele: context.pele, addEventListener: noop, getComputedStyle: () => ({ fontFamily: 'sans-serif' }) },
  });
  assert.match(cards[0].nodes['.diagram-status'].textContent, /Unable to render/);
  assert.equal(cards[0].nodes['.diagram-expand'].disabled, true);
  assert.equal(cards[0].nodes['.language-mermaid'].textContent, 'not a diagram');
  assert.match(cards[1].nodes['.diagram-canvas'].innerHTML, /^<svg /);
  assert.equal(cards[1].nodes['.diagram-status'].hidden, true);
  assert.equal(cards[1].nodes['.diagram-expand'].disabled, false);
});

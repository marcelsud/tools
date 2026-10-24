package main

import (
	"fmt"
	"html"
	"strings"

	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/renderer"
	"github.com/yuin/goldmark/util"
)

var kindMermaid = ast.NewNodeKind("Mermaid")

type mermaidBlock struct {
	ast.BaseBlock
	code string
	id   int
}

func (b *mermaidBlock) Kind() ast.NodeKind { return kindMermaid }
func (b *mermaidBlock) Dump(source []byte, level int) {
	ast.DumpHelper(b, source, level, nil, nil)
}

func prepareMermaid(document ast.Node, source []byte) bool {
	var blocks []*ast.FencedCodeBlock
	ast.Walk(document, func(node ast.Node, entering bool) (ast.WalkStatus, error) {
		if block, ok := node.(*ast.FencedCodeBlock); entering && ok && strings.EqualFold(string(block.Language(source)), "mermaid") {
			blocks = append(blocks, block)
		}
		return ast.WalkContinue, nil
	})
	for i, block := range blocks {
		var code strings.Builder
		for line := 0; line < block.Lines().Len(); line++ {
			segment := block.Lines().At(line)
			code.Write(segment.Value(source))
		}
		block.Parent().ReplaceChild(block.Parent(), block, &mermaidBlock{code: code.String(), id: i + 1})
	}
	return len(blocks) > 0
}

type mermaidRenderer struct{}

func (mermaidRenderer) RegisterFuncs(register renderer.NodeRendererFuncRegisterer) {
	register.Register(kindMermaid, func(w util.BufWriter, _ []byte, node ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		b := node.(*mermaidBlock)
		_, err := fmt.Fprintf(w, `<section class="diagram-card" aria-label="Mermaid diagram %d">
  <div class="diagram-toolbar">
    <div role="tablist" aria-label="Diagram view">
      <button type="button" role="tab" id="diagram-%d-tab" aria-controls="diagram-%d-preview" aria-selected="true" data-view="diagram">Diagram</button>
      <button type="button" role="tab" id="diagram-%d-code-tab" aria-controls="diagram-%d-code" aria-selected="false" tabindex="-1" data-view="code">Code</button>
    </div>
    <div class="diagram-actions">
      <button type="button" class="diagram-copy" aria-label="Copy Mermaid code" title="Copy Mermaid code"><span aria-hidden="true">⧉</span> Copy</button>
      <button type="button" class="diagram-expand" aria-label="Open full-screen diagram" title="Open full-screen diagram" disabled><span aria-hidden="true">⛶</span> Expand</button>
    </div>
  </div>
  <div role="tabpanel" id="diagram-%d-preview" aria-labelledby="diagram-%d-tab" class="diagram-preview" tabindex="0"><p class="diagram-status" role="status">Rendering diagram…</p><div class="diagram-canvas"></div></div>
  <div role="tabpanel" id="diagram-%d-code" aria-labelledby="diagram-%d-code-tab" class="diagram-code" tabindex="0" hidden><pre><code class="language-mermaid">%s</code></pre></div>
  <span class="diagram-feedback" role="status" aria-live="polite"></span>
</section>
`, b.id, b.id, b.id, b.id, b.id, b.id, b.id, b.id, b.id, html.EscapeString(b.code))
		return ast.WalkSkipChildren, err
	})
}

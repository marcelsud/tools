package main

import (
	"bytes"
	"crypto/sha256"
	_ "embed"
	"fmt"
	"html/template"
	"path/filepath"
	"regexp"
	"strings"
	"unicode/utf8"

	chromahtml "github.com/alecthomas/chroma/v2/formatters/html"
	"github.com/alecthomas/chroma/v2/styles"
	"github.com/yuin/goldmark"
	highlighting "github.com/yuin/goldmark-highlighting/v2"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/extension"
	"github.com/yuin/goldmark/parser"
	"github.com/yuin/goldmark/renderer"
	"github.com/yuin/goldmark/text"
	"github.com/yuin/goldmark/util"
)

//go:embed page.html
var pageTemplate string

var separators = regexp.MustCompile(`[^\pL\pN_-]+`)

func flatFilename(path string) string {
	name := strings.Trim(separators.ReplaceAllString(path, "-"), "-")
	if name == "" {
		name = "document"
	}
	// A full source path can exceed the filesystem's single-filename limit.
	if len(name) > 220 {
		end := 220
		for !utf8.RuneStart(name[end]) {
			end--
		}
		sum := sha256.Sum256([]byte(path))
		name = fmt.Sprintf("%s-%x", name[:end], sum[:6])
	}
	return name + ".html"
}

func render(source string, markdown []byte) ([]byte, error) {
	return renderEditable(source, markdown, "")
}

func renderEditable(source string, markdown []byte, token string) ([]byte, error) {
	if !utf8.Valid(markdown) {
		return nil, fmt.Errorf("input is not valid UTF-8")
	}
	md := goldmark.New(
		goldmark.WithExtensions(extension.GFM, highlighting.NewHighlighting(
			highlighting.WithStyle("github"),
			highlighting.WithFormatOptions(chromahtml.WithClasses(true)),
		)),
		goldmark.WithParserOptions(parser.WithAutoHeadingID()),
		goldmark.WithRendererOptions(renderer.WithNodeRenderers(util.Prioritized(mermaidRenderer{}, 100))),
	)
	var body bytes.Buffer
	document := md.Parser().Parse(text.NewReader(markdown))
	ast.Walk(document, func(node ast.Node, entering bool) (ast.WalkStatus, error) {
		if entering {
			switch node.(type) {
			case *ast.Link, *ast.AutoLink:
				node.SetAttributeString("target", "_blank")
				node.SetAttributeString("rel", "noopener noreferrer")
			}
		}
		return ast.WalkContinue, nil
	})
	hasMermaid := prepareMermaid(document, markdown)
	if err := md.Renderer().Render(&body, markdown, document); err != nil {
		return nil, err
	}
	css, err := syntaxCSS()
	if err != nil {
		return nil, err
	}
	page, err := template.New("page").Parse(pageTemplate)
	if err != nil {
		return nil, err
	}
	var output bytes.Buffer
	err = page.Execute(&output, struct {
		Title        string
		Source       string
		Body         template.HTML
		HighlightCSS template.CSS
		Mermaid      bool
		EditToken    string
	}{
		Title:  filepath.Base(source),
		Source: source,
		// Goldmark's default renderer excludes raw HTML and unsafe link schemes.
		Body:         template.HTML(body.String()),
		HighlightCSS: css,
		Mermaid:      hasMermaid,
		EditToken:    token,
	})
	return output.Bytes(), err
}

func syntaxCSS() (template.CSS, error) {
	formatter := chromahtml.New(chromahtml.WithClasses(true))
	var css bytes.Buffer
	if err := formatter.WriteCSS(&css, styles.Get("github")); err != nil {
		return "", err
	}
	css.WriteString("\n@media (prefers-color-scheme: dark) {\n")
	if err := formatter.WriteCSS(&css, styles.Get("github-dark")); err != nil {
		return "", err
	}
	css.WriteString("\n}\n")
	// The stylesheet is generated only from the bundled Chroma themes.
	return template.CSS(css.String()), nil
}

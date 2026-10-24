package main

import (
	"html"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
)

// Mermaid fences expose the exact source alongside a diagram, never active HTML.
func TestGivenMermaidFencesWhenRenderedThenTabsKeepExactEscapedSource(t *testing.T) {
	code := "flowchart LR\n  A[\"<script>alert(1)</script> & text\"] --> B\n"
	markdown := "# Diagrams\n\n```mermaid\n" + code + "```\n\n> ```Mermaid\n> sequenceDiagram\n>   A->>B: Hello\n> ```\n"
	page, err := render("diagrams.md", []byte(markdown))
	if err != nil {
		t.Fatal(err)
	}
	output := string(page)
	for _, want := range []string{`role="tablist"`, `data-view="diagram"`, `data-view="code"`, `aria-label="Copy Mermaid code"`, `aria-label="Open full-screen diagram"`, `<dialog`, `data-zoom="fit"`, `id="diagram-1-preview"`, `id="diagram-2-preview"`, `src="/_mdview/pele.global.js"`, `src="/_mdview/diagrams.js"`} {
		if !strings.Contains(output, want) {
			t.Errorf("missing diagram interaction %q", want)
		}
	}
	block := regexp.MustCompile(`(?s)<code class="language-mermaid">(.*?)</code>`).FindStringSubmatch(output)
	if len(block) != 2 || html.UnescapeString(block[1]) != code {
		t.Fatalf("Mermaid source changed: %v", block)
	}
	if strings.Contains(output, "<script>alert(1)</script>") {
		t.Fatal("Mermaid source became executable HTML")
	}
}

func TestGivenOrdinaryCodeWhenRenderedThenNoDiagramRuntimeIsLoaded(t *testing.T) {
	page, err := render("plain.md", []byte("```text\nmermaid is only text\n```\n"))
	if err != nil {
		t.Fatal(err)
	}
	for _, unwanted := range []string{"<script", "<dialog", "diagram-card\""} {
		if strings.Contains(string(page), unwanted) {
			t.Errorf("ordinary Markdown includes %q", unwanted)
		}
	}
}

func TestGivenBundledScriptsWhenRequestedThenOnlyKnownAssetsAreServed(t *testing.T) {
	handler := pageHandler("127.0.0.1:12345", "/guide.html", []byte("<h1>Guide</h1>"))
	for _, asset := range []struct {
		path string
		body []byte
	}{
		{"/_mdview/pele.global.js", peleJS},
		{"/_mdview/diagrams.js", diagramsJS},
	} {
		request := httptest.NewRequest("GET", "http://127.0.0.1:12345"+asset.path, nil)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != 200 || response.Body.String() != string(asset.body) {
			t.Errorf("asset %s was not served intact", asset.path)
		}
		if response.Header().Get("Content-Type") != "application/javascript; charset=utf-8" {
			t.Error("missing JavaScript content type")
		}
		policy := response.Header().Get("Content-Security-Policy")
		if !strings.Contains(policy, "script-src 'self';") || strings.Contains(policy, "script-src 'unsafe-inline'") {
			t.Errorf("unexpected script policy: %s", policy)
		}
	}
	for _, path := range []string{"/_mdview/../main.go", "/_mdview/arbitrary.js", "/assets/PELE-LICENSE"} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest("GET", "http://127.0.0.1:12345"+path, nil))
		if response.Code != 404 {
			t.Errorf("unlisted path %s returned %d", path, response.Code)
		}
	}
}

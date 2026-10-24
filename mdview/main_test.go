package main

import (
	"context"
	"html"
	"io"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestFlatFilename(t *testing.T) {
	for _, test := range []struct{ path, want string }{
		{"/tmp/something/abcd.md", "tmp-something-abcd-md.html"},
		{"/Users/me/My Project/setup.guide.md", "Users-me-My-Project-setup-guide-md.html"},
		{"/tmp/café.md", "tmp-café-md.html"},
	} {
		t.Run(test.path, func(t *testing.T) {
			if got := flatFilename(test.path); got != test.want {
				t.Fatalf("filename = %q, want %q", got, test.want)
			}
		})
	}
	t.Run("long paths remain valid distinct filenames", func(t *testing.T) {
		prefix := "/tmp/" + strings.Repeat("é", 200)
		a, b := flatFilename(prefix+"a.md"), flatFilename(prefix+"b.md")
		if a == b || len(a) > 255 || !utf8.ValidString(a) || strings.Contains(a, "/") {
			t.Fatalf("invalid long filenames: %q, %q", a, b)
		}
	})
}

func TestRender(t *testing.T) {
	markdown := "# Setup\n\n**Hello** ~~old~~ [link](https://example.com)\n\n- [x] Ready\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```sh\necho '<script>'\n```\n\n<script>alert(1)</script>\n\n[bad](javascript:alert(1))\n"
	page, err := render("/tmp/<guide>.md", []byte(markdown))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"<h1 id=\"setup\">Setup</h1>", "<strong>Hello</strong>", "<del>old</del>", "<table>", "type=\"checkbox\"", "class=\"chroma\"", "&lt;script&gt;", "&lt;guide&gt;.md", "https://example.com"} {
		if !strings.Contains(string(page), want) {
			t.Errorf("rendered page missing %q", want)
		}
	}
	for _, bad := range []string{"<script>", "href=\"javascript:", "<title><guide>"} {
		if strings.Contains(string(page), bad) {
			t.Errorf("rendered page contains unsafe HTML %q", bad)
		}
	}
	if _, err := render("binary.md", []byte{0xff}); err == nil {
		t.Error("invalid UTF-8 input should fail")
	}
}

func TestCodeBlockHighlighting(t *testing.T) {
	codeBlock := regexp.MustCompile(`(?s)<pre\b[^>]*><code\b[^>]*>(.*?)</code></pre>`)
	tags := regexp.MustCompile(`<[^>]*>`)
	for _, test := range []struct {
		language, code string
		highlighted    bool
	}{
		{"sh", "echo \"<hello>\"\n", true},
		{"json", "{\"enabled\": true, \"count\": 42}\n", true},
		{"kotlin", "val answer = 42\n", true},
		{"sql", "SELECT id FROM bookings WHERE active = true;\n", true},
		{"unknown-language", "<script>plain & unchanged</script>\n", false},
		{"", "plain <code> & text\n", false},
	} {
		t.Run(test.language, func(t *testing.T) {
			page, err := render("code.md", []byte("```"+test.language+"\n"+test.code+"```\n"))
			if err != nil {
				t.Fatal(err)
			}
			block := codeBlock.FindSubmatch(page)
			if block == nil {
				t.Fatal("rendered page has no code block")
			}
			if got := strings.Contains(string(block[1]), `<span class=`); got != test.highlighted {
				t.Errorf("highlighting = %v, want %v", got, test.highlighted)
			}
			if got := html.UnescapeString(tags.ReplaceAllString(string(block[1]), "")); got != test.code {
				t.Errorf("code text changed: %q, want %q", got, test.code)
			}
			for _, want := range []string{".chroma .k", "@media (prefers-color-scheme: dark)"} {
				if !strings.Contains(string(page), want) {
					t.Errorf("missing bundled syntax theme %q", want)
				}
			}
		})
	}
}

func TestPageHandler(t *testing.T) {
	page := []byte("<!doctype html><h1>Guide</h1>")
	handler := pageHandler("127.0.0.1:12345", "/tmp-guide-md.html", page)
	for _, test := range []struct {
		name, method, host, path string
		status                   int
	}{
		{"rendered document", "GET", "127.0.0.1:12345", "/tmp-guide-md.html", 200},
		{"localhost alias", "GET", "localhost:12345", "/tmp-guide-md.html", 200},
		{"HEAD", "HEAD", "127.0.0.1:12345", "/tmp-guide-md.html", 200},
		{"directory is not exposed", "GET", "127.0.0.1:12345", "/", 404},
		{"other files are not exposed", "GET", "127.0.0.1:12345", "/other.md", 404},
		{"unexpected host", "GET", "example.com:12345", "/tmp-guide-md.html", 403},
		{"read only", "POST", "127.0.0.1:12345", "/tmp-guide-md.html", 405},
	} {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(test.method, "http://"+test.host+test.path, nil)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != test.status {
				t.Fatalf("HTTP %d, want %d", response.Code, test.status)
			}
			if test.status == 200 {
				if response.Header().Get("Content-Type") != "text/html; charset=utf-8" {
					t.Error("missing HTML content type")
				}
				if test.method == "GET" && response.Body.String() != string(page) {
					t.Error("served page differs from generated HTML")
				}
				if test.method == "HEAD" && response.Body.Len() != 0 {
					t.Error("HEAD should not return a body")
				}
			}
		})
	}
}

func TestInvalidCLIInput(t *testing.T) {
	for _, args := range [][]string{nil, {"a.md", "b.md"}, {"/does/not/exist.md"}} {
		if err := run(context.Background(), args, io.Discard, io.Discard); err == nil {
			t.Errorf("expected error for args %v", args)
		}
	}
	if err := run(context.Background(), []string{"--help"}, io.Discard, io.Discard); err != nil {
		t.Errorf("help failed: %v", err)
	}
}

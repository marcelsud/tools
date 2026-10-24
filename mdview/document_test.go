package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func testDocument(t *testing.T, onSave func(savedEvent)) *document {
	t.Helper()
	source := filepath.Join(t.TempDir(), "draft.md")
	if err := os.WriteFile(source, []byte("# Original\n"), 0640); err != nil {
		t.Fatal(err)
	}
	doc, err := openDocument(source, false, onSave)
	if err != nil {
		t.Fatal(err)
	}
	return doc
}

func documentRequest(t *testing.T, doc *document, method string, body []byte, configure func(*http.Request)) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(method, "http://127.0.0.1:12345"+documentEndpoint, bytes.NewReader(body))
	r.Header.Set("X-Mdview-Token", doc.token)
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Origin", "http://127.0.0.1:12345")
	if configure != nil {
		configure(r)
	}
	w := httptest.NewRecorder()
	doc.handler("127.0.0.1:12345", "/draft.html", nil).ServeHTTP(w, r)
	return w
}

func saveBody(t *testing.T, markdown, rev string) []byte {
	t.Helper()
	body, err := json.Marshal(map[string]string{"markdown": markdown, "revision": rev})
	if err != nil {
		t.Fatal(err)
	}
	return body
}

func TestBrowserSaveWritesOriginalAndNotifiesOnlyWhenChanged(t *testing.T) {
	var events []savedEvent
	doc := testDocument(t, func(event savedEvent) { events = append(events, event) })
	response := documentRequest(t, doc, "GET", nil, nil)
	var original documentSnapshot
	if err := json.Unmarshal(response.Body.Bytes(), &original); err != nil {
		t.Fatal(err)
	}
	if response.Code != 200 || original.Markdown != "# Original\n" {
		t.Fatalf("source response: %d %s", response.Code, response.Body.String())
	}

	markdown := "# Updated café\n\n<script>alert(1)</script>\n"
	response = documentRequest(t, doc, "POST", saveBody(t, markdown, original.Revision), nil)
	if response.Code != 200 {
		t.Fatalf("save: %d %s", response.Code, response.Body.String())
	}
	got, _ := os.ReadFile(doc.source)
	if string(got) != markdown {
		t.Fatalf("source = %q, want %q", got, markdown)
	}
	info, _ := os.Stat(doc.source)
	if info.Mode().Perm() != 0640 {
		t.Fatalf("permissions changed to %v", info.Mode())
	}
	if len(events) != 1 || events[0].Type != "mdview.saved" || events[0].Path != doc.source ||
		events[0].PreviousRevision != original.Revision || events[0].Revision != revision(got) || events[0].Time == "" {
		t.Fatalf("save events: %+v", events)
	}

	response = documentRequest(t, doc, "POST", saveBody(t, markdown, revision(got)), nil)
	if response.Code != 200 || len(events) != 1 {
		t.Fatalf("no-op save must succeed without a second event: %d %+v", response.Code, events)
	}
	page := httptest.NewRecorder()
	doc.handler("127.0.0.1:12345", "/draft.html", nil).ServeHTTP(page,
		httptest.NewRequest("GET", "http://127.0.0.1:12345/draft.html", nil))
	if page.Code != 200 || !strings.Contains(page.Body.String(), "Updated café") || strings.Contains(page.Body.String(), "<script>alert") {
		t.Fatalf("saved Markdown was not safely rendered: %d", page.Code)
	}
}

func TestInvalidBrowserRequestsCannotWriteOrNotify(t *testing.T) {
	for _, tc := range []struct {
		name      string
		configure func(*http.Request)
		body      string
		status    int
	}{
		{name: "unexpected host", configure: func(r *http.Request) { r.Host = "attacker.example" }, status: 403},
		{name: "missing origin", configure: func(r *http.Request) { r.Header.Del("Origin") }, status: 403},
		{name: "cross origin", configure: func(r *http.Request) { r.Header.Set("Origin", "https://attacker.example") }, status: 403},
		{name: "missing token", configure: func(r *http.Request) { r.Header.Del("X-Mdview-Token") }, status: 403},
		{name: "wrong token", configure: func(r *http.Request) { r.Header.Set("X-Mdview-Token", "wrong") }, status: 403},
		{name: "wrong content type", configure: func(r *http.Request) { r.Header.Set("Content-Type", "text/plain") }, status: 415},
		{name: "arbitrary file", body: `{"markdown":"overwrite","revision":"old","path":"/tmp/other.md"}`, status: 400},
		{name: "missing markdown", body: `{"revision":"old"}`, status: 400},
		{name: "missing revision", body: `{"markdown":"overwrite"}`, status: 400},
		{name: "multiple documents", body: `{"markdown":"overwrite","revision":"old"}{}`, status: 400},
		{name: "stale revision", body: `{"markdown":"overwrite","revision":"old"}`, status: 409},
		{name: "oversized body", body: strings.Repeat("x", maxSaveBytes+1), status: 413},
	} {
		t.Run(tc.name, func(t *testing.T) {
			events := 0
			doc := testDocument(t, func(savedEvent) { events++ })
			body := []byte(tc.body)
			if tc.body == "" {
				body = saveBody(t, "overwrite", revision([]byte("# Original\n")))
			}
			response := documentRequest(t, doc, "POST", body, tc.configure)
			if response.Code != tc.status {
				t.Fatalf("HTTP %d, want %d: %s", response.Code, tc.status, response.Body.String())
			}
			got, _ := os.ReadFile(doc.source)
			if string(got) != "# Original\n" || events != 0 {
				t.Fatalf("rejected request wrote %q or emitted %d events", got, events)
			}
		})
	}
}

func TestExternalEditIsPreservedWhenBrowserRevisionIsStale(t *testing.T) {
	doc := testDocument(t, nil)
	original, _ := doc.read()
	if err := os.WriteFile(doc.source, []byte("# Changed elsewhere\n"), 0640); err != nil {
		t.Fatal(err)
	}
	response := documentRequest(t, doc, "POST", saveBody(t, "# Browser draft\n", original.Revision), nil)
	if response.Code != http.StatusConflict {
		t.Fatalf("HTTP %d, want conflict", response.Code)
	}
	got, _ := os.ReadFile(doc.source)
	if string(got) != "# Changed elsewhere\n" {
		t.Fatalf("external edit was overwritten: %q", got)
	}
}

func TestConcurrentSavesFromSameRevisionCannotBothSucceed(t *testing.T) {
	events := make(chan savedEvent, 2)
	doc := testDocument(t, func(event savedEvent) { events <- event })
	initial, _ := doc.read()
	results := make(chan error, 2)
	var group sync.WaitGroup
	for _, markdown := range []string{"# First\n", "# Second\n"} {
		group.Add(1)
		go func(markdown string) {
			defer group.Done()
			_, err := doc.save(markdown, initial.Revision)
			results <- err
		}(markdown)
	}
	group.Wait()
	close(results)
	successes, conflicts := 0, 0
	for err := range results {
		if err == nil {
			successes++
		} else if errors.Is(err, errConflict) {
			conflicts++
		} else {
			t.Fatal(err)
		}
	}
	if successes != 1 || conflicts != 1 || len(events) != 1 {
		t.Fatalf("successes=%d conflicts=%d events=%d", successes, conflicts, len(events))
	}
	got, _ := os.ReadFile(doc.source)
	if string(got) != "# First\n" && string(got) != "# Second\n" {
		t.Fatalf("partial or invalid source: %q", got)
	}
}

func TestReadOnlyViewerHasNoEditorOrSaveEndpoint(t *testing.T) {
	doc := testDocument(t, nil)
	doc.readOnly = true
	response := documentRequest(t, doc, "POST", saveBody(t, "overwrite", "old"), nil)
	if response.Code != 404 {
		t.Fatalf("read-only endpoint status = %d", response.Code)
	}
	page, err := doc.render([]byte("# Draft\n"))
	if err != nil || bytes.Contains(page, []byte("data-mdview-editor")) {
		t.Fatal("read-only page contains an editor")
	}
}

func TestSymlinkSourceSavesTargetWithoutReplacingLink(t *testing.T) {
	doc := testDocument(t, nil)
	link := filepath.Join(t.TempDir(), "link.md")
	if err := os.Symlink(doc.source, link); err != nil {
		t.Fatal(err)
	}
	linked, err := openDocument(link, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	initial, _ := linked.read()
	if _, err := linked.save("# Saved through link\n", initial.Revision); err != nil {
		t.Fatal(err)
	}
	info, _ := os.Lstat(link)
	if info.Mode()&os.ModeSymlink == 0 {
		t.Fatal("the source symlink was replaced")
	}
	got, _ := os.ReadFile(doc.source)
	if string(got) != "# Saved through link\n" {
		t.Fatalf("target = %q", got)
	}
}

func TestAgentInstructionsRequireNoDocumentAndDescribeWaitLoop(t *testing.T) {
	var output bytes.Buffer
	if err := run(context.Background(), []string{"--agent-instructions"}, &output, &output); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"mdview --watch", "mdview.saved", "Keep your turn active", "Stop waiting"} {
		if !strings.Contains(output.String(), want) {
			t.Errorf("instructions missing %q", want)
		}
	}
	if err := run(context.Background(), []string{"--watch", "--read-only", "unused.md"}, &output, &output); err == nil {
		t.Error("read-only watch must be rejected")
	}
}

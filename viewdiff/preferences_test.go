package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func preferenceRequest(t *testing.T, handler http.HandlerFunc, method, body string) viewPreferences {
	t.Helper()
	response := httptest.NewRecorder()
	handler(response, httptest.NewRequest(method, "/api/preferences", strings.NewReader(body)))
	if response.Code != http.StatusOK {
		t.Fatalf("%s preferences: %d %s", method, response.Code, response.Body.String())
	}
	var values viewPreferences
	if err := json.Unmarshal(response.Body.Bytes(), &values); err != nil {
		t.Fatal(err)
	}
	return values
}

func TestPreferencesSharedAcrossViewers(t *testing.T) {
	path := filepath.Join(t.TempDir(), "viewdiff", "preferences.json")
	first := preferencesHandler(path)
	if values := preferenceRequest(t, first, "GET", ""); values != (viewPreferences{}) {
		t.Fatalf("unexpected defaults: %+v", values)
	}
	preferenceRequest(t, first, "PATCH", `{"theme":"dark","layout":"unified","wrap":true,"sidebar":false}`)
	second := preferencesHandler(path)
	values := preferenceRequest(t, second, "GET", "")
	if values.Theme != "dark" || values.Layout != "unified" || values.Wrap == nil || !*values.Wrap || values.Sidebar == nil || *values.Sidebar {
		t.Fatalf("preferences lost across viewers: %+v", values)
	}
	preferenceRequest(t, second, "PATCH", `{"wrap":false}`)
	values = preferenceRequest(t, first, "GET", "")
	if values.Theme != "dark" || values.Layout != "unified" || *values.Wrap || *values.Sidebar {
		t.Fatalf("partial update overwrote other preferences: %+v", values)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("preferences should be private, permissions: %v", info.Mode())
	}
}

func TestPreferencesConcurrentPartialUpdates(t *testing.T) {
	path := filepath.Join(t.TempDir(), "preferences.json")
	var group sync.WaitGroup
	for _, body := range []string{`{"theme":"dark"}`, `{"layout":"unified"}`, `{"wrap":true}`, `{"sidebar":false}`} {
		group.Add(1)
		go func(body string) {
			defer group.Done()
			response := httptest.NewRecorder()
			preferencesHandler(path)(response, httptest.NewRequest("PATCH", "/api/preferences", strings.NewReader(body)))
			if response.Code != http.StatusOK {
				t.Errorf("save preferences: %s", response.Body.String())
			}
		}(body)
	}
	group.Wait()
	values := preferenceRequest(t, preferencesHandler(path), "GET", "")
	if values.Theme != "dark" || values.Layout != "unified" || values.Wrap == nil || !*values.Wrap || values.Sidebar == nil || *values.Sidebar {
		t.Fatalf("concurrent updates lost: %+v", values)
	}
}

func TestPreferencesRejectInvalidUpdates(t *testing.T) {
	path := filepath.Join(t.TempDir(), "preferences.json")
	handler := preferencesHandler(path)
	preferenceRequest(t, handler, "PATCH", `{"theme":"dark"}`)
	for _, body := range []string{
		`{"theme":"invalid"}`, `{"layout":"invalid"}`, `{"wrap":"true"}`,
		`{"sidebar":1}`, `{"unknown":true}`, `{"theme":"light"} {}`,
		`{`, strings.Repeat(" ", 4097) + `{}`,
	} {
		t.Run(body[:min(len(body), 40)], func(t *testing.T) {
			response := httptest.NewRecorder()
			handler(response, httptest.NewRequest("PATCH", "/api/preferences", strings.NewReader(body)))
			if response.Code != http.StatusBadRequest {
				t.Fatalf("invalid update accepted: %d", response.Code)
			}
		})
	}
	if values := preferenceRequest(t, handler, "GET", ""); values.Theme != "dark" {
		t.Fatal("invalid update changed saved preferences")
	}
}

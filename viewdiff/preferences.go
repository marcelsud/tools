package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"syscall"
)

type viewPreferences struct {
	Theme   string `json:"theme,omitempty"`
	Layout  string `json:"layout,omitempty"`
	Wrap    *bool  `json:"wrap,omitempty"`
	Sidebar *bool  `json:"sidebar,omitempty"`
}

// Each viewer has its own port. A shared file bridges those localStorage origins.
// Lock and atomic replacement also protect simultaneous viewer processes.
func storedPreferences(path string, update *viewPreferences) (viewPreferences, error) {
	var values viewPreferences
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return values, err
	}
	lock, err := os.OpenFile(path+".lock", os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return values, err
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX); err != nil {
		return values, err
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	content, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		return values, err
	}
	if err == nil {
		if err := json.Unmarshal(content, &values); err != nil {
			return values, err
		}
	}
	if update == nil {
		return values, nil
	}
	if update.Theme != "" {
		values.Theme = update.Theme
	}
	if update.Layout != "" {
		values.Layout = update.Layout
	}
	if update.Wrap != nil {
		values.Wrap = update.Wrap
	}
	if update.Sidebar != nil {
		values.Sidebar = update.Sidebar
	}
	file, err := os.CreateTemp(filepath.Dir(path), ".preferences-*")
	if err != nil {
		return values, err
	}
	defer os.Remove(file.Name())
	encodeErr := json.NewEncoder(file).Encode(values)
	closeErr := file.Close()
	if encodeErr != nil {
		return values, encodeErr
	}
	if closeErr != nil {
		return values, closeErr
	}
	return values, os.Rename(file.Name(), path)
}

func preferencesHandler(path string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var update *viewPreferences
		if r.Method == http.MethodPatch {
			update = &viewPreferences{}
			decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
			decoder.DisallowUnknownFields()
			if err := decoder.Decode(update); err != nil {
				http.Error(w, "Invalid preferences", http.StatusBadRequest)
				return
			}
			if err := decoder.Decode(new(any)); err != io.EOF {
				http.Error(w, "Invalid preferences", http.StatusBadRequest)
				return
			}
			if (update.Theme != "" && update.Theme != "dark" && update.Theme != "light") ||
				(update.Layout != "" && update.Layout != "split" && update.Layout != "unified") {
				http.Error(w, "Invalid preferences", http.StatusBadRequest)
				return
			}
		} else if r.Method != http.MethodGet {
			w.Header().Set("Allow", "GET, PATCH")
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		values, err := storedPreferences(path, update)
		if err != nil {
			http.Error(w, fmt.Sprintf("Unable to access preferences: %v", err), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(values)
	}
}

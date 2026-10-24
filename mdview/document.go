package main

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"
	"unicode/utf8"
)

const documentEndpoint = "/_mdview/document"
const maxSaveBytes = 2 << 20

var errConflict = errors.New("the file changed since editing began; copy your edits before reloading")

type savedEvent struct {
	Type             string `json:"type"`
	Path             string `json:"path"`
	Revision         string `json:"revision"`
	PreviousRevision string `json:"previousRevision"`
	Time             string `json:"time"`
}

type documentSnapshot struct {
	Markdown string `json:"markdown"`
	Revision string `json:"revision"`
}

type document struct {
	source   string
	token    string
	readOnly bool
	onSave   func(savedEvent)
	mu       sync.Mutex
}

func openDocument(source string, readOnly bool, onSave func(savedEvent)) (*document, error) {
	resolved, err := filepath.EvalSymlinks(source)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(resolved)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, errors.New("expected a regular Markdown file")
	}
	token := make([]byte, 32)
	if _, err := rand.Read(token); err != nil {
		return nil, err
	}
	return &document{source: resolved, token: hex.EncodeToString(token), readOnly: readOnly, onSave: onSave}, nil
}

func revision(markdown []byte) string {
	sum := sha256.Sum256(markdown)
	return hex.EncodeToString(sum[:])
}

func (d *document) read() (documentSnapshot, error) {
	info, err := os.Lstat(d.source)
	if err != nil {
		return documentSnapshot{}, err
	}
	if !info.Mode().IsRegular() {
		return documentSnapshot{}, errors.New("the source is no longer a regular file")
	}
	markdown, err := os.ReadFile(d.source)
	if err != nil {
		return documentSnapshot{}, err
	}
	if !utf8.Valid(markdown) {
		return documentSnapshot{}, errors.New("input is not valid UTF-8")
	}
	return documentSnapshot{Markdown: string(markdown), Revision: revision(markdown)}, nil
}

func (d *document) render(markdown []byte) ([]byte, error) {
	if d.readOnly {
		return render(d.source, markdown)
	}
	return renderEditable(d.source, markdown, d.token)
}

func (d *document) save(markdown, previous string) (documentSnapshot, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.readOnly {
		return documentSnapshot{}, errors.New("this viewer is read-only")
	}
	current, err := d.read()
	if err != nil {
		return documentSnapshot{}, err
	}
	if previous != current.Revision {
		return documentSnapshot{}, errConflict
	}
	if markdown == current.Markdown {
		return current, nil
	}
	info, err := os.Stat(d.source)
	if err != nil {
		return documentSnapshot{}, err
	}
	if err := replaceFile(d.source, []byte(markdown), info.Mode().Perm()); err != nil {
		return documentSnapshot{}, err
	}
	saved := documentSnapshot{Markdown: markdown, Revision: revision([]byte(markdown))}
	if d.onSave != nil {
		d.onSave(savedEvent{
			Type: "mdview.saved", Path: d.source, Revision: saved.Revision,
			PreviousRevision: current.Revision, Time: time.Now().UTC().Format(time.RFC3339Nano),
		})
	}
	return saved, nil
}

func replaceFile(path string, content []byte, mode os.FileMode) error {
	file, err := os.CreateTemp(filepath.Dir(path), ".mdview-save-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	defer file.Close()
	if err := file.Chmod(mode); err != nil {
		return err
	}
	if _, err := file.Write(content); err != nil {
		return err
	}
	if err := file.Sync(); err != nil {
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	return os.Rename(file.Name(), path)
}

func (d *document) handler(address, path string, initialPage []byte) http.Handler {
	static := pageHandler(address, path, initialPage)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !allowedHost(address, r.Host) {
			http.Error(w, "unexpected host", http.StatusForbidden)
			return
		}
		if r.URL.Path == documentEndpoint && !d.readOnly {
			d.serveDocument(w, r)
			return
		}
		if r.URL.Path == path && (r.Method == http.MethodGet || r.Method == http.MethodHead) {
			snapshot, err := d.read()
			if err != nil {
				http.Error(w, fmt.Sprintf("read Markdown: %v", err), http.StatusInternalServerError)
				return
			}
			page, err := d.render([]byte(snapshot.Markdown))
			if err != nil {
				http.Error(w, "unable to render Markdown", http.StatusInternalServerError)
				return
			}
			pageHandler(address, path, page).ServeHTTP(w, r)
			return
		}
		static.ServeHTTP(w, r)
	})
}

func (d *document) serveDocument(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	fail := func(status int, message string) {
		w.WriteHeader(status)
		json.NewEncoder(w).Encode(map[string]string{"error": message})
	}
	if r.Method != http.MethodGet && r.Method != http.MethodPost {
		w.Header().Set("Allow", "GET, POST")
		fail(http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if r.Header.Get("X-Mdview-Token") != d.token {
		fail(http.StatusForbidden, "invalid session token")
		return
	}
	if r.Method == http.MethodGet {
		snapshot, err := d.read()
		if err != nil {
			fail(http.StatusInternalServerError, "unable to read source file")
			return
		}
		json.NewEncoder(w).Encode(snapshot)
		return
	}
	if r.Header.Get("Origin") != "http://"+r.Host {
		fail(http.StatusForbidden, "unexpected origin")
		return
	}
	mediaType, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if mediaType != "application/json" {
		fail(http.StatusUnsupportedMediaType, "expected application/json")
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxSaveBytes))
	if err != nil {
		fail(http.StatusRequestEntityTooLarge, "document exceeds the 2 MiB save limit")
		return
	}
	var input struct {
		Markdown *string `json:"markdown"`
		Revision string  `json:"revision"`
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if !utf8.Valid(body) || decoder.Decode(&input) != nil || input.Markdown == nil || input.Revision == "" {
		fail(http.StatusBadRequest, "expected UTF-8 Markdown and its revision")
		return
	}
	if decoder.Decode(new(any)) != io.EOF {
		fail(http.StatusBadRequest, "expected one JSON document")
		return
	}
	saved, err := d.save(*input.Markdown, input.Revision)
	if errors.Is(err, errConflict) {
		fail(http.StatusConflict, err.Error())
		return
	}
	if err != nil {
		fail(http.StatusInternalServerError, "unable to save source file")
		return
	}
	json.NewEncoder(w).Encode(saved)
}

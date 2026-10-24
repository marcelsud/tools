package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, os.Args[1:], os.Stdout, os.Stderr); err != nil {
		fmt.Fprintln(os.Stderr, "mdview:", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string, stdout, stderr io.Writer) error {
	flags := flag.NewFlagSet("mdview", flag.ContinueOnError)
	flags.SetOutput(stderr)
	readOnly := flags.Bool("read-only", false, "disable browser editing")
	watch := flags.Bool("watch", false, "emit a JSON event after each browser save, for a waiting agent")
	instructions := flags.Bool("agent-instructions", false, "print the AI-agnostic editing and watching instructions")
	flags.Usage = func() {
		fmt.Fprintln(stderr, "Usage: mdview [--watch] [--read-only] <file.md>\n\nEdit Markdown in your browser and save to the source file.\nThe server runs until Ctrl+C; no browser is opened automatically.")
		fmt.Fprintln(stderr, "\nWith --watch, keep the agent waiting; after each save, reread the file, respond, and wait again.")
		flags.PrintDefaults()
	}
	if err := flags.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	if *instructions {
		_, err := fmt.Fprint(stdout, agentInstructions)
		return err
	}
	if *watch && *readOnly {
		return errors.New("--watch requires browser editing; remove --read-only")
	}
	if flags.NArg() != 1 {
		return errors.New("expected one Markdown file; usage: mdview <file.md>")
	}
	source, err := filepath.Abs(flags.Arg(0))
	if err != nil {
		return err
	}
	var onSave func(savedEvent)
	if *watch {
		onSave = func(event savedEvent) {
			if err := json.NewEncoder(stdout).Encode(event); err != nil {
				fmt.Fprintln(stderr, "mdview: unable to emit save event:", err)
			}
		}
	}
	document, err := openDocument(source, *readOnly, onSave)
	if err != nil {
		return err
	}
	markdown, err := os.ReadFile(document.source)
	if err != nil {
		return fmt.Errorf("read Markdown: %w", err)
	}
	page, err := document.render(markdown)
	if err != nil {
		return fmt.Errorf("render Markdown: %w", err)
	}
	dir, err := os.MkdirTemp("/tmp", "mdview-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	name := flatFilename(source)
	if err := os.WriteFile(filepath.Join(dir, name), page, 0600); err != nil {
		return err
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return fmt.Errorf("start local server: %w", err)
	}
	defer listener.Close()
	address := listener.Addr().String()
	link := (&url.URL{Scheme: "http", Host: address, Path: "/" + name}).String()
	server := &http.Server{
		Handler:           document.handler(address, "/"+name, page),
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       30 * time.Second,
	}
	done := make(chan struct{})
	defer close(done)
	go func() {
		select {
		case <-ctx.Done():
			server.Close()
		case <-done:
		}
	}()
	fmt.Fprintln(stderr, "Press Ctrl+C to stop and remove the temporary HTML file.")
	if *watch {
		fmt.Fprintln(stderr, agentInstructions)
	}
	if _, err := fmt.Fprintln(stdout, link); err != nil {
		return err
	}
	if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

func pageHandler(address, path string, page []byte) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !allowedHost(address, r.Host) {
			http.Error(w, "unexpected host", http.StatusForbidden)
			return
		}
		asset, isAsset := map[string][]byte{
			"/_mdview/pele.global.js": peleJS,
			"/_mdview/diagrams.js":    diagramsJS,
			"/_mdview/editor.js":      editorJS,
		}[r.URL.Path]
		if r.URL.Path != path && !isAsset {
			http.NotFound(w, r)
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Content-Security-Policy", "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; img-src https: http: data:; font-src data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'")
		if isAsset {
			w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
			http.ServeContent(w, r, r.URL.Path, time.Time{}, bytes.NewReader(asset))
			return
		}
		http.ServeContent(w, r, path, time.Time{}, bytes.NewReader(page))
	})
}

func allowedHost(address, host string) bool {
	_, port, _ := net.SplitHostPort(address)
	return host == address || host == "localhost:"+port
}

package main

import (
	"context"
	"crypto/rand"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

//go:embed web/*
var assets embed.FS

type options struct {
	repo, base, head, mode string
	port                   int
	noOpen                 bool
	comments               commentFlags
}

func main() {
	opt, err := parseOptions(os.Args[1:], os.Stderr)
	if errors.Is(err, flag.ErrHelp) {
		return
	}
	if err != nil {
		fail(err)
	}
	if err := run(opt); err != nil {
		fail(err)
	}
}

func parseOptions(arguments []string, output io.Writer) (options, error) {
	var opt options
	flag := flag.NewFlagSet("viewdiff", flag.ContinueOnError)
	flag.SetOutput(output)
	flag.StringVar(&opt.repo, "repo", ".", "repository or worktree directory")
	flag.StringVar(&opt.base, "base", "", "base ref (default: origin's default branch, main, master, or HEAD)")
	flag.BoolVar(&opt.noOpen, "no-open", false, "serve without opening Island")
	flag.IntVar(&opt.port, "port", 0, "local port (default: a free port)")
	flag.Var(&opt.comments, "c", "labeled note: [label;start:end] text or [label;file:old|new:start:end] text (repeatable)")
	working := flag.Bool("working", false, "show staged, unstaged, and untracked changes against HEAD")
	staged := flag.Bool("staged", false, "show only staged changes against HEAD")
	flag.Usage = func() {
		fmt.Fprintln(flag.Output(), `Usage: viewdiff [options] [base [head]]

Opens a read-only GitHub-style diff viewer in Island.
Default: compare the working tree to the merge base with the default branch,
including committed, staged, unstaged, and untracked changes.
With both base and head, compare their commits using the merge base.
The browser can switch between branch, working-tree, and staged views.

Viewer: split/unified layouts, expandable context, syntax coloring, file filters,
and viewed markers (reset when a file's diff changes). Theme and wrap are in the toolbar.
Theme, layout, wrap, and sidebar preferences persist across launches.
Review notes (-c) appear as expandable callouts beside inclusive source line ranges.
Supply any nonempty label before the semicolon, for example [Notes;123:456].
Ranges use new-file lines by default; use [label;file:old:start:end] for base-file lines.
Omit the file when the range identifies a single changed file; otherwise qualify it.
Notes are local to this launch and are marked stale if their diff changes.
Keyboard: Up/Down selects files, / focuses the filter, U/S switches layout.

Examples:
  viewdiff                         review the current branch and local edits
  viewdiff origin/main            choose a branch comparison base
  viewdiff origin/main HEAD       review committed branch changes only
  viewdiff --working              review all uncommitted changes
  viewdiff --staged               review the index only
  viewdiff --repo /path/to/repo    review another repository
  viewdiff main HEAD -c "[Notes;123:456] Explain this section" -c "[Context;456:457] Another note"
  viewdiff main HEAD -c "[Why;src/app.go:12:24] Why this changed"
  viewdiff main HEAD -c "[Removal;src/app.go:old:12:24] Why these lines were removed"

The server binds only to 127.0.0.1. Ctrl-C stops it.
Options:`)
		flag.PrintDefaults()
	}
	ordered, err := interspersedArgs(flag, arguments)
	if err != nil {
		return opt, err
	}
	if err := flag.Parse(ordered); err != nil {
		return opt, err
	}
	if *working && *staged {
		return opt, errors.New("--working and --staged are mutually exclusive")
	}
	args := flag.Args()
	if len(args) > 2 || (len(args) > 0 && opt.base != "") || (len(args) > 0 && (*working || *staged)) {
		return opt, errors.New("use [base [head]], --base, --working, or --staged, not conflicting combinations")
	}
	if len(args) > 0 {
		opt.base = args[0]
	}
	if len(args) > 1 {
		opt.head = args[1]
	}
	opt.mode = "branch"
	if *working {
		opt.mode = "working"
	} else if *staged {
		opt.mode = "staged"
	}
	return opt, nil
}

func interspersedArgs(flags *flag.FlagSet, arguments []string) ([]string, error) {
	var options, positional []string
	for i := 0; i < len(arguments); i++ {
		arg := arguments[i]
		if arg == "--" {
			positional = append(positional, arguments[i+1:]...)
			break
		}
		if arg == "-" || !strings.HasPrefix(arg, "-") {
			positional = append(positional, arg)
			continue
		}
		name, _, inline := strings.Cut(strings.TrimLeft(arg, "-"), "=")
		if name == "h" || name == "help" {
			return []string{"-h"}, nil
		}
		entry := flags.Lookup(name)
		if entry == nil {
			return nil, fmt.Errorf("unknown flag %q", arg)
		}
		options = append(options, arg)
		boolean, isBoolean := entry.Value.(interface{ IsBoolFlag() bool })
		if inline || (isBoolean && boolean.IsBoolFlag()) {
			continue
		}
		if i+1 == len(arguments) {
			return nil, fmt.Errorf("flag %q needs a value", arg)
		}
		i++
		options = append(options, arguments[i])
	}
	return append(append(options, "--"), positional...), nil
}

func fail(err error) {
	fmt.Fprintf(os.Stderr, "viewdiff: %v\n", err)
	os.Exit(1)
}

func run(opt options) error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	root, err := git(ctx, opt.repo, "rev-parse", "--show-toplevel")
	if err != nil {
		return fmt.Errorf("run inside a Git repository, or pass --repo: %w", err)
	}
	opt.repo = strings.TrimSuffix(string(root), "\n")
	if opt.base == "" {
		opt.base = defaultBase(ctx, opt.repo)
	}
	initial, err := loadDiff(ctx, opt, opt.mode, opt.base)
	if err != nil {
		return err
	}
	opt.comments, err = resolveComments(initial, opt.comments)
	if err != nil {
		return err
	}
	attachComments(initial, opt.comments)
	listener, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", opt.port))
	if err != nil {
		return err
	}
	defer listener.Close()
	var secret [24]byte
	if _, err := rand.Read(secret[:]); err != nil {
		return err
	}
	prefix := "/" + hex.EncodeToString(secret[:]) + "/"
	address := listener.Addr().String()
	url := "http://" + address + prefix
	web, err := fs.Sub(assets, "web")
	if err != nil {
		return err
	}
	configDir, err := os.UserConfigDir()
	if err != nil {
		return err
	}
	var mu sync.RWMutex
	current := initial
	mux := http.NewServeMux()
	preferences := preferencesHandler(filepath.Join(configDir, "viewdiff", "preferences.json"))
	mux.HandleFunc("GET "+prefix+"api/preferences", preferences)
	mux.HandleFunc("PATCH "+prefix+"api/preferences", preferences)
	mux.HandleFunc("GET "+prefix+"api/diff", func(w http.ResponseWriter, r *http.Request) {
		mode, base := r.URL.Query().Get("mode"), r.URL.Query().Get("base")
		if mode == "" {
			mode = opt.mode
		}
		if base == "" {
			base = opt.base
		}
		diff, err := loadDiff(r.Context(), opt, mode, base)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		attachComments(diff, opt.comments)
		mu.Lock()
		current = diff
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(diff)
	})
	mux.HandleFunc("GET "+prefix+"api/context", func(w http.ResponseWriter, r *http.Request) {
		mu.RLock()
		diff := current
		mu.RUnlock()
		id := r.URL.Query().Get("id")
		var file *changedFile
		for i := range diff.Files {
			if diff.Files[i].ID == id {
				file = &diff.Files[i]
				break
			}
		}
		if file == nil || file.OldPath != r.URL.Query().Get("path") || diff.OldRevision != r.URL.Query().Get("revision") {
			http.NotFound(w, r)
			return
		}
		var content []byte
		var readErr error
		if file.Status != "A" && file.Status != "?" {
			content, readErr = git(r.Context(), opt.repo, "show", diff.OldRevision+":"+file.OldPath)
			if readErr != nil {
				http.Error(w, "Unable to read base file: "+readErr.Error(), http.StatusBadRequest)
				return
			}
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(struct {
			Content string `json:"content"`
		}{string(content)})
	})
	mux.Handle("GET "+prefix, http.StripPrefix(prefix, http.FileServer(http.FS(web))))
	server := &http.Server{
		ReadHeaderTimeout: 5 * time.Second,
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Host != address || !strings.HasPrefix(r.URL.Path, prefix) {
				http.NotFound(w, r)
				return
			}
			if origin := r.Header.Get("Origin"); origin != "" && origin != "http://"+address {
				http.Error(w, "Forbidden origin", http.StatusForbidden)
				return
			}
			w.Header().Set("Cache-Control", "no-store")
			w.Header().Set("X-Content-Type-Options", "nosniff")
			w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
			mux.ServeHTTP(w, r)
		}),
	}
	done := make(chan error, 1)
	go func() { done <- server.Serve(listener) }()
	fmt.Printf("viewdiff %s\n%s · %s\nPress Ctrl-C to stop.\n", url, filepath.Base(opt.repo), initial.Label)
	if !opt.noOpen {
		if err := exec.CommandContext(ctx, "open", "-a", "Island", url).Run(); err != nil {
			server.Close()
			return fmt.Errorf("could not open Island; use --no-open to open the printed URL manually: %w", err)
		}
	}
	select {
	case <-ctx.Done():
		return server.Close()
	case err := <-done:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	}
}

package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"iter"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

type diffResult struct {
	Repo        string        `json:"repo"`
	Branch      string        `json:"branch"`
	Base        string        `json:"base"`
	DefaultBase string        `json:"defaultBase"`
	Mode        string        `json:"mode"`
	Label       string        `json:"label"`
	OldRevision string        `json:"oldRevision"`
	Files       []changedFile `json:"files"`
	Additions   int           `json:"additions"`
	Deletions   int           `json:"deletions"`
}

type changedFile struct {
	ID        string          `json:"id"`
	Path      string          `json:"path"`
	OldPath   string          `json:"oldPath"`
	Status    string          `json:"status"`
	Binary    bool            `json:"binary"`
	Message   string          `json:"message"`
	Additions int             `json:"additions"`
	Deletions int             `json:"deletions"`
	Hunks     []hunk          `json:"hunks"`
	Comments  []reviewComment `json:"comments,omitempty"`
}

type hunk struct {
	Header   string     `json:"header"`
	OldStart int        `json:"oldStart"`
	NewStart int        `json:"newStart"`
	Lines    []diffLine `json:"lines"`
}

type diffLine struct {
	Type    string `json:"type"`
	OldLine int    `json:"oldLine,omitempty"`
	NewLine int    `json:"newLine,omitempty"`
	Text    string `json:"text"`
}

func git(ctx context.Context, repo string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = repo
	var stderr strings.Builder
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		message := strings.TrimSpace(stderr.String())
		if message == "" {
			message = err.Error()
		}
		return nil, fmt.Errorf("git %s: %s", args[0], message)
	}
	return out, nil
}

func revision(ctx context.Context, repo, ref string) (string, error) {
	out, err := git(ctx, repo, "rev-parse", "--verify", "--end-of-options", ref+"^{commit}")
	return strings.TrimSpace(string(out)), err
}

func defaultBase(ctx context.Context, repo string) string {
	if out, err := git(ctx, repo, "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"); err == nil {
		ref := strings.TrimSpace(string(out))
		ref = strings.TrimPrefix(ref, "refs/remotes/")
		if _, err := revision(ctx, repo, ref); err == nil {
			return ref
		}
	}
	for _, ref := range []string{"origin/main", "main", "origin/master", "master", "HEAD"} {
		if _, err := revision(ctx, repo, ref); err == nil {
			return ref
		}
	}
	return "HEAD"
}

func loadDiff(ctx context.Context, opt options, mode, base string) (*diffResult, error) {
	if mode != "branch" && mode != "working" && mode != "staged" {
		return nil, errors.New("unknown comparison mode")
	}
	head, _ := revision(ctx, opt.repo, "HEAD")
	branch := "unborn branch"
	if out, err := git(ctx, opt.repo, "symbolic-ref", "--quiet", "--short", "HEAD"); err == nil {
		branch = strings.TrimSpace(string(out))
	} else if head != "" {
		branch = head[:8]
	}
	old := head
	if old == "" {
		out, err := git(ctx, opt.repo, "hash-object", "-t", "tree", "--stdin")
		if err != nil {
			return nil, err
		}
		old = strings.TrimSpace(string(out))
	}
	label := "HEAD → working tree"
	var compare []string
	includeUntracked := mode != "staged"
	if mode == "branch" {
		if head != "" || base != "HEAD" {
			resolvedBase, err := revision(ctx, opt.repo, base)
			if err != nil {
				return nil, fmt.Errorf("invalid base %q: %w", base, err)
			}
			resolvedHead := head
			if opt.head != "" {
				resolvedHead, err = revision(ctx, opt.repo, opt.head)
				if err != nil {
					return nil, fmt.Errorf("invalid head %q: %w", opt.head, err)
				}
			}
			if resolvedHead == "" {
				old = resolvedBase
			} else {
				out, err := git(ctx, opt.repo, "merge-base", resolvedBase, resolvedHead)
				if err != nil {
					return nil, err
				}
				old = strings.TrimSpace(string(out))
			}
			if opt.head != "" {
				compare = append(compare, old, resolvedHead)
				includeUntracked = false
				label = base + " … " + opt.head
			}
		}
		if opt.head == "" {
			compare = append(compare, old)
			label = base + " … " + branch + " + local changes"
		}
	} else {
		if mode == "staged" {
			compare = append(compare, "--cached")
			label = "HEAD → index"
		}
		compare = append(compare, old)
	}
	common := []string{"--no-ext-diff", "--no-textconv", "--no-color", "--find-renames"}
	nameArgs := append([]string{"diff", "--name-status", "-z"}, common...)
	nameArgs = append(nameArgs, compare...)
	nameArgs = append(nameArgs, "--")
	out, err := git(ctx, opt.repo, nameArgs...)
	if err != nil {
		return nil, err
	}
	files, err := parseNames(string(out))
	if err != nil {
		return nil, err
	}
	if len(files) > 0 {
		patchArgs := append([]string{"diff", "--patch", "--unified=3"}, common...)
		patchArgs = append(patchArgs, compare...)
		patchArgs = append(patchArgs, "--")
		out, err := git(ctx, opt.repo, patchArgs...)
		if err != nil {
			return nil, err
		}
		patch, ok := strings.CutPrefix(string(out), "diff --git ")
		if !ok {
			return nil, errors.New("Git returned no patch headers")
		}
		i := 0
		for section := range strings.SplitSeq(patch, "\ndiff --git ") {
			if i >= len(files) {
				return nil, errors.New("diff changed while reading; refresh to load the current files")
			}
			parsePatch(section, &files[i])
			i++
		}
		if i != len(files) {
			return nil, errors.New("diff changed while reading; refresh to load the current files")
		}
	}
	if includeUntracked {
		out, err := git(ctx, opt.repo, "ls-files", "--others", "--exclude-standard", "-z")
		if err != nil {
			return nil, err
		}
		for path := range strings.SplitSeq(string(out), "\x00") {
			if path == "" {
				continue
			}
			file, err := untrackedFile(opt.repo, path)
			if err != nil {
				return nil, err
			}
			files = append(files, file)
		}
	}
	result := &diffResult{Repo: opt.repo, Branch: branch, Base: base, DefaultBase: opt.base, Mode: mode, Label: label, OldRevision: old, Files: files}
	for i := range result.Files {
		result.Files[i].ID = strconv.Itoa(i)
		result.Additions += result.Files[i].Additions
		result.Deletions += result.Files[i].Deletions
	}
	return result, nil
}

func parseNames(data string) ([]changedFile, error) {
	files := make([]changedFile, 0)
	next, stop := iter.Pull(strings.SplitSeq(data, "\x00"))
	defer stop()
	for {
		status, ok := next()
		if !ok || status == "" {
			break
		}
		path, ok := next()
		if !ok {
			return nil, errors.New("incomplete Git file status")
		}
		file := changedFile{Path: path, OldPath: path, Status: status[:1], Hunks: make([]hunk, 0)}
		if file.Status == "R" || file.Status == "C" {
			file.Path, ok = next()
			if !ok {
				return nil, errors.New("incomplete Git rename")
			}
		}
		files = append(files, file)
	}
	return files, nil
}

func parsePatch(patch string, file *changedFile) {
	var current *hunk
	old, new := 0, 0
	for raw := range strings.Lines(patch) {
		line := strings.TrimSuffix(raw, "\n")
		if strings.HasPrefix(line, "@@ ") {
			ranges, _, _ := strings.Cut(line[3:], " @@")
			oldRange, newRange, ok := strings.Cut(ranges, " ")
			if !ok || len(oldRange) < 2 || len(newRange) < 2 {
				continue
			}
			oldStart, _, _ := strings.Cut(oldRange[1:], ",")
			newStart, _, _ := strings.Cut(newRange[1:], ",")
			old, _ = strconv.Atoi(oldStart)
			new, _ = strconv.Atoi(newStart)
			file.Hunks = append(file.Hunks, hunk{Header: line, OldStart: old, NewStart: new, Lines: make([]diffLine, 0)})
			current = &file.Hunks[len(file.Hunks)-1]
			continue
		}
		if current == nil {
			if strings.HasPrefix(line, "Binary files ") || line == "GIT binary patch" {
				file.Binary = true
				file.Message = "Binary file changed"
			} else if strings.HasPrefix(line, "old mode ") || strings.HasPrefix(line, "new mode ") || strings.HasPrefix(line, "similarity index ") {
				if file.Message != "" {
					file.Message += " · "
				}
				file.Message += line
			}
			continue
		}
		if line == "" {
			continue
		}
		entry := diffLine{Text: line[1:]}
		switch line[0] {
		case ' ':
			entry.Type, entry.OldLine, entry.NewLine = "context", old, new
			old++
			new++
		case '-':
			entry.Type, entry.OldLine = "deletion", old
			old++
			file.Deletions++
		case '+':
			entry.Type, entry.NewLine = "addition", new
			new++
			file.Additions++
		case '\\':
			entry.Type, entry.Text = "meta", line
		default:
			continue
		}
		current.Lines = append(current.Lines, entry)
	}
}

func untrackedFile(repo, path string) (changedFile, error) {
	file := changedFile{Path: path, OldPath: path, Status: "?", Hunks: make([]hunk, 0)}
	full := filepath.Join(repo, path)
	info, err := os.Lstat(full)
	if err != nil {
		return file, err
	}
	var content []byte
	if info.Mode()&os.ModeSymlink != 0 {
		target, err := os.Readlink(full)
		if err != nil {
			return file, err
		}
		content = []byte(target)
	} else if info.Mode().IsRegular() {
		content, err = os.ReadFile(full)
		if err != nil {
			return file, err
		}
	} else {
		file.Message = "Untracked special file"
		return file, nil
	}
	if bytes.IndexByte(content, 0) >= 0 {
		file.Binary, file.Message = true, "Untracked binary file"
		return file, nil
	}
	if len(content) == 0 {
		file.Message = "Empty new file"
		return file, nil
	}
	h := hunk{OldStart: 0, NewStart: 1, Lines: make([]diffLine, 0)}
	lineNo := 1
	for line := range strings.Lines(string(content)) {
		h.Lines = append(h.Lines, diffLine{Type: "addition", NewLine: lineNo, Text: strings.TrimSuffix(line, "\n")})
		lineNo++
	}
	file.Additions = len(h.Lines)
	h.Header = fmt.Sprintf("@@ -0,0 +1,%d @@", file.Additions)
	if content[len(content)-1] != '\n' {
		h.Lines = append(h.Lines, diffLine{Type: "meta", Text: "\\ No newline at end of file"})
	}
	file.Hunks = append(file.Hunks, h)
	return file, nil
}

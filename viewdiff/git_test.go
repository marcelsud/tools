package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func command(t *testing.T, repo string, args ...string) string {
	t.Helper()
	out, err := git(context.Background(), repo, args...)
	if err != nil {
		t.Fatal(err)
	}
	return string(out)
}

func repository(t *testing.T) string {
	t.Helper()
	repo := t.TempDir()
	command(t, repo, "init", "--quiet", "--initial-branch=main")
	command(t, repo, "config", "user.name", "Diff Fixture")
	command(t, repo, "config", "user.email", "fixture@example.invalid")
	command(t, repo, "config", "commit.gpgsign", "false")
	command(t, repo, "config", "core.hooksPath", t.TempDir())
	return repo
}

func put(t *testing.T, repo, path, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(repo, path), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func find(t *testing.T, diff *diffResult, path string) changedFile {
	t.Helper()
	for _, file := range diff.Files {
		if file.Path == path {
			return file
		}
	}
	t.Fatalf("missing file %q", path)
	return changedFile{}
}

func additions(file changedFile) string {
	var text strings.Builder
	for _, hunk := range file.Hunks {
		for _, line := range hunk.Lines {
			if line.Type == "addition" {
				text.WriteString(line.Text)
				text.WriteByte('\n')
			}
		}
	}
	return text.String()
}

func TestComparisonModesPreserveRenamesAndUnusualPaths(t *testing.T) {
	repo := repository(t)
	put(t, repo, "code.txt", "base\n")
	put(t, repo, "old name.txt", "unchanged\n")
	command(t, repo, "add", ".")
	command(t, repo, "commit", "--quiet", "-m", "base")
	command(t, repo, "switch", "--quiet", "-c", "feature")
	put(t, repo, "code.txt", "base\ncommitted diff --git literal\n")
	command(t, repo, "add", "code.txt")
	command(t, repo, "commit", "--quiet", "-m", "feature")
	put(t, repo, "code.txt", "base\ncommitted diff --git literal\nstaged\n")
	command(t, repo, "add", "code.txt")
	put(t, repo, "code.txt", "base\ncommitted diff --git literal\nstaged\nunstaged\n")
	rename := "renamed \"日本\".txt"
	command(t, repo, "mv", "old name.txt", rename)
	untracked := "new\t\"日本\"\nfile.txt"
	put(t, repo, untracked, "<script>not markup</script>")
	put(t, repo, "binary.bin", "before\x00after")
	opt := options{repo: repo, base: "main"}
	branch, err := loadDiff(context.Background(), opt, "branch", "main")
	if err != nil {
		t.Fatal(err)
	}
	if got := additions(find(t, branch, "code.txt")); got != "committed diff --git literal\nstaged\nunstaged\n" {
		t.Fatalf("branch changes: %q", got)
	}
	renamed := find(t, branch, rename)
	if renamed.Status != "R" || renamed.OldPath != "old name.txt" || len(renamed.Hunks) != 0 {
		t.Fatalf("rename: %+v", renamed)
	}
	newFile := find(t, branch, untracked)
	if additions(newFile) != "<script>not markup</script>\n" || newFile.Hunks[0].Lines[1].Type != "meta" {
		t.Fatalf("untracked file or EOF marker lost: %+v", newFile)
	}
	if !find(t, branch, "binary.bin").Binary {
		t.Fatal("binary data interpreted as text")
	}
	working, err := loadDiff(context.Background(), opt, "working", "main")
	if err != nil {
		t.Fatal(err)
	}
	if got := additions(find(t, working, "code.txt")); got != "staged\nunstaged\n" {
		t.Fatalf("working changes: %q", got)
	}
	staged, err := loadDiff(context.Background(), opt, "staged", "main")
	if err != nil {
		t.Fatal(err)
	}
	if got := additions(find(t, staged, "code.txt")); got != "staged\n" {
		t.Fatalf("index changes: %q", got)
	}
	for _, file := range staged.Files {
		if file.Status == "?" {
			t.Fatal("staged view included untracked files")
		}
	}
	opt.head = "HEAD"
	committed, err := loadDiff(context.Background(), opt, "branch", "main")
	if err != nil {
		t.Fatal(err)
	}
	if got := additions(find(t, committed, "code.txt")); got != "committed diff --git literal\n" {
		t.Fatalf("commit-only comparison included local edits: %q", got)
	}
	if len(committed.Files) != 1 {
		t.Fatal("commit-only comparison included local files")
	}
}

func TestUnbornRepositoryAndUntrackedSymlink(t *testing.T) {
	repo := repository(t)
	outside := filepath.Join(t.TempDir(), "outside.txt")
	if err := os.WriteFile(outside, []byte("must not follow this target"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(repo, "link")); err != nil {
		t.Fatal(err)
	}
	put(t, repo, "empty.txt", "")
	put(t, repo, "new.txt", "new file\n")
	diff, err := loadDiff(context.Background(), options{repo: repo, base: "HEAD"}, "working", "HEAD")
	if err != nil {
		t.Fatal(err)
	}
	if got := additions(find(t, diff, "link")); got != outside+"\n" {
		t.Fatalf("symlink target was followed: %q", got)
	}
	if find(t, diff, "empty.txt").Message != "Empty new file" {
		t.Fatal("empty addition was lost")
	}
	if find(t, diff, "new.txt").Hunks[0].Lines[0].NewLine != 1 {
		t.Fatal("new file line number is not one-based")
	}
}

func TestHunkLineNumbersAndMissingFinalNewline(t *testing.T) {
	file := changedFile{}
	parsePatch("@@ -12,3 +12,3 @@ name\n same\n-old\n\\ No newline at end of file\n+new\n end\n", &file)
	lines := file.Hunks[0].Lines
	if lines[0].OldLine != 12 || lines[0].NewLine != 12 || lines[1].OldLine != 13 || lines[2].Type != "meta" || lines[3].NewLine != 13 || lines[4].OldLine != 14 || lines[4].NewLine != 14 {
		t.Fatalf("incorrect numbering across EOF metadata: %+v", lines)
	}
	if file.Additions != 1 || file.Deletions != 1 {
		t.Fatalf("metadata affected change counts: +%d -%d", file.Additions, file.Deletions)
	}
}

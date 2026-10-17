package main

import (
	"io"
	"strings"
	"testing"
)

func TestCommentSelectors(t *testing.T) {
	for _, tc := range []struct {
		value, path, side, text string
		start, end              int
	}{
		{"[123:456] yada yada", "", "new", "yada yada", 123, 456},
		{"[456:456] single line", "", "new", "single line", 456, 456},
		{"[./src/my file.go:12:24] <script>literal</script>\nsecond line", "src/my file.go", "new", "<script>literal</script>\nsecond line", 12, 24},
		{"[src/app.go:old:1:2] removed", "src/app.go", "old", "removed", 1, 2},
		{"[old:1:2] removed", "", "old", "removed", 1, 2},
		{"[name:with:colons.go:new:3:4] note", "name:with:colons.go", "new", "note", 3, 4},
	} {
		t.Run(tc.value, func(t *testing.T) {
			got, err := parseComment(tc.value)
			if err != nil {
				t.Fatal(err)
			}
			if got.Path != tc.path || got.Side != tc.side || got.Start != tc.start || got.End != tc.end || got.Text != tc.text {
				t.Fatalf("unexpected comment: %+v", got)
			}
		})
	}
	for _, value := range []string{"note", "[1] note", "[0:1] note", "[3:2] note", "[-1:2] note", "[1:x] note", "[1:2]", "[1:2 note", "[/abs.go:1:2] note", "[../outside.go:1:2] note", "[:1:2] note"} {
		if _, err := parseComment(value); err == nil {
			t.Errorf("accepted invalid comment %q", value)
		}
	}
}

func TestArbitraryCommentLabels(t *testing.T) {
	for _, tc := range []struct {
		value, label, path, side string
	}{
		{"[Notes;123:456] something something", "Notes", "", "new"},
		{"[Why this changed;src/app.go:123:456] something something", "Why this changed", "src/app.go", "new"},
		{"[Context: API;src/app.go:old:123:456] something something", "Context: API", "src/app.go", "old"},
		{"[説明 ✓;old:123:456] something something", "説明 ✓", "", "old"},
		{"[<b>label</b>;123:456] something something", "<b>label</b>", "", "new"},
	} {
		got, err := parseComment(tc.value)
		if err != nil || got.Label != tc.label || got.Path != tc.path || got.Side != tc.side || got.Start != 123 || got.End != 456 || got.Text != "something something" {
			t.Fatalf("label or range lost for %q: %+v, %v", tc.value, got, err)
		}
	}
	for _, value := range []string{"[;1:2] text", "[ ;1:2] text", "[Notes;] text", "[Notes;0:2] text", "[Notes;2:1] text", "[Notes;1:2]"} {
		if _, err := parseComment(value); err == nil {
			t.Errorf("accepted invalid labeled comment %q", value)
		}
	}
	opt, err := parseOptions([]string{"main", "HEAD", "-c", "[Notes;123:456] something something", "-c", "[Context;456:457] another explanation"}, io.Discard)
	if err != nil || len(opt.comments) != 2 || opt.comments[0].Label != "Notes" || opt.comments[1].Label != "Context" {
		t.Fatalf("repeatable labeled comments lost: %+v, %v", opt.comments, err)
	}
}

func TestFlagsAfterComparisonReferences(t *testing.T) {
	opt, err := parseOptions([]string{"main", "HEAD", "-c", "[123:456] yada yada", "--repo", "/repo with spaces", "-c=[456:457] something something", "--no-open"}, io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	if opt.base != "main" || opt.head != "HEAD" || opt.repo != "/repo with spaces" || !opt.noOpen || len(opt.comments) != 2 {
		t.Fatalf("options after references lost: %+v", opt)
	}
	opt, err = parseOptions([]string{"-c", "[1:2] --not-an-option", "--working"}, io.Discard)
	if err != nil || opt.mode != "working" || opt.comments[0].Text != "--not-an-option" {
		t.Fatalf("comment text confused with an option: %+v, %v", opt, err)
	}
	opt, err = parseOptions([]string{"--", "-base", "-head"}, io.Discard)
	if err != nil || opt.base != "-base" || opt.head != "-head" {
		t.Fatalf("argument terminator ignored: %+v, %v", opt, err)
	}
	for _, args := range [][]string{{"main", "HEAD", "-c"}, {"--working", "--staged"}, {"main", "--base", "other"}, {"main", "HEAD", "third"}, {"--unknown"}, {"-c", "[2:1] note"}, {"main", "--working"}} {
		if _, err := parseOptions(args, io.Discard); err == nil {
			t.Errorf("accepted invalid options %v", args)
		}
	}
}

func TestResolveCommentsAndRefresh(t *testing.T) {
	repo := repository(t)
	put(t, repo, "a.txt", "base\n")
	put(t, repo, "b.txt", "base\n")
	command(t, repo, "add", ".")
	command(t, repo, "commit", "--quiet", "-m", "base")
	put(t, repo, "a.txt", "new\n")
	put(t, repo, "b.txt", "new\n")
	opt := options{repo: repo, base: "HEAD"}
	diff, err := loadDiff(t.Context(), opt, "working", "HEAD")
	if err != nil {
		t.Fatal(err)
	}
	bare, _ := parseComment("[1:1] note")
	if _, err := resolveComments(diff, []reviewComment{bare}); err == nil || !strings.Contains(err.Error(), "matches 2 files") {
		t.Fatalf("ambiguous range was not rejected: %v", err)
	}
	qualified, _ := parseComment("[Context: API;a.txt:1:1] <b>local note</b>")
	resolved, err := resolveComments(diff, []reviewComment{qualified})
	if err != nil {
		t.Fatal(err)
	}
	refresh, _ := loadDiff(t.Context(), opt, "working", "HEAD")
	attachComments(refresh, resolved)
	if got := find(t, refresh, "a.txt").Comments; len(got) != 1 || got[0].Stale || got[0].Text != "<b>local note</b>" || got[0].Label != "Context: API" {
		t.Fatalf("note lost or marked stale on unchanged refresh: %+v", got)
	}
	if len(find(t, refresh, "b.txt").Comments) != 0 {
		t.Fatal("note attached to an unrelated file")
	}
	put(t, repo, "a.txt", "changed again\n")
	refresh, _ = loadDiff(t.Context(), opt, "working", "HEAD")
	attachComments(refresh, resolved)
	if !find(t, refresh, "a.txt").Comments[0].Stale {
		t.Fatal("changed diff still presented an anchored note")
	}
	content, _ := git(t.Context(), repo, "diff", "--", "a.txt")
	if strings.Contains(string(content), "local note") {
		t.Fatal("review note was written to source")
	}
}

func TestSingleFileOldLinesAndRenameTargets(t *testing.T) {
	file := changedFile{Path: "new.txt", OldPath: "old.txt", Status: "R"}
	parsePatch("@@ -10,2 +1,1 @@\n-removed\n-removed too\n+new\n", &file)
	diff := &diffResult{OldRevision: "base", Files: []changedFile{file}}
	comment, _ := parseComment("[old.txt:old:10:11] removed section")
	resolved, err := resolveComments(diff, []reviewComment{comment})
	if err != nil || resolved[0].Path != "new.txt" || !matchesComment(resolved[0], file) {
		t.Fatalf("old-side rename target failed: %+v, %v", resolved, err)
	}
	comment, _ = parseComment("[123:456] hidden context")
	if _, err := resolveComments(diff, []reviewComment{comment}); err != nil {
		t.Fatal("single-file note outside visible context rejected:", err)
	}
	diff.Files[0].Binary = true
	if _, err := resolveComments(diff, []reviewComment{comment}); err == nil {
		t.Fatal("accepted a source line note on a binary file")
	}
}

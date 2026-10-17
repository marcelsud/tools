package main

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strconv"
	"strings"
)

type reviewComment struct {
	Label    string `json:"label"`
	Path     string `json:"path"`
	Side     string `json:"side"`
	Start    int    `json:"start"`
	End      int    `json:"end"`
	Text     string `json:"text"`
	Stale    bool   `json:"stale,omitempty"`
	snapshot string
}

type commentFlags []reviewComment

func (comments *commentFlags) String() string { return "" }

func (comments *commentFlags) Set(value string) error {
	comment, err := parseComment(value)
	if err != nil {
		return err
	}
	*comments = append(*comments, comment)
	return nil
}

func parseComment(value string) (reviewComment, error) {
	var comment reviewComment
	value = strings.TrimSpace(value)
	if !strings.HasPrefix(value, "[") {
		return comment, fmt.Errorf("use [label;start:end] text or [label;file:start:end] text")
	}
	selector, text, ok := strings.Cut(value[1:], "]")
	if !ok || strings.TrimSpace(text) == "" {
		return comment, fmt.Errorf("a comment needs a closing ] and nonempty text")
	}
	label := "Review note"
	if title, rangeSelector, labeled := strings.Cut(selector, ";"); labeled {
		label = strings.TrimSpace(title)
		if label == "" {
			return comment, fmt.Errorf("a comment label must not be empty")
		}
		selector = strings.TrimSpace(rangeSelector)
	}
	parts := strings.Split(selector, ":")
	if len(parts) < 2 {
		return comment, fmt.Errorf("a comment needs a start:end line range")
	}
	start, errStart := strconv.Atoi(parts[len(parts)-2])
	end, errEnd := strconv.Atoi(parts[len(parts)-1])
	if errStart != nil || errEnd != nil || start < 1 || end < start {
		return comment, fmt.Errorf("line ranges must be positive integers with start <= end")
	}
	comment = reviewComment{Label: label, Side: "new", Start: start, End: end, Text: strings.TrimSpace(text)}
	prefix := parts[:len(parts)-2]
	if len(prefix) > 0 && (prefix[len(prefix)-1] == "old" || prefix[len(prefix)-1] == "new") {
		comment.Side = prefix[len(prefix)-1]
		prefix = prefix[:len(prefix)-1]
	}
	if len(prefix) > 0 {
		path := strings.Join(prefix, ":")
		if path == "" || filepath.IsAbs(path) {
			return reviewComment{}, fmt.Errorf("comment file paths must be relative to the repository")
		}
		comment.Path = filepath.ToSlash(filepath.Clean(path))
		if comment.Path == ".." || strings.HasPrefix(comment.Path, "../") {
			return reviewComment{}, fmt.Errorf("comment file paths must stay inside the repository")
		}
	}
	return comment, nil
}

func commentSnapshot(diff *diffResult, file changedFile) string {
	content, _ := json.Marshal(struct {
		Revision string
		Path     string
		OldPath  string
		Status   string
		Hunks    []hunk
	}{diff.OldRevision, file.Path, file.OldPath, file.Status, file.Hunks})
	return fmt.Sprintf("%x", sha256.Sum256(content))
}

func matchesComment(comment reviewComment, file changedFile) bool {
	for _, hunk := range file.Hunks {
		for _, line := range hunk.Lines {
			number := line.NewLine
			if comment.Side == "old" {
				number = line.OldLine
			}
			if number >= comment.Start && number <= comment.End {
				return true
			}
		}
	}
	return false
}

func resolveComments(diff *diffResult, comments []reviewComment) ([]reviewComment, error) {
	resolved := make([]reviewComment, 0, len(comments))
	for _, comment := range comments {
		var candidates []changedFile
		for _, file := range diff.Files {
			if comment.Path != "" {
				if file.Path == comment.Path || file.OldPath == comment.Path {
					candidates = append(candidates, file)
				}
			} else if len(diff.Files) == 1 || matchesComment(comment, file) {
				candidates = append(candidates, file)
			}
		}
		if len(candidates) != 1 {
			selector := fmt.Sprintf("%d:%d", comment.Start, comment.End)
			if comment.Side == "old" {
				selector = "old:" + selector
			}
			if comment.Path != "" {
				selector = comment.Path + ":" + selector
			}
			return nil, fmt.Errorf("comment [%s;%s] matches %d files; use [%s;file:%s:%d:%d] text with a changed file path", comment.Label, selector, len(candidates), comment.Label, comment.Side, comment.Start, comment.End)
		}
		file := candidates[0]
		if file.Binary {
			return nil, fmt.Errorf("cannot annotate source lines in binary file %q", file.Path)
		}
		comment.Path = file.Path
		comment.snapshot = commentSnapshot(diff, file)
		resolved = append(resolved, comment)
	}
	return resolved, nil
}

func attachComments(diff *diffResult, comments []reviewComment) {
	for i := range diff.Files {
		file := &diff.Files[i]
		for _, comment := range comments {
			if comment.Path != file.Path {
				continue
			}
			comment.Stale = comment.snapshot != commentSnapshot(diff, *file)
			file.Comments = append(file.Comments, comment)
		}
	}
}

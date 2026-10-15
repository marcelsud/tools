# viewdiff

A local, read-only Git diff viewer. Run `make install` to install it in
`~/.local/bin`, or `make build` to build `bin/viewdiff`.

Requires Go 1.24 or newer and Git, with `~/.local/bin` on your PATH after install.
The default launch opens Island on macOS. Use `--no-open` and open the printed
URL manually to use another browser or operating system.

## Usage

Run from the repository you want to review, or pass `--repo /path/to/repo`:

```sh
viewdiff                         # branch changes plus local edits
viewdiff origin/main HEAD        # committed changes from the merge base
viewdiff --working               # staged, unstaged, and untracked changes
viewdiff --staged                # staged changes only
viewdiff --no-open               # print the URL without opening Island
```

The viewer offers split and unified layouts, expandable context, syntax coloring,
file filters, and viewed markers. Theme, layout, wrap, and sidebar preferences
persist across launches. The server binds to `127.0.0.1`; Ctrl-C stops it.

## Review notes

Supply repeatable `-c` arguments before or after the comparison references:

```sh
viewdiff main HEAD \
  -c "[Notes;123:456] Explain why this section changed" \
  -c "[Boundary case;456:457] Explain this boundary case"
```

The text before `;` is the callout label. Use any nonempty label, including spaces,
punctuation, or Unicode, such as `Notes`, `Why this changed`, or `Context: API`.
The `;` and closing `]` delimit the selector. The original unlabeled range syntax
is also accepted and uses the label `Review note`.

Ranges are inclusive source line numbers, using the new version of a file by
default. Notes appear as expandable callouts near the first visible matching
line. Annotated lines show the note on hover. They work in split and unified
layouts and when you expand hidden context.

For multiple files, qualify the path relative to the repository root:

```sh
viewdiff main HEAD \
  -c "[Notes;src/app.go:123:456] Explain this section" \
  -c "[Removal;src/app.go:old:456:457] Explain these removed lines"
```

An unqualified range is accepted when there is one changed file or exactly one
file has visible lines in that range. Ambiguous ranges report an error rather
than attaching a note to an unrelated file. Use `old` to target base-file lines,
including deleted files. A qualified note outside the visible diff is shown at
the top of the file; expand context to find the section.

Notes belong to the current viewer launch. Refresh preserves them and marks a
note stale when its file's diff changes. Notes are never written into source
files or posted to a code hosting service.

## Checks

Requires Node.js as well as Go and Git:

```sh
make check
```

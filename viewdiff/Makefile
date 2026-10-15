BIN := bin/viewdiff
GOBIN ?= $(HOME)/.local/bin

.PHONY: build install check

build:
	go build -o $(BIN) .

install:
	GOBIN=$(GOBIN) go install .

check:
	go vet ./...
	go test -race ./...
	node --test *_test.js

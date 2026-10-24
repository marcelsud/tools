.PHONY: build check install

build:
	go build -trimpath -o bin/mdview .

check:
	go vet ./...
	go test -race ./...
	node --test diagrams_test.cjs editor_test.cjs

install: build
	mkdir -p $(HOME)/.local/bin
	install -m 755 bin/mdview $(HOME)/.local/bin/mdview

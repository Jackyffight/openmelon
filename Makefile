CARGO ?= cargo
NPM ?= npm
PREFIX ?= $(HOME)/.local
BINDIR ?= $(PREFIX)/bin

.PHONY: build test rust-build rust-test rust-install tui-install tui-dev tui-check clean help

build:
	go build -o openmelon ./cmd/openmelon/

test:
	go test ./...

rust-build:
	$(CARGO) build --manifest-path rust/Cargo.toml

rust-test:
	$(CARGO) test --manifest-path rust/Cargo.toml

rust-install: rust-build
	mkdir -p "$(BINDIR)"
	cp rust/target/debug/openmelon-tui "$(BINDIR)/openmelon-rust"
	@echo "installed $(BINDIR)/openmelon-rust"

tui-check:
	cd tui && $(NPM) install && $(NPM) run check && $(NPM) run build

tui-dev:
	cd tui && $(NPM) install && $(NPM) run dev

tui-install:
	cd tui && $(NPM) install && $(NPM) run build
	mkdir -p "$(BINDIR)"
	printf '#!/usr/bin/env sh\nexec node "%s/tui/bin/openmelon.js" "$$@"\n' "$(CURDIR)" > "$(BINDIR)/openmelon"
	chmod +x "$(BINDIR)/openmelon"
	@echo "installed TS TUI $(BINDIR)/openmelon"

clean:
	rm -f openmelon

help:
	@echo "Available targets:"
	@echo "  build   - Build the OpenMelon CLI"
	@echo "  test    - Run all tests"
	@echo "  rust-build - Build the Rust TUI prototype"
	@echo "  rust-test  - Test the Rust TUI prototype"
	@echo "  rust-install - Install Rust TUI as $(BINDIR)/openmelon-rust"
	@echo "  tui-check - Install/check/build the TS-first TUI"
	@echo "  tui-dev - Run the TS-first TUI in development mode"
	@echo "  tui-install - Install the TS-first TUI as $(BINDIR)/openmelon"
	@echo "  clean   - Remove build artifacts"

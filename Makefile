NPM ?= npm
PREFIX ?= $(HOME)/.local
BINDIR ?= $(PREFIX)/bin

.PHONY: build test tui-install tui-dev tui-check clean help

build:
	cd tui && $(NPM) install && $(NPM) run build

test:
	cd tui && $(NPM) install && $(NPM) run test

tui-check:
	cd tui && $(NPM) install && $(NPM) run check && $(NPM) run test

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
	rm -rf tui/dist

help:
	@echo "Available targets:"
	@echo "  build   - Build the TS OpenMelon CLI"
	@echo "  test    - Run TS tests"
	@echo "  tui-check - Install/check/build/test the TS-first TUI"
	@echo "  tui-dev - Run the TS-first TUI in development mode"
	@echo "  tui-install - Install the TS-first TUI as $(BINDIR)/openmelon"
	@echo "  clean   - Remove build artifacts"

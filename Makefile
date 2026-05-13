CARGO ?= cargo
PREFIX ?= $(HOME)/.local
BINDIR ?= $(PREFIX)/bin

.PHONY: build test rust-build rust-test rust-install clean help

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

clean:
	rm -f openmelon

help:
	@echo "Available targets:"
	@echo "  build   - Build the OpenMelon CLI"
	@echo "  test    - Run all tests"
	@echo "  rust-build - Build the Rust TUI prototype"
	@echo "  rust-test  - Test the Rust TUI prototype"
	@echo "  rust-install - Install Rust TUI as $(BINDIR)/openmelon-rust"
	@echo "  clean   - Remove build artifacts"

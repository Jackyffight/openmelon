CARGO ?= cargo

.PHONY: build test rust-build rust-test clean help

build:
	go build -o openmelon ./cmd/openmelon/

test:
	go test ./...

rust-build:
	$(CARGO) build --manifest-path rust/Cargo.toml

rust-test:
	$(CARGO) test --manifest-path rust/Cargo.toml

clean:
	rm -f openmelon

help:
	@echo "Available targets:"
	@echo "  build   - Build the OpenMelon CLI"
	@echo "  test    - Run all tests"
	@echo "  rust-build - Build the Rust TUI prototype"
	@echo "  rust-test  - Test the Rust TUI prototype"
	@echo "  clean   - Remove build artifacts"

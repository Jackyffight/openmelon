NPM ?= npm
TUI ?= tui

.PHONY: build check dev start install clean help

# openmelon is a pure-TypeScript project; everything lives in tui/.

build:
	cd $(TUI) && $(NPM) install --ignore-scripts && $(NPM) run build

check:
	cd $(TUI) && $(NPM) install --ignore-scripts && $(NPM) run check

dev:
	cd $(TUI) && $(NPM) install --ignore-scripts && $(NPM) run dev

start: build
	cd $(TUI) && $(NPM) start

install: build
	cd $(TUI) && $(NPM) link

clean:
	rm -rf $(TUI)/dist

help:
	@echo "build   - install deps + compile TS to tui/dist"
	@echo "check   - typecheck (tsc --noEmit)"
	@echo "dev     - run the TUI from source (tsx)"
	@echo "start   - build then run the compiled CLI"
	@echo "install - build then npm link the openmelon bin"
	@echo "clean   - remove tui/dist"

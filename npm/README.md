# @e8s/openmelon

A content-creation agent for the terminal. The product TUI is moving to a
TS/Ink interface; the release package currently keeps the existing native
runtime wrapper while that bridge is completed.

```bash
npm install -g @e8s/openmelon @e8s/skillplus
cd path/to/your-project
openmelon
```

This package is a Node shim that downloads the matching [openmelon](https://github.com/eight-acres-lab/openmelon) binary from GitHub Releases at install time, verified against `SHASUMS256.txt`. Platforms: `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`.

See [the main README](https://github.com/eight-acres-lab/openmelon#readme) for the full reference.

## Override the binary

```bash
# Skip the download (provide your own binary out-of-band)
OPENMELON_SKIP_DOWNLOAD=1 npm install -g @e8s/openmelon

# Point at a local build
export OPENMELON_BIN=/path/to/your/openmelon
openmelon
```

## License

[Apache 2.0](https://github.com/eight-acres-lab/openmelon/blob/main/LICENSE).

#!/usr/bin/env bash
# Release a new openmelon version (pure-TypeScript npm package in tui/).
#
#   ./scripts/release.sh v0.4.0            # tag + build + npm publish
#   ./scripts/release.sh v0.4.0 --dry-run
#
# Refuses to run with an unclean working tree. Builds tui/ and publishes
# @e8s/openmelon to npm (prepublishOnly compiles dist/). No native binaries
# are produced — openmelon is plain Node now.

set -euo pipefail

VERSION="${1:-}"
DRY_RUN=""
[ "${2:-}" = "--dry-run" ] && DRY_RUN="1"

if [ -z "$VERSION" ]; then
  echo "usage: $0 vX.Y.Z [--dry-run]" >&2
  exit 2
fi
case "$VERSION" in
  v*) ;;
  *) echo "version must start with 'v' (e.g. v0.4.0)" >&2; exit 2 ;;
esac

if [ -n "$(git status --porcelain)" ]; then
  echo "working tree is not clean; commit or stash first" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/tui"

# Sync package.json version to the tag (strip leading v).
npm version "${VERSION#v}" --no-git-tag-version

npm install --ignore-scripts
npm run check
npm run build

if [ -n "$DRY_RUN" ]; then
  echo "[dry-run] would: npm publish --access public; git tag $VERSION"
  npm pack --dry-run
  exit 0
fi

npm publish --access public
cd "$ROOT"
git add tui/package.json
git commit -m "chore: release $VERSION"
git tag "$VERSION"
echo "Published @e8s/openmelon $VERSION. Push with: git push && git push --tags"

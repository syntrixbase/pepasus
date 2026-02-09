#!/usr/bin/env bash
# Point git's hooks directory to the project's git-hooks/ folder.
# Usage: bash scripts/install-hooks.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

git -C "$REPO_ROOT" config core.hooksPath "$REPO_ROOT/git-hooks"

echo "✅ Git hooks installed → $REPO_ROOT/git-hooks"

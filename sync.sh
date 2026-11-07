#!/usr/bin/env bash
# Sync an allowlisted subset of ~/.pi/agent to this repo and back.
#
#   ./sync.sh push   copy ~/.pi/agent (allowlisted files) -> this repo
#   ./sync.sh pull   copy this repo -> ~/.pi/agent (allowlisted files)
#
# Only the files in FILES are ever copied. Everything else in ~/.pi/agent
# (auth, sessions, caches, installed packages) stays out of git.

set -euo pipefail

AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
REPO_DIR="$(cd "$(dirname "$0")" && pwd)"

FILES=(
  "settings.json"
  "budget.json"
  "pi-pretty.json"
  "themes/kanagawa-wave.json"
  "extensions/budget/index.ts"
  "extensions/powerline-footer/theme.json"
  "vibes/pirate.txt"
)

# Refuse to push anything that looks like a credential.
check_secrets() {
  local hits
  hits=$(grep -n -i -E '"(apiKey|api_key|token|secret|password|authorization)"[[:space:]]*:[[:space:]]*"[^"]+"|(^|[^A-Za-z0-9])(sk-|gho_|ghp_)[A-Za-z0-9_-]{20,}' "$@" 2>/dev/null || true)
  if [[ -n "$hits" ]]; then
    echo "Refusing to continue: possible secret found:" >&2
    echo "$hits" | sed 's/\(:[[:space:]]*"\)[^"]*"/\1<redacted>"/' >&2
    exit 1
  fi
}

copy() {
  local src_root="$1" dst_root="$2"
  for rel in "${FILES[@]}"; do
    if [[ -f "$src_root/$rel" ]]; then
      mkdir -p "$dst_root/$(dirname "$rel")"
      cp "$src_root/$rel" "$dst_root/$rel"
      echo "  $rel"
    else
      echo "  $rel (missing, skipped)"
    fi
  done
}

case "${1:-}" in
  push)
    echo "Pushing from $AGENT_DIR:"
    copy "$AGENT_DIR" "$REPO_DIR"
    (cd "$REPO_DIR" && check_secrets "${FILES[@]}")
    ;;
  pull)
    echo "Pulling into $AGENT_DIR:"
    copy "$REPO_DIR" "$AGENT_DIR"
    ;;
  *)
    echo "usage: $0 push|pull" >&2
    exit 2
    ;;
esac

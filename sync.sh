#!/usr/bin/env bash
# Sync an allowlisted subset of ~/.pi/agent with this repo, using layered config.
#
#   ./sync.sh pull   build ~/.pi/agent from the repo base plus overlays
#   ./sync.sh push   copy allowlisted files from ~/.pi/agent back to the repo or overlays
#
# Layers, later wins:
#   1. repo base: this directory (committed, generic), e.g. mcp.json
#   2. sibling override: <name>.local.json next to a merged base file, e.g. mcp.local.json
#   3. overlays: PI_CONFIG_OVERLAYS, a colon-separated list of directories.
#      Default: ./.local (gitignored). Example for a work machine:
#        PI_CONFIG_OVERLAYS="$HOME/Development/pi-config/.local:$HOME/work/pi-overlay" ./sync.sh pull
#
# Sibling *.local.json files and .local/ are gitignored. Keep credentials out of them
# and use ${ENV_VAR} references instead.
#
# Merge rules for MERGED files (settings.json, mcp.json):
#   - objects merge recursively
#   - arrays of strings are unioned, keeping order (e.g. packages)
#   - any other array or value is replaced by the later layer
# Other files: the last layer that has the file wins (whole-file replace).
# LOCAL_ONLY files (budget.json) come from overlays only and are never committed.
#
# Only the files in FILES are ever touched. Everything else in ~/.pi/agent
# (auth, sessions, caches, installed packages) stays out of git.

set -euo pipefail

AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
OVERLAY_SPEC="${PI_CONFIG_OVERLAYS:-$REPO_DIR/.local}"
IFS=':' read -r -a OVERLAYS <<< "$OVERLAY_SPEC"

FILES=(
  "settings.json"
  "mcp.json"
  "budget.json"
  "pi-pretty.json"
  "web-search.json"
  "themes/kanagawa-wave.json"
  "themes/opencode-ayu.json"
  "themes/opencode-catppuccin.json"
  "themes/opencode-kanagawa.json"
  "themes/opencode-tokyonight.json"
  "themes/princess-nam-rom.json"
  "extensions/budget/index.ts"
  "extensions/budget/render.ts"
  "extensions/budget/test.ts"
  "extensions/context-meter/index.ts"
  "extensions/context-meter/breakdown.ts"
  "extensions/context-meter/meter.ts"
  "extensions/context-meter/test.ts"
  "extensions/footer-segments/index.ts"
  "extensions/footer-segments/render.ts"
  "extensions/footer-segments/test.ts"
  "extensions/answer.ts"
  "extensions/goal.ts"
  "extensions/session-breakdown.ts"
  "extensions/powerline-footer/theme.json"
  "vibes/pirate.txt"
)
MERGED=("settings.json" "mcp.json")
LOCAL_ONLY=("budget.json")

# Deep-merge JSON documents given in order (see rules above).
MERGE_JQ='
def merge(a; b):
  if (a|type) == "object" and (b|type) == "object" then
    reduce (b | keys_unsorted[]) as $k (a;
      .[$k] = (if (a | has($k)) then merge(a[$k]; b[$k]) else b[$k] end))
  elif (a|type) == "array" and (b|type) == "array"
       and (a | all(type == "string")) and (b | all(type == "string")) then
    reduce ((a + b)[]) as $x ([]; if any(. == $x) then . else . + [$x] end)
  else b end;
reduce inputs as $doc (null; if . == null then $doc else merge(.; $doc) end)
'

contains() {
  local needle="$1"; shift
  local item
  for item in "$@"; do [[ "$item" == "$needle" ]] && return 0; done
  return 1
}

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

pull() {
  echo "Building $AGENT_DIR from base + overlays (${OVERLAYS[*]}):"
  local rel dst o src sibling
  for rel in "${FILES[@]}"; do
    local sources=()
    if ! contains "$rel" "${LOCAL_ONLY[@]}" && [[ -f "$REPO_DIR/$rel" ]]; then
      sources+=("$REPO_DIR/$rel")
    fi
    if contains "$rel" "${MERGED[@]}"; then
      sibling="$REPO_DIR/${rel%.json}.local.json"
      [[ -f "$sibling" ]] && sources+=("$sibling")
    fi
    for o in "${OVERLAYS[@]}"; do
      [[ -f "$o/$rel" ]] && sources+=("$o/$rel")
    done
    if [[ ${#sources[@]} -eq 0 ]]; then
      echo "  $rel (missing, skipped)"
      continue
    fi

    dst="$AGENT_DIR/$rel"
    mkdir -p "$(dirname "$dst")"
    if contains "$rel" "${MERGED[@]}"; then
      jq -n "$MERGE_JQ" "${sources[@]}" > "$dst.tmp"
      mv "$dst.tmp" "$dst"
      echo "  $rel (merged: ${#sources[@]} layers)"
    else
      src="${sources[${#sources[@]}-1]}"
      cp "$src" "$dst"
      echo "  $rel (from ${src#"$REPO_DIR"/})"
    fi
  done
}

push() {
  echo "Pushing from $AGENT_DIR:"
  local rel dst to_check=()
  for rel in "${FILES[@]}"; do
    if [[ ! -f "$AGENT_DIR/$rel" ]]; then
      echo "  $rel (missing, skipped)"
    elif contains "$rel" "${MERGED[@]}"; then
      echo "  $rel (composed file: edit the repo base or overlays, not ~/.pi/agent; skipped)"
    elif contains "$rel" "${LOCAL_ONLY[@]}"; then
      echo "  $rel (local only -> ${OVERLAYS[0]})"
    else
      to_check+=("$AGENT_DIR/$rel")
    fi
  done
  check_secrets "${to_check[@]+"${to_check[@]}"}"

  for rel in "${FILES[@]}"; do
    [[ -f "$AGENT_DIR/$rel" ]] || continue
    contains "$rel" "${MERGED[@]}" && continue
    if contains "$rel" "${LOCAL_ONLY[@]}"; then
      dst="${OVERLAYS[0]}/$rel"
    else
      dst="$REPO_DIR/$rel"
      echo "  $rel"
    fi
    mkdir -p "$(dirname "$dst")"
    cp "$AGENT_DIR/$rel" "$dst"
  done
}

case "${1:-}" in
  push) push ;;
  pull) pull ;;
  *)
    echo "usage: $0 push|pull" >&2
    exit 2
    ;;
esac

# pi-config

Personal [pi](https://pi.dev) coding agent config. Shared, generic settings live here; machine- or employer-specific values live in local overlays that are never committed.

```sh
./sync.sh pull   # repo base + overlays -> ~/.pi/agent
./sync.sh push   # ~/.pi/agent -> repo (copyable files) or overlays (local-only files)
```

## Layers

Config is built from layers. Later layers win.

1. **Repo base** (this directory): generic, committed. For example `settings.json`, `mcp.json`.
2. **Sibling override**: `<name>.local.json` next to a merged file, e.g. `settings.local.json`, `mcp.local.json`, `budget.local.json`. Gitignored.
3. **Overlays**: directories listed in `PI_CONFIG_OVERLAYS` (colon-separated). Default: `./.local/` (gitignored), for any other allowlisted file.

```sh
# Default: just ./.local
./sync.sh pull

# Work machine: shared base, then a private overlay repo, then local
PI_CONFIG_OVERLAYS="$HOME/Development/pi-config/.local:$HOME/work/pi-overlay" ./sync.sh pull
```

Sibling `*.local.json` files apply to `settings.json`, `mcp.json`, and `budget.json`. Overlay directories can hold any allowlisted file. The last layer wins for files that are not merged.

Merge rules for `settings.json`, `mcp.json`, and `budget.json`:

- Objects merge recursively, so an overlay can add or change single keys.
- Arrays of strings are unioned in order (e.g. `packages`), so overlays add to the base list.
- Other arrays and scalars are replaced by the later layer.

Other files: the last layer that has the file wins.

`budget.json` is local-only: it has no repo base, so it comes only from `budget.local.json` and overlays. Start from `budget.example.json`.

`./sync.sh push` writes `budget.json` back to `budget.local.json`. It skips `settings.json` and `mcp.json`, because those are composed and should be edited in the repo or in a local sibling.

Project-level `.pi/mcp.json` and `.pi/settings.json` inside a repo are a further layer that pi applies itself. Use them for servers a single project needs.

## Setting up a machine

```sh
cp budget.example.json budget.local.json   # then set your limits and model prices
# optional: settings.local.json for default model, enabledModels, compaction overrides
# optional: mcp.local.json for servers that need your own commands or credentials
./sync.sh pull
```

Example `settings.local.json` (model IDs are whatever your provider exposes):

```json
{
  "defaultProvider": "my-provider",
  "defaultModel": "my-model",
  "enabledModels": ["my-provider/my-model"]
}
```

Example `mcp.local.json`:

```json
{
  "mcpServers": {
    "my-server": { "type": "stdio", "command": "my-mcp-cli", "args": ["mcp"] }
  }
}
```

Keep credentials out of these files. Use `${ENV_VAR}` references in `env` and `headers`, as pi's MCP config supports. Also, `pi mcp login` stores OAuth tokens in `~/.pi/agent`, which is not synced.

## Contents

- `settings.json`: theme, powerline layout, packages, extension settings (merged with overlays)
- `mcp.json`: MCP servers shared by all machines (merged with overlays). After a pull, sign in with `pi mcp login atlassian`.
- `extensions/budget/`: estimated spend in the footer, plus a `/budget` overlay. Limits and prices come from `budget.json`. Test with `node --experimental-strip-types extensions/budget/test.ts`.
- `extensions/context-meter/`: context bar in the footer plus a `/context` grid overlay. Test with `node --experimental-strip-types extensions/context-meter/test.ts`.
- `extensions/footer-segments/`: thinking dots (`●●●○○`) and a smart path (`~`, `repo › sub/dir`, or `~/abbreviated`). Test with `node --experimental-strip-types extensions/footer-segments/test.ts`.
- `extensions/answer.ts`, `goal.ts`, `session-breakdown.ts`: `/answer`, `/goal`, `/session-breakdown`
- `themes/`: Kanagawa Wave, OpenCode ports (ayu, catppuccin, kanagawa, tokyonight), Princess Nam Rom

Nerd Font icons: the powerline footer does not detect every terminal, so set `export POWERLINE_NERD_FONTS=1` in `~/.zshenv` and use a Nerd Font in the terminal.

Not synced: `auth.json`, `mcp-auth.json` (OAuth tokens), `models.json` (may contain keys), `models-store.json`, `trust.json` (machine-specific), sessions, caches, installed packages, and the budget ledger.

## Third-party files

- `extensions/answer.ts`, `goal.ts`, `session-breakdown.ts`: from [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff), Apache-2.0
- `themes/opencode-*.json`: from [lulucatdev/pi-themes](https://github.com/lulucatdev/pi-themes), MIT
- `themes/princess-nam-rom.json`: from [isashi/awesome-pi-themes](https://github.com/isashi/awesome-pi-themes), MIT

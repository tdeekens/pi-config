# pi-config

Personal pi coding agent config. Synced with `sync.sh` (allowlisted files only; no credentials).

```sh
./sync.sh push   # ~/.pi/agent -> this repo
./sync.sh pull   # this repo -> ~/.pi/agent
```

## Contents

- `settings.json`: theme, powerline layout, model defaults, packages
- `mcp.json`: MCP servers (`example` via `example-cli mcp`, Atlassian remote MCP). After a pull, sign in with `pi mcp login atlassian`.
- `extensions/budget/`: example EUR budget estimate. Compact coloured footer (`~€ d ▰▱▱ 18/50  w …  m … · s 3.60`) plus a `/budget` overlay; `budget.json` holds limits and prices. Test with `node --experimental-strip-types extensions/budget/test.ts`.
- `extensions/context-meter/`: context bar in the footer plus a `/context` grid overlay. Test with `node --experimental-strip-types extensions/context-meter/test.ts`.
- `extensions/footer-segments/`: replaces powerline's `thinking` and `path` segments with thinking dots (`●●●○○`) and a smart path (`~`, `repo › sub/dir`, or `~/abbreviated`). Test with `node --experimental-strip-types extensions/footer-segments/test.ts`.
- `extensions/answer.ts`, `goal.ts`, `session-breakdown.ts`: `/answer`, `/goal`, `/session-breakdown`
- `themes/`: Kanagawa Wave, OpenCode ports (ayu, catppuccin, kanagawa, tokyonight), Princess Nam Rom

Nerd Font icons: the terminal (Rex) isn't auto-detected by the powerline footer, so set `export POWERLINE_NERD_FONTS=1` in `~/.zshenv` and use a Nerd Font in the terminal.

Not included: `auth.json`, `mcp-auth.json` (OAuth tokens), `models.json` (contains a key-like entry), `models-store.json`, `trust.json` (machine-specific), sessions, caches, installed packages, and the budget ledger.

## Third-party files

- `extensions/answer.ts`, `goal.ts`, `session-breakdown.ts`: from [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff), Apache-2.0
- `themes/opencode-*.json`: from [lulucatdev/pi-themes](https://github.com/lulucatdev/pi-themes), MIT
- `themes/princess-nam-rom.json`: from [isashi/awesome-pi-themes](https://github.com/isashi/awesome-pi-themes), MIT

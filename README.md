# pi-config

Personal pi coding agent config. Synced with `sync.sh` (allowlisted files only; no credentials).

```sh
./sync.sh push   # ~/.pi/agent -> this repo
./sync.sh pull   # this repo -> ~/.pi/agent
```

Not included: `auth.json`, `models.json` (contains a key-like entry), sessions, caches, installed packages, and the budget ledger.

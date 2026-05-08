# Consumer: claude-code-m4-vault

Configuration for the first dream-management consumer — JJ's M4 vault.

- `dream.config.json` — config consumed by the dream worker, wrapup-lint, and atomic-write helpers
- `memory_root`: `/Users/joyd/Documents/jj-knowledge-vault/agents/claude-code-m4`

## Adoption status

| Phase | Status |
|---|---|
| P0 contracts | drafted (awaiting JJ approval + merge to main) |
| P1 hot-path mechanism | in progress on `feat/p1-hot-path` |
| P2-P5 | not started |

The config file in this directory is the **canonical** copy. P4 install scripts will copy it to `<memory_root>/dream.config.json` so the consumer is self-contained at runtime; until then, all tooling reads from this path.

## Why not put this in the consumer's memory_root?

JJ's gate for P1: "Don't touch existing vault memory yet — P1 is shipping the mechanism." Adding a new file to the vault counts as touching the vault. Keeping the config in this repo until P4 install runs respects the gate.

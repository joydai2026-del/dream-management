# ADR 001: Three-Tier Memory Hierarchy

**Status**: Accepted, 2026-05-08
**Context**: First consumer's existing system had 8 named "memory tiers" but only 3 were load-bearing on session start. Everything else was write-mostly with no read path. Need a clean tier model with explicit budgets and decay.

## Decision

Adopt a three-tier hierarchy modeled on MemGPT/Letta with episodic capture inspired by CoALA:

| Tier | Read frequency | Token budget | Examples |
|---|---|---|---|
| **HOT** | Every session | ≤500 tokens (~80 lines × 4 chars/token + headers) | working-memory.md, identity.md (conditional), patterns/active/, pre-action.md |
| **WARM** | Lazy by topic | Index ≤200 tokens | corrections.md (<30d OR UNRESOLVED), session-index.md (last 10), decisions/, memory-index.md |
| **COLD** | Never auto-loaded; searchable | n/a | archive/sessions/, archive/corrections/, archive/journals/, archive/dreams/, patterns/reference/ |
| **EPISODIC** | Write daily, dream-consumed | n/a | learning-journals/today.md |

Hot tier is the only one read at session start. Warm tier is loaded by topic only when activated. Cold tier is searchable but never auto-loaded. Episodic is written during sessions and consumed by the nightly dream pass.

## Consequences

- Hot tier has hard budgets enforced by a wrap-up linter. Going over fails the session.
- Promotion path is explicit: episodic → patterns/active/ → patterns/reference/ → archive.
- Each tier has a defined consumer; no tier exists without a documented reader.
- Configuration per-consumer maps tier names to actual file paths via `dream.config.json`.

## Alternatives considered

- **Flat memory** (single MEMORY.md file): fails at scale, no decay possible.
- **Two-tier (working / archive)**: too coarse — patterns and corrections need different lifecycles.
- **N-tier (5+)**: hard to reason about, leads to write-mostly tiers with no clear reader.

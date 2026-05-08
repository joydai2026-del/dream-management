# dream-management

Portable nightly memory consolidation for Claude Code agents — a "dreaming" routine that compresses episodic memory, reinforces patterns, decays weak associations, and keeps memory tiers from accumulating into noise.

> Build once, configure per-consumer. Vault, code repo, future agents — same skill, different `dream.config.json`.

## Why this exists

AI memory systems built incrementally over time develop the same failure mode: **write-heavy, read-light**. Every correction spawns a file; nothing has an owner or TTL; memory-loaders read a fraction of what's written. Rules exist as text but never fire at decision-time.

This skill is the equivalent of REM sleep for an AI memory system. Run nightly, it:

1. **Replays** the day's events (learning journals + session logs)
2. **Reflects** with an LLM to extract high-importance insights
3. **Routes** insights → reinforce patterns / promote new ones / archive resolved corrections
4. **Prunes** with importance × recency decay
5. **Surfaces contradictions** for human review (never auto-fixes)
6. **Rebuilds** decision-time read indexes (`pre-action.md`)
7. **Audits itself** twice — deterministic invariants + cross-model adversarial (Codex)

Result: memory stays small enough to read, fresh enough to fire, and recoverable when wrong.

## Lineage

Synthesis of:

- [MemGPT (Packer et al.)](https://arxiv.org/abs/2310.08560) — three-tier memory hierarchy
- [Generative Agents (Park et al.)](https://arxiv.org/abs/2304.03442) — reflection + importance scoring
- [Voyager (Wang et al.)](https://arxiv.org/abs/2305.16291) — skill library as procedural memory
- [Sleep-time Compute (Lin et al., Berkeley + Letta)](https://arxiv.org/abs/2504.13171) — cost amortization
- [Anthropic auto-dream](https://claudefa.st/blog/guide/mechanics/auto-dream) — 4-phase + dual-gate
- [CoALA framework (Sumers et al.)](https://arxiv.org/abs/2512.13564) — episodic → semantic → procedural

Plus engineering safety primitives the precursors lack:

- Cross-model auditor (Codex/GPT-5 audits Claude worker — different blind spots)
- Atomic writes with `*.tmp` + rename (no partial-failure corruption)
- Pattern-firing instrumentation (closes the loop on "did the rule actually fire?")
- Source-citation requirement on every auto-promotion (prevents hallucinated patterns)
- Archive-never-delete + 14-tag rollback window

## Status

**Pre-1.0.** Architecture is locked (see [ARCHITECTURE.md](./ARCHITECTURE.md) and [ADR/](./ADR/)). Implementation in progress for first consumer (`claude-code-m4-vault`).

| Phase | Status |
|---|---|
| P0 Prep | not started |
| P1 Hot-path cleanup | not started |
| P2 Read-path + instrumentation | not started |
| P3 One-time pattern cleanup | not started |
| P4 Dream worker | not started |
| P5 Two-stage auditor + scheduling | not started |

## Quick start (once v1.0 ships)

```bash
git clone https://github.com/joydai2026-del/dream-management.git
cp dream-management/dream.config.example.json my-project/dream.config.json
# Edit my-project/dream.config.json — point tiers at your memory layout
dream-management install --config my-project/dream.config.json
# First night runs DRY-RUN; review dream-log.md; subsequent nights commit
```

## Documentation

- [ARCHITECTURE.md](./ARCHITECTURE.md) — full design
- [ADR/](./ADR/) — locked architectural decisions
- [docs/adoption-guide.md](./docs/adoption-guide.md) — installing into a new consumer (TBD)
- [docs/config-reference.md](./docs/config-reference.md) — `dream.config.json` schema (TBD)
- [docs/failure-modes.md](./docs/failure-modes.md) — known failure modes + recovery (TBD)

## License

TBD — currently private repo. Open-source candidate after v1.0.

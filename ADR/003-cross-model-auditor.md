# ADR 003: Cross-Model Two-Stage Auditor

**Status**: Accepted, 2026-05-08
**Context**: Dream worker mutates memory across multiple files. A failed audit could leave silent corruption that compounds over nights. Auditor must catch what the worker missed. Same-model auditor (fresh-context Claude) shares the worker's blind spots — same training distribution, same biases, same sycophancy.

## Decision

Two-stage audit, with the second stage running on a different model family entirely.

### Stage A — Deterministic Invariants (no LLM)

Runs first. Catches structural break.

- Schema check: every consolidated artifact has valid frontmatter
- Line-count check: hot tier files within budget
- Anchor-link integrity: every `[link](path)` resolves to a real file
- Archive integrity: every "moved to archive" entry exists in the archive's diff with exact line count match
- Source-citation check: every auto-promoted pattern cites an exact source line that exists
- Date normalization: no relative dates remain

### Stage B — `/codex` Adversarial Audit (cross-model)

Runs after Stage A passes. Catches semantic break.

- Invoked via `/codex` skill (Codex CLI, GPT-5)
- Adversarial prompt: "Find what's wrong. Hallucinated insights, fabricated citations, sycophantic scoring, contradictions, lost information."
- Different training distribution than the Claude worker → catches what same-model auditor would miss

### Failure handling

- Either stage FAIL → PAUSE the dream commit, surface to human at next session start, do NOT auto-rollback
- WARN with mitigation → apply mitigation, log to `.dream-log.md`
- Both PASS → commit

## Consequences

- Worker bugs (structural) caught cheaply by Stage A without LLM cost
- Hallucinations and sycophancy caught by Stage B because a different model is checking
- Auto-rollback removed — false-positive audits no longer destroy good work; human always involved on FAIL
- Adds `/codex` as a hard dependency of the dream system
- Stage B costs ~5K tokens per night of GPT-5 inference

## Alternatives considered

- **Fresh-context Claude auditor only**: same blind spots, fluent-but-wrong corruption gets through.
- **Auto-rollback on FAIL**: too aggressive — three false positives in a row stops the system; user can't tell if broken or correct.
- **Skip Stage A, only Stage B**: more expensive, slower, and structural bugs are deterministic — wasteful to use LLM compute for a `wc -l` check.

## Reviewer note

This is the resolution of MF-3 from the 2026-05-08 engineering review. Original design used fresh-context Claude as auditor. Both reviewers (Codex + senior Claude eng) flagged that fresh context ≠ different model. This ADR fixes that.

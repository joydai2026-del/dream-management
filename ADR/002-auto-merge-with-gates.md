# ADR 002: Auto-Merge Pattern Promotion with Hard Gates

**Status**: Accepted, 2026-05-08
**Context**: Nightly dream extracts insights and may promote new behavioral patterns. Two extremes: (a) queue everything for human review (high friction, defeats automation), (b) auto-merge everything (LLM sycophancy → cap blown in days). Need a middle path.

## Decision

Auto-merge pattern promotion driven by dream reflection, with five hard gates and a 24-hour human revoke window.

**Gates** (all must pass):

1. **Importance ≥ 7** on a 1-10 LLM-generated scale
2. **Top-2 ranking** among the night's insights (relative, not absolute — caps drift)
3. **≥ 3 prior journal mentions** from the past 30 days (requires journal mention index)
4. **Contradiction check**: no existing pattern in `patterns/active/` directly contradicts this candidate
5. **Exact source citation**: pattern frontmatter must cite a specific line in a journal/correction that exists

**Throttle**: max **1 promotion per night**.

**Revoke window**: human reviews `.dream-log.md` next morning. `/memory-demote <pattern>` undoes within 24 hours. After 24h, pattern is locked in (still reversible later but no longer in revoke fast-path).

## Consequences

- Auto-promotion preserves the "let dream judge" property — captures observed patterns without bottlenecking on human review.
- 1/night throttle + top-2 ranking + contradiction check together prevent cap-blowing.
- Source citation requirement defeats hallucinated patterns (the reviewer's #1 concern).
- 24h revoke is the safety valve — no decision is irreversible.
- Requires pattern-firing-log infrastructure (ADR 006) to compute the journal-mention index.

## Alternatives considered

- **Queue all for human review**: high friction, defeats nightly automation.
- **Auto-merge with no gates**: hits the cap-blowing failure mode within 3 days (LLM scoring drift; reviewer-flagged).
- **Importance-only gate**: insufficient — same training distribution scores everything 7+.
- **Higher importance threshold (≥9)**: too restrictive; would never fire.

## Reviewer note

This ADR is the resolution of the convergent must-fix flagged by both the senior Claude eng reviewer and Codex adversarial review on 2026-05-08. Original locked decision was "auto-merge with no queue"; reviewers proved this incompatible with the 10-pattern cap. This ADR adds the gates and throttle.

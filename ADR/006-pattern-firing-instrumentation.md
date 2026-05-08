# ADR 006: Pattern-Firing Instrumentation

**Status**: Accepted, 2026-05-08
**Context**: The whole architectural premise is that "rules don't self-fire" — they exist as text in CLAUDE.md / patterns/active/ but the action loop has no checkpoint that consults them. This ADR closes the loop by recording when rules actually fire.

## Decision

Every wrap-up writes a `pattern-firing-log.md` entry recording which rules from `pre-action.md` were referenced, applied, or violated during the session.

### Log format

Append-only, one entry per session:

```yaml
---
session: 2026-05-09-bazaar-x402-p2-t5b
project: bazaar-x402
duration_min: 87
---
referenced:
  - pattern: external-dom-drift-llm-default
    fired_at: "discussing selector miss in TuneCore audit"
    outcome: applied
  - pattern: parallel-agents-for-audits
    fired_at: "spawning 4-reviewer batch"
    outcome: applied
violated:
  - pattern: caveman-check-on-reports
    detail: "led with engineering compression in mid-session report"
    correction_filed: true
not_referenced:
  # Rules in pre-action.md that didn't come up this session
  - shoulders-of-giants-research-first
  - branching-rule-cut-branch-before-edit
```

### How it gets written

- Wrap-up skill scans the session transcript for: (a) explicit pattern references in Claude's reasoning, (b) corrections JJ filed in the session, (c) actions that match pattern triggers
- LLM call to wrap-up classifies each pre-action.md rule as referenced/applied/violated/not-referenced
- Honest "violated" tagging is the highest-value signal — captures the gap between loaded and applied

### How dream uses it

1. **Demotion gate**: any pattern in `patterns/active/` with no `referenced` event in 60 days → demote to `patterns/reference/`. Without this log, the demotion gate is hand-wavy.
2. **Promotion verification**: when checking `≥3 prior journal mentions` for promotion, dream cross-references the firing log to weight evidence quality.
3. **Observability**: weekly digest computes "rules loaded but not applied" ratio. High ratio → pre-action.md not selecting relevant rules.
4. **Recurrence detection**: if same `violated` event appears 2+ times for the same pattern → file a correction or escalate the rule's wording.

## Consequences

- Wrap-up gets longer (extra LLM call). Acceptable cost.
- The "did the rule fire?" question becomes answerable.
- Closes the architectural premise — the system can now measure its own primary KPI.
- Without this log, P3 demotion logic is impossible and observability collapses.

## Alternatives considered

- **No instrumentation, hand-wave demotion**: can't actually demote; cap fights promotion.
- **Implicit firing detection from corrections.md**: too lossy — many fired rules are silent successes (no correction needed).
- **Manual firing tags by Claude in real-time**: relies on Claude remembering to tag; unreliable.

## Reviewer note

Both reviewers flagged this as **the single biggest gap** in the original plan (Codex top-7 #7, senior Claude eng "biggest missing piece"). This ADR is MF-4 from engineering review, the most-prioritized must-fix.

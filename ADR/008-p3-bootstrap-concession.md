---
status: accepted
date: 2026-05-09
deciders: JJ, claude-code-m4
related:
  - SUCCESS-CRITERIA.md (P3 #3)
  - docs/pattern-firing-log-spec.md (§ 5/6)
  - ADR/006-pattern-firing-instrumentation.md
  - ADR/004-archive-never-delete.md
---

# ADR 008 — P3 First-Cleanup Bootstrap Concession

## Context

SUCCESS-CRITERIA P3 #3 (original) required: every demoted pattern's frontmatter has `last_fired:` ≥60 days old (i.e., date ≤2026-03-08 if cleanup runs 2026-05-09).

The criterion's intent: ensure demotion was earned, not arbitrary.

The criterion assumes 60+ days of pattern-firing-log data exists to derive `last_fired:`. But the firing-log infrastructure shipped only in P2 on 2026-05-09 — there is no historical firing data for the first cleanup run.

For the 2026-05-09 cleanup, the patterns ranked bottom-N had proxy `last_fired:` dates between 2026-04-02 and 2026-04-27 — derived from `max(file mtime, session-log grep mention, journal grep mention, corrections.md cite)`. None qualified under the strict ≤2026-03-08 criterion.

## Decision

Permit a one-time bootstrap concession on P3 #3. Demoted patterns may satisfy the criterion via EITHER:

a) `last_fired:` date ≤2026-03-08 (the strict spec), OR
b) `bootstrap: true` AND `bootstrap_at: 2026-05-09` AND `bootstrap_method:` (describing the proxy used) AND `last_fired:` (proxy date present, even if more recent than 2026-03-08).

The concession applies only to the 2026-05-09 first-cleanup run. To enforce the "one-time" boundary, today's-demotion files also carry a `demotion_phase: p3-2026-05-09` field; the amended P3 #3 verification command (now `scripts/verify-p3-3.sh`) scopes ONLY to files with that field. Pre-spec demotions in `reference/` (without `demotion_phase:`) are grandfathered out-of-scope. Reconciliation-merge files (with `reconciliation_merged_at:` only) are also out-of-scope.

Future demotions (run by the P4 dream worker against pattern-firing-log data) MUST satisfy (a). The dream worker's Phase 3 demotion gate (per `docs/pattern-firing-log-spec.md` § 6.1) is currently spec-only: `fired_count == 0` over 60 days. **STRUCTURAL ENFORCEMENT TODO**: the spec § 6.1 demotion logic does NOT yet inspect `bootstrap:` frontmatter or reject bootstrap-flagged candidates. The "one-time" boundary today is convention (this ADR) + the `demotion_phase: p3-2026-05-09` scope tag, NOT code-level rejection. When P4 worker is built, its Phase 3 implementation MUST add explicit logic that:

1. Rejects re-promotion of `bootstrap: true` files unless evidence-based criteria are met (clears the bootstrap flag on re-promotion).
2. Refuses to write `demotion_phase: p3-2026-05-09` to any new file (the tag is a one-time historical marker).
3. If a future P3-style cleanup is needed, uses a NEW `demotion_phase:` value (e.g., `p3-2026-MM-DD`) so each cleanup is independently auditable.

Until P4 lands, the boundary is conventional. This ADR + spec amendment is the contract; reviewer-grep verifies it on each session via `scripts/verify-p3-3.sh`.

## Bootstrap proxy method (for reproducibility)

For each pattern under consideration at the time of the 2026-05-09 cleanup — both `patterns/active/*.md` files (21 total) AND `patterns/<root>.md` ROOT-ONLY files (5 total, those without an active/ or reference/ twin) — `last_fired:` was computed as:

```
last_fired = max(
  mtime of the file (in active/ for active patterns, in patterns/ root for ROOT-ONLY),
  date stem of most-recent session-log file (~/Documents/jj-knowledge-vault/agents/claude-code-m4/session-logs/YYYY-MM-DD*.md) whose contents grep-match the pattern's identifier (kebab-case stem),
  date stem of most-recent learning-journal file (~/Documents/jj-knowledge-vault/agents/claude-code-m4/learning-journals/YYYY-MM-DD-*.md) whose contents grep-match the pattern's identifier,
  date "2026-04-30" treated as a sentinel if the pattern's identifier appears anywhere in ~/Documents/jj-knowledge-vault/agents/claude-code-m4/corrections.md (else this term is omitted)
)
```

Date format: ISO `YYYY-MM-DD`, lexical sort (works for ISO dates within the same century). All file-system paths are absolute; mtime is local-time stat field with day-precision (`stat -f %Sm -t %Y-%m-%d`). Tie-breaks: when two patterns share an identical max date, the one with a higher `confidence:` frontmatter value is ranked higher; if confidence is equal, alphabetical filename order. The full per-pattern proxy table is recorded in the session log at `~/Documents/jj-knowledge-vault/agents/claude-code-m4/session-logs/2026-05-09-dream-mgmt-p3.md` (and the corresponding learning-journal entry).

Patterns ranked by this proxy descending. Top-10 retained in `active/`; bottom-N demoted to `reference/` with bootstrap frontmatter. The 2026-05-09 cleanup demoted **16 patterns total**:

- **13 from active/ → reference/** (originally 21 active, with 2 promotions from the patterns/ root reconciliation tier added as keepers, the final keep-cut was 23 → 10):
  `codex-branch-artifact-false-positives`, `verify-recap-against-git-before-writing-code`, `systems-fix-over-symptom-fix`, `atomic-commit-isolation`, `latent-api-bugs-via-type-system`, `no-qa-claims-without-full-testing`, `persistent-state-dedup-for-external-sync`, `schema-migration-synthesize-on-read`, `delegates-content-owns-architecture`, `empty-states-are-dealbreakers`, `modular-plan-hierarchy`, `save-feedback-as-durable-memory`, `silence-after-correction-means-save-it`.
- **3 from patterns/ root tier → reference/** (root-only orphans never in active/, placed in reference/ during the same cleanup as part of the root reconciliation; treated as a demotion since they were not promoted to active despite having content):
  `agent-worktree-isolation-leaks`, `manual-worktree-for-dirty-checkout`, `operator-feature-scope-undercount`.

Plus **1 reconciliation-merge** (NOT a demotion):
- `adversarial-debate-in-reviews`: pre-existing in `reference/` with mtime 2026-04-02; the patterns/ root copy had richer 2026-04-23 evidence (JJ Company Brain dual-control rule). The reconciliation merge replaced the reference/ version with the richer root version. Marked with `reconciliation_merged_at: 2026-05-09` + `reconciliation_source:` (no `demotion_phase:` field, so not in P3 #3 scope).

## Promotions to active/ during the same cleanup

Two ROOT-ONLY files were promoted to `active/` (not demoted) during root reconciliation:

- **`codex-review-per-phase-gate.md`**: Promoted because external session-log evidence shows recent active firings:
  - `~/Documents/jj-knowledge-vault/agents/claude-code-m4/session-logs/2026-05-08.md` (Outreach v2 Phase 0+1 work) records the per-phase Codex gate firing on PR #96 + #97 (4 + 2 rounds respectively). The pattern's own evidence section cites these but the underlying authority is the session log itself, not self-citation.
  - The pattern is also dogfooded as the structural baseline for arch-engineer's PR auto-merge gate (per its content).
  - High confidence (existing frontmatter), recent external firing (2026-05-07 dated session work), load-bearing for active discipline.
- **`pre-customer-scaffolding-gets-pruned.md`**: Promoted because it is explicitly cited in `~/.claude/CLAUDE.md` Master Plan North Star Rule § 3 ("3-question test"). Load-bearing for every session report.

## Why this is principled, not arbitrary

The bootstrap proxy method IS the best-available signal pre-firing-log. Bottom-16 ranking by this proxy is reproducible and surfaceable. The `bootstrap: true` flag makes the concession visible in frontmatter so future re-promotion can re-evaluate using firing-log data once it accrues.

Spec intent ("demotion was earned") is preserved: bottom-16 were measurably the least active by every available signal. The strict date threshold was a post-hoc proxy for "low recent activity"; the bootstrap concession satisfies that intent via different evidence.

## Consequences

- One-time amendment to SUCCESS-CRITERIA P3 #3 (already applied 2026-05-09).
- 16 patterns demoted on 2026-05-09 carry both `bootstrap: true` AND `demotion_phase: p3-2026-05-09` frontmatter. Any future re-promotion via P4 dream worker should clear both flags and rely on firing-log evidence going forward.
- Future P3-style cleanups (after firing-log accrues 60+ days) must satisfy (a). The dream worker's Phase 3 demotion gate (per ADR 006 § 6.1) implements (a) directly via firing-log read; no bootstrap pathway exists in code.
- Pre-spec reference/ files (the 12 demoted before 2026-05-08 spec) are grandfathered: not in P3 #3 scope, not required to backfill bootstrap fields.
- Reconciliation-merge files (1, adversarial-debate) are out-of-scope: marked with `reconciliation_merged_at:` not `demotion_phase:`.

## Rejected alternatives

- **Delay P3 entirely until firing-log accrues (2 months)**: blocks P4 work, wastes the existing best-available proxy data, leaves patterns/active/ at 21 (over-cap) for 2 months.
- **Force-backdate `last_fired:` to 2026-03-08 on all 16 demoted**: misleading; future-Claude reading those frontmatters would think the patterns were dormant 60+ days when they had recent activity. Violates fact-fidelity.
- **Drop the criterion ("demotion is OK regardless of evidence")**: removes the guard against arbitrary demotion. Accept-anything fails the spec's intent.
- **Backfill bootstrap on the 12 pre-spec reference files**: would technically pass the criterion, but inflates the bootstrap concession beyond "today's cleanup" and obscures that those files were demoted under different (or no) criteria. Grandfathering via `demotion_phase:` scope is more honest.

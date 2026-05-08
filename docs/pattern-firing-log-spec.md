---
title: Pattern-Firing Log Format Spec
status: P0 contract — locked once JJ approves
audience: implementers (P2 wrap-up writer, P4 dream worker reader, P5 auditor)
related:
  - ADR/006-pattern-firing-instrumentation.md
  - ADR/002-auto-merge-with-gates.md
  - SUCCESS-CRITERIA.md (P4 #6 promotion gate, P5 #5 dual-gate observability)
date: 2026-05-08
---

# Pattern-Firing Log Format Spec

This document specifies `pattern-firing-log.md` — the file that closes the architectural premise of dream-management. The whole system rests on the claim "rules don't fire at decision-time." This file is how we measure firing. Without it, demotion is hand-wavy and observability collapses (per ADR 006 + reviewer MF-4).

---

## 1. Purpose

Every wrap-up writes one entry recording, for each rule in `pre-action.md`, whether it was **referenced**, **applied**, **violated**, or **not-referenced** during the session.

The dream worker reads this log to:

- **Demote** patterns in `patterns/active/` that have no `referenced`/`applied` event in 60 days (ADR 002, ADR 006).
- **Verify** the "≥ 3 prior journal mentions" gate when promoting candidates — cross-references actual firing data.
- **Surface** "rules loaded but never fired" in the weekly digest. High not-referenced ratio → `pre-action.md` is selecting wrong rules.
- **Escalate** repeated violations: same rule violated 2+ times in a window → file a correction or rewrite the rule's wording.

---

## 2. File location

Default path: `<memory_root>/pattern-firing-log.md`. Overridable via `dream.config.json`'s `instrumentation.pattern_firing_log`.

The first consumer (claude-code-m4-vault): `~/Documents/jj-knowledge-vault/agents/claude-code-m4/pattern-firing-log.md`.

---

## 3. File structure

Append-only. One file per consumer. Rotated monthly when over 5,000 lines (§ 7).

### 3.1 File header

```markdown
---
title: Pattern Firing Log
consumer: claude-code-m4-vault
schema_version: 1.0.0
created: 2026-05-09
rotation: monthly-or-5000-lines
---

# Pattern Firing Log

Append-only. One YAML block per session. Read by `/dream` at 03:00 daily.
Schema: docs/pattern-firing-log-spec.md.
```

The body below the header is a sequence of YAML blocks separated by `---` markers, each block bracketed in fenced code (` ```yaml ... ``` `) so the file remains valid markdown and Obsidian-readable.

### 3.2 Per-session entry

```yaml
---
session: 2026-05-09-bazaar-x402-p2-t5b
session_log: session-logs/2026-05-09.md
project: bazaar-x402
cwd: /Users/joyd/dev/bazaar-x402
duration_min: 87
pre_action_loaded_rules:
  - external-dom-drift-llm-default
  - parallel-agents-for-audits
  - caveman-check-on-reports
  - shoulders-of-giants-research-first
  - branching-rule-cut-branch-before-edit
  - how-decision-research-and-recommend
  - planning-pipeline-for-non-trivial
firings:
  - pattern: external-dom-drift-llm-default
    outcome: applied
    fired_at: "discussing TuneCore selector miss"
    evidence: session-logs/2026-05-09.md#L142
  - pattern: parallel-agents-for-audits
    outcome: applied
    fired_at: "spawning 4-reviewer batch on P2 T5b"
    evidence: session-logs/2026-05-09.md#L201
  - pattern: caveman-check-on-reports
    outcome: violated
    detail: "led with 'matrix-minimal: 4 halt × 3 buckets' in mid-session report"
    evidence: session-logs/2026-05-09.md#L388
    correction_filed: corrections.md#L102
  - pattern: shoulders-of-giants-research-first
    outcome: referenced
    fired_at: "evaluated existing repos before recommending Hermes adoption"
    evidence: session-logs/2026-05-09.md#L67
    detail: "rule cited in reasoning but no fork happened — research-only invocation"
not_referenced:
  - branching-rule-cut-branch-before-edit
  - how-decision-research-and-recommend
  - planning-pipeline-for-non-trivial
---
```

---

## 4. Outcome vocabulary

Exactly four values. Closed set. No others permitted.

| Outcome | Meaning | Counts toward "fired"? |
|---|---|---|
| `applied` | Rule fired AND its action was taken (e.g., spawned parallel agents because rule said to). | Yes |
| `referenced` | Rule was cited in reasoning OR consulted, but no action followed (e.g., rule applied to a borderline case that didn't trigger). | Yes |
| `violated` | Rule was relevant, was loaded, and was NOT followed. Action contradicted the rule. | Yes (failure firing — most valuable signal) |
| `not-referenced` | Rule loaded into pre-action.md but didn't come up. Listed in the entry's `not_referenced` array, not under `firings`. | No |

The dream worker's demotion gate counts `applied` + `referenced` + `violated` as "fired." A rule that only ever produces `violated` events is still a fired rule — the firing detector caught the gap, which is the point of the system. The escalation logic (§ 6.4) handles whether to keep, rewrite, or escalate the rule.

---

## 5. How wrap-up writes it

### 5.1 Wrap-up flow (P2 work)

1. Wrap-up reads the session transcript and the active `pre-action.md`.
2. For each rule in `pre-action.md.loaded_rules`, an LLM call classifies the rule as `applied`, `referenced`, `violated`, or `not-referenced`. Prompt template lives at `templates/wrapup-firing-classifier.md` (P2 deliverable).
3. Wrap-up appends the YAML block to `pattern-firing-log.md` via the atomic-write helper (`atomicity-contract.md` § 3).
4. Wrap-up also writes (or updates) `pattern-firing-log.md`'s file header on first creation.

### 5.2 LLM classification rules (prompt contract)

The classifier MUST cite a session-log line for every `applied` / `referenced` / `violated` outcome. No citation → outcome demotes to `not-referenced` (the safe default). This guards against hallucinated firings.

The classifier MAY skip a rule entirely (omit from both `firings` and `not_referenced`) only if `pre-action.md` was regenerated mid-session — an edge case that triggers a warning in the dream-log.

### 5.3 Honesty incentive

`violated` is the **highest-value signal** in the log, and the prompt is explicit about this. The classifier is told to over-tag `violated` rather than under-tag, because a missed violation hides exactly the failure mode the system was built to expose.

---

## 6. How dream reads it

### 6.1 Demotion gate (Phase 3)

For each pattern `P` in `patterns/active/`:

```
lookback = read pattern-firing-log.md entries from last 60 days
fired_count = sum over entries of (outcome in {applied, referenced, violated} for P)
if fired_count == 0:
    move P to patterns/reference/ (with provenance entry in dream-log)
```

A pattern with zero firing in 60 days is demoted regardless of how recently it was promoted. The promotion gate (ADR 002) ensures only earned-evidence patterns get promoted in the first place; demotion is a hygiene pass.

### 6.2 Promotion verification (Phase 2)

For a candidate pattern:

```
gate_3_min_journal_mentions = count distinct learning-journal lines mentioning candidate concept
gate_supplement_firing_history = count entries in pattern-firing-log.md where:
   - the candidate's concept appears in fired_at OR detail fields
   - outcome is applied or violated (referenced is too soft for promotion evidence)
weighted_evidence = gate_3_min_journal_mentions + 0.5 * gate_supplement_firing_history
if weighted_evidence < 3.0:
    promotion declined (logged in dream-log with reason)
```

Firing-log evidence is half-weighted vs journal mentions because journals contain more explicit framing. This formula is tuneable in `dream.config.json.promotion_gates.firing_log_weight` (defaults to 0.5).

### 6.3 Observability (Phase 5 — weekly digest)

Computes:

| Metric | Formula |
|---|---|
| Loaded-but-not-applied ratio | `sum(not_referenced) / sum(pre_action_loaded_rules)` over the week |
| Top violated rules | `firings` filtered to outcome=violated, grouped, top-5 |
| Newly-applied patterns | first `applied` event per pattern in the week |
| Silent patterns | active patterns with 0 firings in last 7 days |

A loaded-but-not-applied ratio above 0.7 surfaces a comment in the weekly digest: "pre-action.md may be selecting irrelevant rules — consider regenerating selector logic."

### 6.4 Escalation (recurrent violations)

If the same `(pattern, outcome=violated)` tuple appears 2+ times within a 14-day window, the dream worker writes an entry to `corrections.md` with a `escalate:` flag (semantic only, not behavioral) and references both source lines in the dream-log under "Recurrent Violations." JJ reviews next morning and decides whether to rewrite the rule, file a counter-pattern, or close as expected-friction.

---

## 7. Bounded growth

Append-only files grow forever. Mitigations:

### 7.1 Monthly rotation

When `pattern-firing-log.md` exceeds 5,000 lines OR crosses a month boundary, the dream worker:

1. Renames the file to `archive/firing-logs/YYYY-MM.md`
2. Creates a fresh `pattern-firing-log.md` with the file header from § 3.1
3. Logs the rotation in `.dream-log.md` and `manifest.json.files`

### 7.2 Compaction (60+ days old, optional)

In v1.x, the dream worker MAY compact entries older than 60 days into per-month aggregates: `{ month: '2026-04', applied_count: 142, violated_count: 18, top_violations: [...] }`. Per-session granularity is lost; statistics survive. Off by default in v1.0; controlled via `dream.config.json.instrumentation.firing_log_compact_after_days`.

### 7.3 Backfill on rotation

The auditor confirms (Stage A) that:

- `pattern-firing-log.md` post-rotation has zero entries OR exactly the entries written since rotation.
- `archive/firing-logs/YYYY-MM.md` contains exactly the entries removed from the live file.

---

## 8. Failure modes

| Failure | Detection | Recovery |
|---|---|---|
| Wrap-up crashes mid-write | Atomic-write contract (`*.tmp`-then-rename) — partial entry never visible. | Next wrap-up appends normally; missed session is logged as `firings_missing` in the dream's source-signal section. |
| LLM classifier hallucinates a `applied` outcome with fake evidence line | Stage A auditor checks every cited evidence line resolves to a real session-log line. Failure → entry flagged in dream-log; rule's firing count for that day discounted. | Rerun wrap-up classifier with a stricter prompt; or accept the discount and move on. |
| `pre_action_loaded_rules` is empty (pre-action.md absent) | Wrap-up writes an empty `firings` block with explanatory `note:` field. | First-night-only edge case until P5 ships pre-action.md generator. |
| Log file deleted accidentally | File header `created:` field shows recent date; auditor compares against `dream.config.json` install date and warns. | Restore from `archive/firing-logs/` if rotated; else accept loss and seed fresh. Past data lost; nothing depended on it being recoverable. |
| Multiple wrap-ups race (concurrent sessions) | Atomic-write contract serializes via lock file. | Last writer wins on rare conflict; both entries preserved because writes are append. |

---

## 9. Worked example

After a session where Claude built a pattern-firing-log entry classifier and JJ reminded mid-session "use the caveman check," wrap-up writes:

```yaml
---
session: 2026-05-09-dream-mgmt-p0-p1
session_log: session-logs/2026-05-09.md
project: dream-management
cwd: /Users/joyd/dev/dream-management
duration_min: 124
pre_action_loaded_rules:
  - shoulders-of-giants-research-first
  - branching-rule-cut-branch-before-edit
  - phase-gated-review-mandatory
  - caveman-check-on-reports
  - karpathy-guidelines
  - jj-what-claude-how-decision-rule
  - parallel-agents-for-audits
firings:
  - pattern: branching-rule-cut-branch-before-edit
    outcome: applied
    fired_at: "cut feat/p0-contracts before writing docs"
    evidence: session-logs/2026-05-09.md#L18
  - pattern: shoulders-of-giants-research-first
    outcome: applied
    fired_at: "leaned on MemGPT, Park, Anthropic auto-dream rather than reinvent"
    evidence: session-logs/2026-05-09.md#L31
  - pattern: caveman-check-on-reports
    outcome: violated
    detail: "draft contract used 'append-only YAML block per wrap-up' without inline define"
    evidence: session-logs/2026-05-09.md#L412
    correction_filed: false
  - pattern: jj-what-claude-how-decision-rule
    outcome: applied
    fired_at: "researched atomicity options, presented contract instead of asking JJ"
    evidence: session-logs/2026-05-09.md#L267
not_referenced:
  - phase-gated-review-mandatory
  - karpathy-guidelines
  - parallel-agents-for-audits
---
```

Three lessons the dream worker can extract:

1. `branching-rule` and `shoulders-of-giants` reinforced — sightings += 1
2. `caveman-check` violated once — counter += 1, no escalation yet (1 occurrence < 2-in-14-days threshold)
3. `phase-gated-review`, `karpathy`, `parallel-agents` were loaded but never came up — accumulating not-referenced toward the 60-day demotion gate

---

## 10. Done definition

P0 firing-log spec is locked once:

1. Section 4 (outcome vocabulary) is exhaustive — adding a fifth outcome later requires schema-version bump.
2. The wrap-up classifier prompt template (P2) implements § 5.2 honesty incentive verbatim.
3. The dream demotion gate (P4) implements § 6.1 in code.
4. The Stage A auditor (P5) verifies every cited `evidence:` line resolves.
5. JJ sign-off on the worked example (§ 9) — does this entry shape feel right to skim morning-of?

After lock, schema changes require a new ADR or `schema_version` bump.

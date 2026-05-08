---
title: Memory System Redesign — Diagnosis + Plan
date: 2026-05-08
status: locked-pending-final-confirm
audience: JJ
decisions_locked:
  - hot_tier_cap: strict 80 lines (working-memory.md)
  - pattern_promotion: auto-merge driven by dream reflection with hard gates (max 1/night, top-2 ranking, contradiction-check, exact-source citation). JJ does morning review of dream-log; revokes via /memory-demote if wrong (locked-in after 24h).
  - dream_cadence: nightly 3 AM, dual-gate (≥24h AND ≥1 session in 24h)
  - cloud_mode_boundary: cloud routine sessions (Dispatch/cloud agents) are STATELESS execution-only — they receive task spec, do the work, return result via PR/git. NO memory shipped to cloud. NO cross-project memory sharing. M4 vault stays local-only. Merge happens locally on M4 after cloud session returns; M4 dream pass learns from the merged work normally. Privacy/security boundary: zero risk of private project memory leaking into public-project cloud sessions.
  - auditor_independence: dream auditor uses /codex skill (cross-model adversarial audit via GPT-5/Codex CLI), NOT a fresh Claude subagent. Two-stage: deterministic invariants (schema, line counts, frontmatter, anchor link integrity, archive integrity) run FIRST as a non-LLM gate; /codex runs SECOND as adversarial semantic audit. This addresses MF-3 from engineering review — same-model blind spots avoided.
  - portability: dream system is a standalone, portable skill. Repo at https://github.com/joydai2026-del/dream-management. Designed to be installable into any project (vault, code repo, other agent setups) via config-driven adapters. Local checkout at ~/dev/dream-management. Vault is the first consumer; future projects can adopt by writing a dream.config.json pointing at their memory layout.
---

# Memory System Redesign — Diagnosis + Plan

> Three parallel agents (senior architect audit, in-session self-reflection, best-practices research including Anthropic's auto-dream and the dreaming literature) converge on the same diagnosis. This doc synthesizes their findings into a concrete redesign + nightly dreaming routine.

---

## TL;DR (the 60-second version)

**Diagnosis**: The current memory system is a **hoarding system pretending to be a memory system**. It is write-heavy and read-light. Every correction spawns 3-5 artifacts ("make sure it sticks"); none of them have an owner or TTL. Memory-loader reads a few; wrap-up writes many; the rest pile up unread.

**Three concrete failures, by the numbers**:

| Artifact | Current | Designed | Bleed |
|---|---|---|---|
| session-index.md | 1,126 lines (read in full every session) | ~300 | ~900 lines/session of stale context |
| learning-journals/ | 320 KB in 8 days, never read back | Read by no one | Pure write-only |
| corrections.md | 482 lines, no TTL, archive migration dead | last 30 days only | ~300 lines of resolved cruft |
| next-session-prompts/ | 23 files at agent root | 1 (latest only) | 22 stale prompts |
| Same rule in N places | "external-DOM-drift" lives in 6 places | 1 canonical + refs | 5 stale shadows per rule |

**Root architectural flaw**: rules exist as text but **nothing fires them at decision-time**. Loaded ≠ applied. The system optimizes for capture, not retrieval.

**Fix**: Redesign around a **3-tier memory hierarchy** (hot/warm/cold) with **hard token budgets**, **decay functions**, and a **nightly dreaming pass** that reflects, prunes, promotes, and reinforces — modeled on Park et al.'s generative agents + Anthropic's auto-dream pattern + JJ's own archive-never-delete rule.

---

## Section 1: What All Three Agents Agreed On

The audits ran independently. They converged on these findings:

### 1.1 Write/Read asymmetry is the core flaw

- **Architect**: "It has 8 named memory tiers but only 3 are actually load-bearing on real session start. Everything else is write-mostly: produced ritually by `/wrapup`, never re-read by `/memory-loader`."
- **Self-reflection**: "Writing is cheap, reading-and-applying is unstructured. The system optimizes for capture, not retrieval-at-decision-time."
- **Research**: "Anthropic's own auto-dream skill addresses this with a Stop-hook that triggers reflective passes. Berkeley sleep-time-compute paper: 5× token reduction, +18% accuracy when nightly compute pre-computes memory."

### 1.2 Rules don't self-fire

The single most important finding from self-reflection: **a rule existing in CLAUDE.md ≠ a rule being applied mid-session.** Examples from corrections.md where rules WERE loaded but failure happened anyway:

- Sprint 9 R4: offered "manual selector patch" Option A despite `external-dom-drift-llm-default` pattern being loaded
- 2026-05-07: proposed Hermes/GLM for Layer 4 despite parent plan locking Sonnet 24h earlier
- F2-ext aiogram bot built despite Hermes already covering Telegram + ASR
- Caveman language recurrence — rule existed, didn't prevent recurrence
- 2026-04-29 worktree branching — Branching Rule existed, edits landed on main

The pattern: **action loop has no checkpoint that consults the rules.**

### 1.3 Redundancy is structural, not accidental

Every JJ correction generates 3-5 artifacts: CLAUDE.md update + context.md Workflow Rules entry + corrections.md entry + feedback file in global memory + sometimes a pattern file. JJ's intuition behind this is correct ("can't trust one artifact to fire") — but the answer isn't more artifacts, it's **read-side enforcement**.

### 1.4 Strong tier exists: patterns/active/

Universally praised by all three agents. The promotion pipeline (3+ session occurrences → active) works as designed. 21 active patterns is over-budget but the *quality* is high. Examples that genuinely change behavior:

- `default_to_llm_for_external_dom_drift.md` — stopped 6 commits' worth of manual selector patches
- `parallel-agents-for-audits.md` — actually causes 4-reviewer parallel batches
- `silence-after-correction-means-save-it.md` — fires the "patch the source skill" reflex at session end

This is the model to extend, not the part to fix.

### 1.5 Anthropic's auto-dream IS the canonical pattern (with known gaps)

Research agent confirmed: Anthropic ships a `consolidate-memory` skill via Cowork ([source](https://claudefa.st/blog/guide/mechanics/auto-dream)). 4-phase algorithm:

1. **Orient** — read MEMORY.md + memory dir listing
2. **Gather Signal** — targeted grep over recent session JSONLs (NOT full reads)
3. **Consolidate** — merge findings, normalize relative dates → absolute, resolve contradictions
4. **Prune & Index** — rebuild MEMORY.md as ≤200-line index

Trigger: dual-gate (≥24h AND ≥5 sessions). Background, lock-protected.

**Known gaps to NOT inherit** (from issue #38493):
- No audit trail (`.dream-log.md`)
- Writes claims without verifying source files
- Orphans memory of renamed projects

---

## Section 2: The Redesign — 3-Tier Memory With Budgets and Decay

Borrowing from MemGPT/Letta tier model + Park et al. importance scoring + Anthropic's 4-phase consolidation + JJ's archive-never-delete rule.

### 2.1 Target architecture

```
HOT TIER (read every session, hard cap ≤500 tokens)
  ├── working-memory.md         — current project state, last-session continuation, top-5 unresolved
  ├── identity.md               — JJ model (conditional load: first-of-day or >7d)
  └── patterns/active/          — capped at 10 files (currently 21)

WARM TIER (lazy-loaded by topic, index ≤200 tokens)
  ├── memory-index.md           — topic → file path map (like wiki/index.md but for memory)
  ├── corrections.md            — only entries <30 days OR UNRESOLVED, capped at 150 lines
  ├── session-index.md          — only last 10 sessions, capped at 200 lines
  └── decisions/                — locked architectural decisions, indexed

COLD TIER (searchable, never auto-loaded)
  ├── archive/sessions/         — full session logs older than 14 days
  ├── archive/corrections/      — resolved corrections older than 30 days
  ├── archive/journals/         — learning journals after consolidation
  ├── archive/dreams/           — pre-dream snapshots (one per nightly run)
  └── patterns/reference/       — patterns not fired in 60 days

EPISODIC TIER (write during session, consolidated nightly)
  └── learning-journals/today.md  — one file per day, consumed by nightly dream
```

### 2.2 What gets fixed

| Current artifact | Redesign |
|---|---|
| `context.md` (225 lines, 50% over cap) | Renamed `working-memory.md`, hard-capped at 80 lines, wrap-up linter fails if over |
| `session-index.md` (1,126 lines) | Last 10 sessions only (~200 lines). Older entries roll into `archive/sessions/` nightly |
| `corrections.md` (482 lines) | Only entries <30d OR UNRESOLVED. Resolved-and-aged auto-archive |
| `learning-journals/` (write-only) | Real consumer: nightly dream reads, distills, archives. Memory-loader reads ONLY today's file |
| `next-session-prompts/` (23 files) | Single `next-session.md` overwritten each wrap-up. Old ones move to archive |
| `patterns/active/` (21 files) | Capped at 10. Demotion rule: no firing in 60d → `patterns/reference/` |
| Same rule in 6 places | Canonical home per rule type. Other places use anchor links, not restatements |

### 2.3 Read-side enforcement (the new piece)

The single most important architectural change. Add a **decision-time checkpoint** so rules fire at action-time, not just exist as text.

**Mechanism**: a new `pre-action.md` in the agent root, regenerated by the nightly dream. It contains the top-7 *currently relevant* rules for the current project + cwd + recent corrections. Memory-loader appends it to working memory. Most critically, it surfaces rules with action triggers:

```
BEFORE proposing options to JJ, check:
- Is this an external-DOM-drift case? → LLM-first, no manual selector patches
- Is this a HOW decision? → research + recommend, don't ask
- Is this a code-review round? → 4-reviewer parallel batch, not serial

BEFORE coding:
- On main? Cut a branch.
- Existing solution? Check Hermes / paperclip / installed deps first
- ≥10 lines? Run /planning-pipeline first

BEFORE writing a report:
- Caveman check: lead with plain explanation, tables > bullets > paragraphs
- Master Plan north star: 3-question drift test
```

This is what self-reflection meant by "make rules fire, not just exist."

---

## Section 3: The Nightly Dreaming Routine

> Modeled on Park et al. reflection + Anthropic auto-dream 4-phase + sleep-time compute literature + JJ's existing phase-gated review rule (worker + auditor) + archive-never-delete rule.

### 3.1 When it runs

- **Cadence**: Daily, 3 AM (post-day, pre-next-session)
- **Trigger gate** (dual): ≥24h since last dream AND ≥1 session in last 24h (skip on quiet days)
- **Mechanism**: launchd plist (extends existing `vault-automation` pattern at `system/scripts/vault-automation.js`)
- **Failsafe**: lock file prevents concurrent runs, max runtime 10 min

### 3.2 Five-phase algorithm (worker)

```
PHASE 0: SAFETY
  - git tag dream/pre/YYYY-MM-DD
  - Acquire lock file
  - Snapshot agents/claude-code-m4/ to archive/dreams/YYYY-MM-DD/

PHASE 1: REPLAY (Park et al. reflection)
  - Read today's learning-journals/<date>.md
  - Read top 20 lines of session-logs from past 24h
  - LLM prompt: "Given these events, what are the 3 most salient
    questions? Then: extract 5 high-importance insights."
  - Importance score 1-10 per insight (LLM-generated)

PHASE 2: ROUTE (consolidation)
  For each insight:
    - If importance ≥7 AND mentions an existing pattern → reinforce
      (bump sightings count, refresh latest_seen)
    - If importance ≥7 AND new but ≥3 prior journal mentions → promote
      to patterns/active/ candidate (queued for review)
    - If correction-flavored → append to corrections.md
    - If decision-flavored → write to decisions/<date>-<slug>.md
    - If status-update flavored → update working-memory.md last-session block

PHASE 3: PRUNE (importance × recency decay)
  - corrections.md: move RESOLVED entries >30d old → archive/corrections/
  - session-index.md: keep last 10 sessions only, archive rest
  - patterns/active/: demote any pattern not cited in 60 days → patterns/reference/
  - learning-journals/: today's file → archive/journals/YYYY-MM/
  - next-session-prompts/: keep latest only, archive older

PHASE 4: CONTRADICTIONS + DATES
  - Sweep relative dates ("yesterday", "last week") → ISO YYYY-MM-DD
  - Detect contradictory rules across hot tier → flag in dream-log
  - Verify "LIVE" status claims against ground truth (git, deployed state)
  - DO NOT auto-fix contradictions — surface for JJ review

PHASE 5: REBUILD INDEXES
  - Regenerate memory-index.md (warm tier topic map)
  - Regenerate pre-action.md (read-side checkpoint, top-7 rules for current state)
  - Append nightly entry to .dream-log.md
```

### 3.3 Auditor — TWO-STAGE, CROSS-MODEL (addresses MF-3)

Per JJ's phase-gated review rule + reviewer feedback that "same-model auditor has same blind spots." Audit is two stages, the second uses a different model family entirely:

```
STAGE A — DETERMINISTIC INVARIANTS (no LLM, runs first):
  - Schema check: every consolidated artifact has valid frontmatter
  - Line-count check: working-memory.md ≤80, pre-action.md ≤30,
    corrections.md ≤150, session-index.md ≤200
  - Anchor-link integrity: every [link](path) in regenerated files resolves
  - Archive integrity: every entry "moved to archive" appears in the
    archive's diff — exact line count match, no information loss
  - Pattern-firing-log freshness: log was written this session
  - Date normalization: no relative dates ("yesterday", "last week") remain
  - Source-citation check: every auto-promoted pattern in patterns/active/
    cites an exact line in a journal/correction that exists
  - On FAIL: PAUSE the run, surface to JJ next session, do NOT auto-rollback

STAGE B — /codex ADVERSARIAL AUDIT (cross-model, runs second):
  - Invoked via /codex skill (Codex CLI / GPT-5)
  - Prompt: "Adversarial audit of dream pass output at archive/dreams/<date>/.
    Worker says PASS. Find what's wrong. Specifically attack: hallucinated
    insights, fabricated source citations, sycophantic importance scoring,
    contradiction with existing patterns/active/, lost information, dates
    that don't match source files."
  - Cross-model property: Codex/GPT-5 has different training distribution
    than Claude worker — catches what same-model auditor would miss
  - Output: PASS / WARN-with-mitigation / FAIL + specific findings
  - On FAIL: PAUSE the run, surface to JJ next session, do NOT auto-rollback
  - On WARN: apply suggested mitigation, log to dream-log

Both stages must PASS for the dream commit to land. Stage A failures
mean structural break (probably a worker bug). Stage B failures mean
semantic break (probably an LLM hallucination).
```

### 3.4 Dream log format (audit trail)

`.dream-log.md` at agent root. Append-only. 10-second readable.

```markdown
## 2026-05-09 03:00 PASS

**Source signal**: 1 session, 14 journal entries, 3 corrections received.

**Insights extracted** (importance ≥7):
- [9] external-DOM-drift rule fired 3x today — reinforced, sightings=12
- [8] New pattern candidate: "verify LIVE claims against git, not memory" — 4 prior mentions, queued for JJ review at /memory-promote
- [7] Caveman check failed once today — counter +1, no rule change

**Routed**:
- 1 pattern reinforced: default_to_llm_for_external_dom_drift
- 1 pattern candidate queued
- 2 corrections appended (both resolved-on-arrival)
- 1 decision logged: 2026-05-09-bazaar-mercury-only-locked

**Pruned**:
- 12 lines aged out of corrections.md → archive/corrections/2026-05.md
- session-index.md compacted: 1126 → 198 lines
- 8 KB journals archived to archive/journals/2026-05/
- 1 next-session-prompt rotated

**Contradictions surfaced** (NOT auto-fixed):
- Phase-Gated review rounds: CLAUDE.md says 2-cap for plans; corrections.md
  has 3 entries celebrating 5-round reviews. JJ to decide canonical version.

**Auditor**: PASS. No information loss. Diff: archive/dreams/2026-05-09/diff.md
```

### 3.5 Why this is safe

1. **Archive-never-delete**: every prune moves to `archive/dreams/YYYY-MM-DD/`. Last 14 dream-tags retained for multi-night recovery.
2. **Atomic writes**: dream worker writes all hot/warm tier mutations to `*.tmp` files, then commits via atomic rename at end of run. Partial-failure leaves prior state intact. Memory-loader takes a read-lock; dream takes a write-lock.
3. **Two-stage audit**: (a) deterministic schema/invariant checks (line counts, frontmatter validity, anchor links, archive integrity) — these run BEFORE the LLM auditor, catch what same-model bias would miss; (b) LLM auditor for semantic / no-info-loss checks. Auditor FAIL → PAUSE the run, surface to JJ next session — does NOT auto-rollback.
4. **Contradictions surface, not auto-fix**: the LLM doesn't decide between contradicting rules — JJ does.
5. **Auto-promote with hard gates** (per locked decision 2 + engineering review fixes): max 1 promotion/night, must rank top-2 by importance among night's insights, must pass contradiction-check against existing patterns/active/, must cite exact source line in journal/correction. Promotions logged in `.dream-log.md`; JJ has 24h to `/memory-demote` before lock-in.
6. **Pattern-firing instrumentation**: wrap-up logs which `pre-action.md` rules were referenced/applied/violated each session into `pattern-firing-log.md`. Dream uses this for demotion gate (no fire in 60d → reference/) and for observability metrics. **Without this, demotion logic and rule-firing measurement are hand-wavy.**
7. **Lock file + idempotent**: re-running on same day is a no-op.

---

## Section 4: Implementation Plan (5 phases, ~2 weeks)

| Phase | What | Effort | Risk | Parallel? |
|---|---|---|---|---|
| **P1: Cleanup the hot path** | Fix #1 (corrections TTL) + Fix #2 (session-index tiering) + Fix #6 (context.md hard cap) — wrap-up linter changes | 4 hrs | Low | Sequential (foundation) |
| **P2: Connect the read path** | Fix #3 (wire learning-journal consumption) + Fix #4 (next-session-prompt rotation) — wrap-up + memory-loader changes | 3 hrs | Low | ‖ with P3 |
| **P3: Pattern hygiene** | Fix #5 (cap patterns/active/ at 10, demote rest) + Fix #7 (zombie feedback files) | 1 hr | Low | ‖ with P2 |
| **P4: Build the dream worker** | New skill `/dream` with 5-phase algorithm. Test manually on 2-3 days of journal data. | 6 hrs | Med | After P1+P2+P3 |
| **P5: Build the auditor + scheduling** | Auditor subagent + launchd plist + dream-log + pre-action.md generator | 4 hrs | Med | After P4 |

**Total**: ~18 hours of work. Phase 1 alone (4 hrs) reclaims ~1,200 lines of every-session context — the highest-leverage single deliverable.

---

## Section 5: Locked Decisions (2026-05-08)

1. **Hot tier cap**: ✅ STRICT 80 lines for working-memory.md. Wrap-up linter fails the session if over.

2. **Pattern promotion**: ✅ AUTO-MERGE driven by dream reflection. The dream's reflection phase IS the judge — Claude assesses fit, evidence count, contradiction with existing patterns, and merges when warranted. No JJ approval queue. JJ revokes via `/memory-demote <pattern>` if wrong. Promotions logged in `.dream-log.md` so JJ can scan nightly outputs and catch bad calls.

3. **Dream cadence**: ✅ NIGHTLY 3 AM, dual-gate (≥24h since last AND ≥1 session in last 24h). Skip on quiet days.

4. **Cloud-mode boundary**: ✅ Cloud routine sessions (Dispatch, GitHub cloud agents) run STATELESS — task spec in, result out via PR/git. NO memory shipped to cloud. NO cross-project memory sharing. The M4 vault is local-only and never travels. Privacy/security boundary is hard: private-project memory cannot leak into public-project cloud sessions, ever. Merge of cloud work happens locally on M4 (review the PR, merge as normal); the next nightly dream pass on M4 absorbs the merged work into vault memory normally. This means the implementation plan stays at ~18 hrs (P3-P5 cloud-distribution work removed).

---

## Section 6: Engineering Review Findings (2026-05-08)

> Two parallel reviewers (fresh-context Claude senior engineer + Codex adversarial). Both reviewers independently flagged the same critical contradiction. Round 1 review captured here; round 2 will run after the fixes below land in P0 prep.

### Round 1 Verdict

**Codex**: 7 blocking issues + 5 non-blocking. **Senior Claude eng**: APPROVE-WITH-CHANGES, 5 must-fix + 5 should-fix. Convergent on 4 issues.

### Convergent Must-Fixes (both reviewers)

**MF-1: Auto-merge contradicts the 10-pattern cap.** With LLM scoring drift + ≥7 importance gate, the system promotes ~5/night. Cap blown in 2-3 days OR good patterns get silently demoted. **Fix**: add hard gates — max 1 promotion/night, must rank top-2 by importance, must pass contradiction-check, must cite exact source line. JJ has 24h post-dream to `/memory-demote`. Locked decision 2 stays AUTO-MERGE but with throttle.

**MF-2: No transaction model.** Crash mid-prune leaves corrupted hot tier. **Fix**: atomic `*.tmp` + rename, write-lock for dream / read-lock for memory-loader.

**MF-3: Auditor not independent enough.** Same model family = same blind spots. **Fix**: deterministic invariant checks (schema, line counts, frontmatter, anchor links) run BEFORE LLM audit. LLM audit becomes second-line.

**MF-4: No eval harness for rule-firing — THE BIGGEST GAP.** The whole premise (rules don't fire) has no instrumentation that records when they DO fire. Without this, demotion gate is hand-wavy and observability collapses. **Fix**: new `pattern-firing-log.md` written by wrap-up each session — which pre-action.md rules referenced/applied/violated. P3 dependency.

### Other Must-Fixes (one reviewer flagged)

**MF-5** (Codex): Phase 0 git safety assumes clean worktree. Vault has Obsidian sync + untracked memory artifacts. → preflight clean/dirty handling, untracked-file capture.

**MF-6** (Claude eng): P3 (cap patterns/active at 10 + demote) is **redundant with P4 Phase 3**. → drop P3 or scope to one-time manual cleanup explicitly.

**MF-7** (Claude eng): pre-action.md needs fallback path when cwd unknown to dream. → fallback to global top-7 by frequency.

**MF-8** (Claude eng): pre-action.md needs OWN 30-line budget separate from working-memory.md's 80. Don't double-count.

**MF-9** (Claude eng): Auditor FAIL must NOT auto-rollback. → pause + surface to JJ. Auto-rollback is too aggressive (false positives stop the system).

**MF-10** (Codex): "Read top 20 lines of session logs" is wrong signal — corrections often appear at end. → read full session log entries with [correction]/[mistake]/[method-worked] markers.

**MF-11** (both): Effort estimates too optimistic. P4 realistic 12-16h not 6h. P5 realistic 6-8h not 4h. **Revised total: 25-35h, not 18h.**

### Should-Fixes (deferred to P5+)

- Multi-night rollback story: keep last 14 dream-tags, build session-log replay tool
- Weekly dream digest (`dream-log-weekly.md`)
- Calibration prompt (show LLM 30-day score distribution before scoring)
- Phase 1 prompt: "up to 5 insights" not "5" (avoid quota hallucination)
- Catch-up semantics for launchd missing 3 AM (MacBook sleep)
- Filter cloud-PR-derived signals (don't promote pseudo-lessons from code commits)

### What Both Reviewers Agreed Plan Got Right

Diagnosis is sharp (capture-without-retrieval). 3-tier architecture is sound (MemGPT + Park + Anthropic synthesis). Read-side enforcement via pre-action.md is the right structural fix. Archive-never-delete + auditor + contradiction-surfacing are correct safety primitives.

---

## Section 7: Revised Implementation Plan (post-review)

| Phase | What (revised) | Effort | Dependencies | Parallel |
|---|---|---|---|---|
| **P0: Prep** (NEW) | Co-design archive schema + pattern-firing-log format + atomicity contract. Update memory-loader spec to load pre-action.md. | 2h | none | foundation |
| **P1: Hot-path cleanup** | corrections.md TTL + session-index tiering + working-memory.md 80-cap + wrap-up linter + atomic-write helpers | 6-8h | P0 | foundation |
| **P2: Read path + instrumentation** | learning-journal consumption contract + next-session-prompt rotation + **pattern-firing-log.md** infrastructure (the MF-4 fix) | 4-5h | P1 | ‖ P3 |
| **P3: Pattern hygiene** (de-scoped) | One-time manual cleanup: cap to 10, archive zombie feedback files. **No automation here** — auto-demotion lives in P4 dream Phase 3. | 1h | P1 | ‖ P2 |
| **P4: Build /dream worker** | 5-phase algorithm + atomic writes + git-safety preflight + hard auto-promote gates + deterministic invariant checks | 12-16h | P1+P2+P3 | sequential |
| **P5: Auditor + scheduling + observability** | Two-stage audit (invariant-first, LLM-second) + launchd with catch-up semantics + pre-action.md generator with fallback + weekly digest | 6-8h | P4 | sequential |

**Revised total: 31-40h** (was 18h). P4 is the balloon as both reviewers predicted.

### Phase-Gated Review Round 2 (mandatory before P4)

After P0+P1+P2+P3 land, before P4 starts: re-run parallel reviewer batch (fresh Claude + Codex) on the implementation, not the plan. Both must PASS or WARN-with-applied-mitigation. Per JJ's MANDATORY phase-gated review rule for code: 4-reviewer parallel batch (code-reviewer + reality-checker + coverage + Codex), repeat until all PASS-clean + tests green.

### Success Criteria Reference

Full success criteria document at [memory-redesign-success-criteria.md](memory-redesign-success-criteria.md). Each phase has: Done Definition (binary verifiable), Failure Modes Covered (with detector tests), Rollback Signal. Plus Cross-Phase Acceptance Tests (XPT-1 through XPT-5) and Sign-Off Gate.

---

## Section 8: Portability — `dream-management` as Standalone Skill

### Why portable

JJ may want to use this dream system for other projects (code repos, future agents, possibly other people's setups). Building it tightly coupled to her current vault layout would mean rebuilding from scratch each time. Instead: build once, configure per-consumer.

### Repo: https://github.com/joydai2026-del/dream-management

Local checkout: `~/dev/dream-management/`

### Architecture

```
dream-management/
├── README.md                       — concept + adoption guide
├── ARCHITECTURE.md                 — design (this doc, distilled)
├── ADR/                            — locked decisions (one file each)
│   ├── 001-3-tier-memory.md
│   ├── 002-auto-merge-with-gates.md
│   ├── 003-cross-model-auditor.md
│   ├── 004-archive-never-delete.md
│   └── 005-cloud-stateless-boundary.md
├── dream.config.example.json       — per-consumer adapter config
├── skill/
│   └── SKILL.md                    — Claude Code skill entrypoint
├── lib/
│   ├── dream-worker.js             — 5-phase worker (atomic writes)
│   ├── auditor-invariants.js       — Stage A deterministic checks
│   ├── auditor-codex.sh            — Stage B /codex wrapper
│   ├── pattern-firing-log.js       — instrumentation library
│   ├── memory-tier.js              — hot/warm/cold tier abstractions
│   └── git-safety.js               — preflight clean/dirty handling
├── hooks/
│   └── wrapup-hook.js              — what wrapup writes to feed dream
├── schedulers/
│   ├── launchd.plist.template      — macOS (JJ's M4 + future Macs)
│   ├── systemd.service.template    — Linux (M1 OpenClaw box, VPS)
│   └── cron.template               — generic Unix
├── templates/
│   ├── working-memory.template.md
│   ├── pre-action.template.md
│   └── dream-log.template.md
├── tests/
│   ├── golden/                     — fixtures: known-input → expected-output
│   └── eval-harness/               — rule-firing regression suite (MF-4)
└── docs/
    ├── adoption-guide.md
    ├── config-reference.md
    └── failure-modes.md
```

### Per-consumer config (`dream.config.json`)

```json
{
  "consumer_name": "claude-code-m4-vault",
  "memory_root": "/Users/joyd/Documents/jj-knowledge-vault/agents/claude-code-m4",
  "tiers": {
    "hot": {
      "working_memory": "working-memory.md",
      "patterns_active": "patterns/active/",
      "pre_action": "pre-action.md",
      "max_lines": 80
    },
    "warm": {
      "corrections": "corrections.md",
      "session_index": "session-index.md",
      "memory_index": "memory-index.md"
    },
    "cold": {
      "archive_root": "archive/",
      "session_logs": "session-logs/"
    },
    "episodic": {
      "learning_journal_today": "learning-journals/{{YYYY-MM-DD}}.md"
    }
  },
  "schedule": { "cron": "0 3 * * *", "dual_gate_min_sessions": 1 },
  "promotion_gates": {
    "max_per_night": 1,
    "min_importance": 7,
    "min_journal_mentions": 3,
    "require_source_citation": true,
    "require_contradiction_check": true
  },
  "audit": {
    "stage_a_invariants": "lib/auditor-invariants.js",
    "stage_b_command": "codex exec --skip-git-repo-check"
  },
  "rollback": { "keep_last_n_tags": 14 }
}
```

### Sync from vault → repo

Locked decisions, success criteria, and architecture diagrams live in the **repo as canonical**. Vault has a copy in `inbox/` for now (this doc) but final version migrates to `~/dev/dream-management/ARCHITECTURE.md` + `ADR/` files. JJ's existing pattern: "Always push skills to GitHub" (from MEMORY.md feedback) — this skill follows that pattern.

### Adoption checklist (for any future project)

1. Clone `dream-management` repo as a sibling
2. Write `dream.config.json` for the consumer
3. Run `dream-management install --config ./dream.config.json` (scaffolds memory tiers, adds wrapup-hook to consumer's wrap-up flow)
4. Add scheduler entry from `schedulers/` template
5. First night runs in DRY-RUN mode; JJ approves; subsequent nights commit

### Privacy / security

Each consumer has its own config + memory root. No cross-consumer memory access. The skill itself contains no JJ-specific content — only mechanisms. Safe to make repo public if/when polished. For now: start private, open-source after v1.0 ships.

---

## Sources Cited

**Internal**:
- Senior architect audit (this session, agent ac158186)
- Self-reflection report (this session, agent a5e39466)
- Best-practices research (this session, agent a9136e5c)
- Current state: `~/Documents/jj-knowledge-vault/agents/claude-code-m4/` + `~/.claude/projects/-Users-joyd-Documents-jj-knowledge-vault/memory/`

**External**:
- [MemGPT (arXiv:2310.08560)](https://arxiv.org/abs/2310.08560) — three-tier memory hierarchy
- [Generative Agents (arXiv:2304.03442)](https://arxiv.org/abs/2304.03442) — reflection + importance scoring (canonical reference)
- [Voyager (arXiv:2305.16291)](https://arxiv.org/abs/2305.16291) — skill library as procedural memory
- [Sleep-time Compute (arXiv:2504.13171)](https://arxiv.org/abs/2504.13171) — Berkeley + Letta, 5× token reduction
- [Memory in the Age of AI Agents (arXiv:2512.13564)](https://arxiv.org/abs/2512.13564) — survey + CoALA framework
- [Anthropic auto-dream feature](https://claudefa.st/blog/guide/mechanics/auto-dream) — 4-phase algorithm + dual-gate
- [dream-skill community implementation](https://github.com/grandamenium/dream-skill)
- [auto-dream gaps issue #38493](https://github.com/anthropics/claude-code/issues/38493) — what NOT to inherit

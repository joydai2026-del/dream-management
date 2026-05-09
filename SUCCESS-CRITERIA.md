# Memory System Redesign — Success Criteria

> Companion to `inbox/memory-system-redesign-2026-05-08.md`. Each phase has binary done-criteria, verification commands, failure modes with detector tests, and a rollback signal.

**Conventions used below**:
- `AGENT_DIR` = `~/Documents/jj-knowledge-vault/agents/claude-code-m4`
- `GLOBAL_MEM` = `~/.claude/projects/-Users-joyd-Documents-jj-knowledge-vault/memory`
- All `wc -l` counts are post-phase, run on M4.

---

## P1: Hot-Path Cleanup

Goal: shrink the every-session read load. corrections.md, session-index.md, and working-memory.md (renamed from context.md) all hit hard caps. Wrap-up linter blocks regression.

### Done Definition

| # | Criterion | Verification |
|---|-----------|--------------|
| 1 | `working-memory.md` exists at `AGENT_DIR/working-memory.md` and is ≤80 lines | `wc -l ~/Documents/jj-knowledge-vault/agents/claude-code-m4/working-memory.md` returns ≤80 |
| 2 | Old `context.md` either renamed to `working-memory.md` or replaced by a redirect stub ≤5 lines | `wc -l AGENT_DIR/context.md` returns ≤5 AND first line contains "redirect" or "moved" |
| 3 | `corrections.md` ≤150 lines AND every entry is either UNRESOLVED or dated within 30 days | `wc -l AGENT_DIR/corrections.md` ≤150 AND `grep -E '^- \[2026-0[34]' AGENT_DIR/corrections.md \| wc -l` returns 0 (no entries older than 30d unless UNRESOLVED) |
| 4 | `session-index.md` ≤200 lines AND contains exactly the last 10 sessions (by date header count) | `wc -l AGENT_DIR/session-index.md` ≤200 AND `grep -cE '^### 2026-' AGENT_DIR/session-index.md` returns ≤10 (note: live file uses H3 not H2 for session entries; original draft of this row had `^## 2026-` but the live convention is `^### 2026-`) |
| 5 | `archive/corrections/` and `archive/sessions/` directories exist and contain the moved content | `ls AGENT_DIR/archive/corrections/` and `ls AGENT_DIR/archive/sessions/` both non-empty; total archived line count ≥ count moved out of source files |
| 6 | Wrap-up linter exists and fails when `working-memory.md` >80 lines | Run `node system/scripts/wrapup-lint.js --check working-memory` against an 81-line fixture; exits non-zero |
| 7 | Linter is wired into the `/wrap-up` skill flow (invoked before commit) | `grep -l 'wrapup-lint' ~/.claude/skills/wrap-up/SKILL.md ~/.claude/skills/wrapup/SKILL.md 2>/dev/null` returns at least one match |

### Failure Modes Covered

| Risk | Test |
|------|------|
| RESOLVED entries deleted instead of archived | After P1, `wc -l AGENT_DIR/archive/corrections/*.md \| tail -1` ≥ (pre-P1 corrections.md lines − post-P1 corrections.md lines). Diff must be conserved. |
| working-memory.md gets truncated mid-paragraph leaving dangling refs | `grep -E '\[\[[^]]+$' AGENT_DIR/working-memory.md` returns 0 hits (no unclosed wikilinks); markdown lint passes |
| session-index.md loses the most recent sessions while keeping older ones | `head -1 $(ls -t AGENT_DIR/session-logs/*.md \| head -1)` date appears in `AGENT_DIR/session-index.md` |
| Linter silently passes on missing file | Run linter against a path with no `working-memory.md`; exits non-zero with explicit "file not found" |

### Rollback Signal

Any of: `working-memory.md` >80 lines after wrap-up despite linter, archive line-count conservation fails (data loss), or `/memory-loader` errors when reading the new layout. Revert command: `git revert <P1-commit-sha>` and restore from `archive/dreams/<pre-P1-snapshot>/` if dream-archive ran.

---

## P2: Wire Learning-Journal Consumption

Goal: today's learning journal becomes a real input to wrap-up + next-session prompt. next-session prompts collapse from 23 files to 1 overwriting file.

### Done Definition

| # | Criterion | Verification |
|---|-----------|--------------|
| 1 | `/wrap-up` reads `learning-journals/<today>.md` and writes a distilled summary into the session log | After running `/wrap-up`, the session log contains a "Journal Distilled" section AND its line count is ≤30 |
| 2 | Single `next-session.md` exists at `AGENT_DIR/next-session.md` (not under `next-session-prompts/`) | `test -f AGENT_DIR/next-session.md && echo OK` prints OK |
| 3 | Old `next-session-prompts/` files moved to `archive/next-session-prompts/` (not deleted) | `ls AGENT_DIR/next-session-prompts/*.md 2>/dev/null \| wc -l` returns 0 AND `ls AGENT_DIR/archive/next-session-prompts/*.md \| wc -l` returns ≥22 |
| 4 | `/memory-loader` reads `next-session.md` AND today's journal at session start | `grep -E '(next-session\.md\|learning-journals.*today)' ~/.claude/skills/memory-loader/SKILL.md` returns ≥2 hits |
| 5 | Next-session prompt is overwritten (not appended) by `/wrap-up` | Run `/wrap-up` twice with different fixtures; final `next-session.md` matches the second run only |

### Failure Modes Covered

| Risk | Test |
|------|------|
| Journal read but never distilled (capture without retrieval, the original flaw) | Session log post-P2 must contain a "Journal Distilled" header AND ≥1 bullet referencing journal entries |
| Old next-session prompts deleted instead of archived | `ls archive/next-session-prompts/ \| wc -l` ≥22 (count from pre-P2 inventory) |
| memory-loader fails when no journal exists for today | Run `/memory-loader` on a day with no journal file; exits 0 with a "no journal today" log line, not an error |

### Rollback Signal

`/wrap-up` runs but session log has no Journal Distilled section, OR `next-session.md` accumulates content across runs (not overwritten), OR memory-loader errors on missing journal. Revert: `git revert <P2-commit-sha>`.

---

## P3: Pattern Hygiene

Goal: `patterns/active/` capped at 10. Stale patterns demoted to `patterns/reference/`. 8 zombie feedback files removed from `GLOBAL_MEM`.

### Done Definition

| # | Criterion | Verification |
|---|-----------|--------------|
| 1 | `patterns/active/` contains ≤10 files | `ls AGENT_DIR/patterns/active/*.md \| wc -l` returns ≤10 |
| 2 | `patterns/reference/` exists and contains every pattern not fired in 60 days | `ls AGENT_DIR/patterns/reference/*.md \| wc -l` ≥11. Note: 2026-05-09 first cleanup demoted 16 from 23 active+root tier (13 from active, 3 from root reconciliation); pre-spec reference files preserved separately (grandfathered). See ADR 008 for full breakdown. |
| 3 | Each pattern demoted as part of THIS P3 cleanup (frontmatter has `demotion_phase: p3-2026-05-09`) has `last_fired:` ≥60 days old **OR** `bootstrap: true` with proxy-derived `last_fired:` (one-time bootstrap concession only for the 2026-05-09 cleanup, before firing-log accrual under § 5/6 of `docs/pattern-firing-log-spec.md`). Pre-spec demotions (files in `reference/` without `demotion_phase:`) are grandfathered out-of-scope; reconciliation-merge files (with `reconciliation_merged_at:` only, no `demotion_phase:`) are also out-of-scope. | Run `bash scripts/verify-p3-3.sh AGENT_DIR/patterns/reference/` — exits 0 with `OK 16/16` only when all 16 today's-demotions satisfy (a) OR (b); exits 1 with explicit `FAIL: <file> <reason>` lines on any violation. Asserts: scoped count = 16 AND each file has `last_fired:` AND (date ≤2026-03-08 OR `bootstrap: true` + `bootstrap_at: 2026-05-09` + `bootstrap_method:`). |
| 4 | The 8 named zombie feedback files in `GLOBAL_MEM` are removed (archived, not deleted) | `ls GLOBAL_MEM/feedback_*.md 2>/dev/null \| wc -l` decreased by 8 from baseline; `ls GLOBAL_MEM/archive/ \| wc -l` ≥8 |
| 5 | `MEMORY.md` references to removed feedback files are updated or removed (no broken links) | `for ref in $(grep -oE 'feedback_[a-z_]+\.md' GLOBAL_MEM/MEMORY.md); do test -f GLOBAL_MEM/$ref \|\| echo "BROKEN: $ref"; done` outputs nothing |

### Failure Modes Covered

| Risk | Test |
|------|------|
| Pattern demoted but its rule still cited from working-memory.md or CLAUDE.md (orphan reference) | `for p in $(ls AGENT_DIR/patterns/reference/); do grep -l "$(basename $p .md)" AGENT_DIR/working-memory.md ~/.claude/CLAUDE.md; done` — if hits, orphan ref must be replaced with link to reference/ path |
| Active patterns culled by recency only, losing high-importance low-frequency ones | Each remaining `patterns/active/` file has `importance:` ≥7 OR `sightings:` ≥10. Spot-check 3 random files manually. |
| Zombie feedback files actually still referenced by an active workflow | `grep -rE '(feedback_[a-z_]+)' ~/.claude/skills/ \| grep -E '(removed-files)'` returns 0 |

### Rollback Signal

Any reference broken in MEMORY.md or CLAUDE.md, OR an active pattern's behavior stops firing in subsequent sessions (check via 1-week dream-log diff). Revert: `mv archive/patterns-active/* patterns/active/` + `git revert <P3-commit-sha>`.

---

## P4: Build /dream Worker

Goal: 5-phase nightly worker (Safety → Replay → Route → Prune → Contradictions → Rebuild). Auto-promotion uses importance scoring. Audit trail in `.dream-log.md`. Lock file + git tag pre-dream.

### Done Definition

| # | Criterion | Verification |
|---|-----------|--------------|
| 1 | `/dream` skill exists at `~/.claude/skills/dream/SKILL.md` and references all 5 phases | `grep -cE '^## (PHASE 0\|PHASE 1\|PHASE 2\|PHASE 3\|PHASE 4\|PHASE 5)' ~/.claude/skills/dream/SKILL.md` returns ≥6 |
| 2 | Dry run on 2-3 days of journal data produces a valid `.dream-log.md` entry | `node system/scripts/dream.js --dry-run --since 2026-05-05` exits 0 AND emits a parseable dream-log entry to stdout |
| 3 | Pre-dream git tag is created in format `dream/pre/YYYY-MM-DD` | After live run: `git tag -l 'dream/pre/2026-*' \| wc -l` increments by 1 |
| 4 | Lock file at `AGENT_DIR/.dream.lock` prevents concurrent runs | Start two `dream.js` processes; second exits non-zero within 2s with "lock held" message |
| 5 | Snapshot of `AGENT_DIR/` is written to `archive/dreams/YYYY-MM-DD/` before any mutation | `ls archive/dreams/<run-date>/` non-empty AND contains `working-memory.md`, `corrections.md`, `session-index.md`, `patterns/` |
| 6 | Auto-promotion rule fires only when (importance ≥7 AND ≥3 prior journal mentions); each promotion logged with rationale in `.dream-log.md` | Inject a fixture with one qualifying + one non-qualifying candidate; only the qualifying one appears in `patterns/active/` AND the dream-log lists rationale + source mentions |
| 7 | Contradictions are surfaced (NOT auto-fixed) in the dream-log under a "Contradictions surfaced" section | Run with a fixture containing contradictory rules; both rules remain unchanged on disk AND dream-log lists both with file paths |
| 8 | Max runtime 10 min enforced; aborted runs leave no partial mutation (lock released, no orphan tags) | `timeout 600 node dream.js --simulate-slow` — process killed, lock file gone, no partial diff in working-memory.md |

### Failure Modes Covered

| Risk | Test |
|------|------|
| Auto-promotion adds low-evidence patterns (the original anti-goal of "no JJ approval queue" gone wrong) | Fixture with 1 mention + importance 9 → must NOT promote. Audit dream-log "promotion declined" reason cites mention-count gate. |
| Prune phase deletes content not present in archive snapshot | After run: `diff <(cat archive/dreams/<date>/corrections.md) <(cat AGENT_DIR/corrections.md AGENT_DIR/archive/corrections/<date>.md)` shows no missing lines. Conservation invariant. |
| Dream rewrites a file mid-crash, leaving corrupt markdown | Kill `dream.js` mid-Phase 3; verify all hot-tier files still parse as markdown (`markdownlint AGENT_DIR/working-memory.md` exits 0) and lock is released |
| Relative-date sweep mangles intentional relative phrasing inside quoted text | Fixture with a quoted block containing "yesterday" inside backticks → unchanged after run |
| Contradiction detector silently auto-fixes (violating Section 5 decision #2 spirit on contradictions) | Run with contradicting rules; `git diff` on rule files shows zero changes; dream-log surfaces both |

### Rollback Signal

Any of: dream-log shows PASS but spot-check of `archive/dreams/<date>/` misses a file from `AGENT_DIR/`; auto-promoted pattern has <3 journal mentions; lock file orphaned after crash. Rollback command (printed in dream-log on FAIL): `git reset --hard dream/pre/YYYY-MM-DD && rm -f AGENT_DIR/.dream.lock`.

---

## P5: Auditor + Scheduling

Goal: fresh-context auditor subagent runs after worker. launchd plist fires nightly 3 AM with dual-gate. `pre-action.md` regenerated nightly. PASS/FAIL output includes rollback command on FAIL.

### Done Definition

| # | Criterion | Verification |
|---|-----------|--------------|
| 1 | Auditor runs as fresh subagent (no shared context with worker) | Code path uses `Task` tool with `subagent_type: general-purpose` and a fresh prompt — verified by `grep -E 'subagent\|fresh.context' ~/.claude/skills/dream/SKILL.md` returns ≥1 |
| 2 | Auditor verifies (a) information conservation, (b) source-file grounding, (c) corrections-archive received moves, (d) pre-action.md cites source files, (e) 3 random pattern promotions have rationale | Audit run on a fixture with a deliberately-broken promotion (no rationale) → auditor outputs FAIL AND identifies that promotion |
| 3 | launchd plist installed at `~/Library/LaunchAgents/com.jj.dream.plist` and loaded | `launchctl list \| grep com.jj.dream` returns one line; `plutil -lint ~/Library/LaunchAgents/com.jj.dream.plist` returns OK |
| 4 | Plist schedule is 3 AM daily | `plutil -extract StartCalendarInterval xml1 -o - ~/Library/LaunchAgents/com.jj.dream.plist` shows Hour=3 Minute=0 |
| 5 | Dual-gate enforced: skips run when (last-dream <24h ago) OR (zero sessions in 24h) | Two fixtures: (a) last-dream 23h ago → skip with reason logged; (b) last-dream 25h ago AND no session logs in 24h → skip with reason logged. Both observable in `.dream-log.md` as `## YYYY-MM-DD 03:00 SKIP` entries |
| 6 | `pre-action.md` regenerated nightly at `AGENT_DIR/pre-action.md`, ≤7 rules, each rule cites a source file path | `wc -l AGENT_DIR/pre-action.md` ≤80; `grep -cE '\(source: .+\.md\)' AGENT_DIR/pre-action.md` ≥ rule-count |
| 7 | On FAIL, dream-log entry includes literal rollback command starting `git reset --hard dream/pre/` | Force a FAIL via auditor fixture; `tail -50 AGENT_DIR/.dream-log.md \| grep 'git reset --hard dream/pre/'` returns ≥1 |
| 8 | EnvironmentVariables in plist include `/opt/homebrew/bin` in PATH (lesson from 2026-04-19 wiki-daemon fix) | `plutil -extract EnvironmentVariables.PATH xml1 -o - ~/Library/LaunchAgents/com.jj.dream.plist` contains `/opt/homebrew/bin` |

### Failure Modes Covered

| Risk | Test |
|------|------|
| Auditor shares worker context (loses independence — the whole point of fresh-context review) | Inject a worker-side hallucinated promotion; auditor must catch it. If auditor PASSes a known-bad fixture, fail this criterion. |
| launchd silently skips runs because of PATH (repeat of 2026-04-19 raw-sweep regression) | Manual `launchctl start com.jj.dream` produces a dream-log entry within 60s |
| pre-action.md drifts from actual top-7 rules (becomes stale text again, recreating the original flaw) | Auditor verifies every rule in `pre-action.md` was either fired or cited in the last 7 days of journal/corrections; otherwise FAIL |
| Dual-gate logic inverted (runs when it should skip) | Fixture: last-dream 1h ago → must SKIP. If RUN, FAIL. |
| FAIL path doesn't actually surface to JJ at next session start | `/memory-loader` reads `.dream-log.md` last-entry; if it's FAIL, prints a banner. Test: force a FAIL, run `/memory-loader`, banner appears. |

### Rollback Signal

Any of: 3 consecutive dream runs FAIL the auditor; launchd shows the job loaded but no dream-log entries appear over 48h; pre-action.md cites source files that no longer exist. Disable command: `launchctl unload ~/Library/LaunchAgents/com.jj.dream.plist`. Then revert P5 commit; P1-P4 stay live.

---

## Cross-Phase Acceptance Tests

These run AFTER all 5 phases land. They prove the system works end-to-end, not just per-phase.

### XPT-1: Token budget at session start

| Step | Expected |
|------|----------|
| Run `/memory-loader` from a clean session | Total tokens loaded from hot tier ≤500 (count via `wc -w` of working-memory.md + identity.md + active patterns + pre-action.md, divide ~0.75) |

Verification: `wc -w AGENT_DIR/working-memory.md AGENT_DIR/pre-action.md AGENT_DIR/patterns/active/*.md \| tail -1` returns word count whose token equivalent is ≤500.

### XPT-2: One-week consolidation cycle

| Step | Expected |
|------|----------|
| Let 7 nightly dreams run | `.dream-log.md` has 7 entries OR explicit SKIP reasons for missing days |
| After 7 days, working-memory.md still ≤80 lines | `wc -l AGENT_DIR/working-memory.md` ≤80 |
| corrections.md still ≤150 lines | `wc -l AGENT_DIR/corrections.md` ≤150 |
| At least 1 pattern reinforcement OR 1 promotion logged | `grep -cE '(reinforced\|promoted)' AGENT_DIR/.dream-log.md` ≥1 |

### XPT-3: Rules fire at decision time (the original flaw fixed)

| Step | Expected |
|------|----------|
| Start a session in a project repo where `external-DOM-drift` rule applies | `pre-action.md` lists the rule with its action trigger |
| Trigger a borderline scenario in conversation | The rule's trigger phrasing appears verbatim in Claude's reasoning before the recommendation |

Verification: manual smoke test with a fixture conversation; rule citation must appear before the recommendation, not as a post-hoc justification.

### XPT-4: Archive-never-delete invariant holds

| Step | Expected |
|------|----------|
| Sum lines across all `archive/**/*.md` files | ≥ baseline-lines − current-hot-tier-lines (no information loss across full pipeline) |

Verification: `find AGENT_DIR/archive -name '*.md' -exec wc -l {} + \| tail -1` ≥ (pre-redesign total lines − post-redesign hot-tier total lines).

### XPT-5: Crash recovery

| Step | Expected |
|------|----------|
| Kill `dream.js` mid-run | Lock released within 60s of next launchd tick OR by next session start |
| Re-run `/dream` | Detects partial state, completes idempotently, no double-archive |
| Verify hot-tier files all parse as markdown | `for f in AGENT_DIR/{working-memory,corrections,session-index}.md; do markdownlint $f \|\| echo FAIL; done` outputs nothing |

---

## Sign-Off Gate

Before marking the redesign done, ALL of the following must be true on a single observation:

- P1-P5 done-definition tables: every row verified
- 7 consecutive nightly dream runs PASS the auditor
- One real (not fixture) pattern promotion has occurred AND survived 1 week without `/memory-demote`
- JJ confirms in a session that `pre-action.md` content matches what felt like "top-of-mind rules" that day

If any of those fails, the corresponding phase is rolled back per its rollback signal and re-shipped.

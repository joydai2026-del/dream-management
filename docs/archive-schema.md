---
title: Archive Schema
status: P0 contract — locked once JJ approves
audience: implementers (P1-P5), auditors
related:
  - ADR/004-archive-never-delete.md
  - ADR/003-cross-model-auditor.md
  - SUCCESS-CRITERIA.md (P4 criteria #5, P4 failure-mode "Prune phase deletes content not present in archive snapshot", XPT-4)
date: 2026-05-08
---

# Archive Schema

This document specifies the on-disk structure of `archive/` under any consumer's `memory_root`. It is the contract that the dream worker writes to and that the auditor diffs against.

The single invariant: **every byte that leaves a hot- or warm-tier file appears in archive/, with provenance**. A line removed from `corrections.md` must show up in `archive/corrections/YYYY-MM.md`. A snapshot taken before a dream pass must contain every hot- and warm-tier file as it existed at that moment. The auditor verifies this.

---

## 1. Top-level layout

Under each consumer's `memory_root`:

```
<memory_root>/
├── archive/
│   ├── dreams/                        # Per-night pre-mutation snapshots (ADR 004)
│   │   └── YYYY-MM-DD/
│   ├── sessions/                      # Session logs >14 days old
│   │   └── YYYY-MM/
│   ├── corrections/                   # RESOLVED corrections >30 days old
│   │   └── YYYY-MM.md
│   ├── journals/                      # Learning journals after consolidation
│   │   └── YYYY-MM/
│   ├── next-session-prompts/          # Old next-session prompts (one current file replaces them)
│   │   └── YYYY-MM-DD-<slug>.md
│   └── patterns/                      # Patterns demoted from active/, distinct from patterns/reference/
│       └── YYYY-MM-DD/
└── ...
```

`patterns/reference/` is **not** under `archive/` — demoted patterns are still part of the live codebase, just inactive (consumed lazily by the auditor when a referenced pattern fires). `archive/patterns/` is for full retirement (deleted from active/, zero references for 90+ days). The dream worker only writes to `patterns/reference/`; `archive/patterns/` is reserved for human-driven retirement and is rarely written.

All archive paths are relative to `memory_root` and overridable via `dream.config.json`'s `tiers.cold.archive_root`. Defaults shown above.

---

## 2. Per-night dream snapshot — `archive/dreams/YYYY-MM-DD/`

Created in **Phase 0 (SAFETY)** of the dream worker, before any mutation. This is the rollback point that pairs with `git tag dream/pre/YYYY-MM-DD`.

### 2.1 Directory contents

```
archive/dreams/2026-05-09/
├── manifest.json                        # See §2.2
├── event.json                           # Machine-readable canonical run record (§2.5)
├── snapshot/                            # Full pre-mutation copy of hot + warm tier
│   ├── working-memory.md
│   ├── identity.md
│   ├── pre-action.md                    # Absent on first night (created in P5)
│   ├── corrections.md
│   ├── session-index.md
│   ├── memory-index.md
│   ├── pattern-firing-log.md
│   ├── patterns/
│   │   ├── active/*.md
│   │   └── reference/*.md
│   └── decisions/                       # Symlink, NOT a copy — decisions/ is append-only and never pruned
├── diff.md                              # Human-readable summary of what the dream changed (Phase 5 output)
├── dream-log-entry.md                   # Human-readable summary appended to .dream-log.md
└── staged/                              # *.tmp files written by worker; deleted once committed (§2.4)
    ├── working-memory.md.tmp
    └── ...
```

### 2.2 `manifest.json` schema

```json
{
  "schema_version": "1.0.0",
  "consumer_name": "claude-code-m4-vault",
  "snapshot_at": "2026-05-09T03:00:14-04:00",
  "git_tag": "dream/pre/2026-05-09",
  "git_head_before": "f7f6188...",
  "memory_root": "/Users/joyd/Documents/jj-knowledge-vault/agents/claude-code-m4",
  "files": [
    {
      "path": "working-memory.md",
      "tier": "hot",
      "lines": 78,
      "bytes": 4123,
      "sha256": "ab12...",
      "mtime": "2026-05-08T22:14:09-04:00"
    },
    {
      "path": "corrections.md",
      "tier": "warm",
      "lines": 502,
      "bytes": 102567,
      "sha256": "cd34...",
      "mtime": "2026-05-08T14:51:02-04:00"
    }
    // ... one entry per snapshotted file
  ],
  "totals": {
    "hot_tier_lines": 78,
    "warm_tier_lines": 1845,
    "patterns_active_count": 22,
    "patterns_reference_count": 14
  }
}
```

`schema_version` is bumped on any breaking change. Auditor reads `schema_version` and refuses to run on unknown majors.

`sha256` enables the auditor to confirm snapshot integrity after the run. Hashes are over file contents only (no metadata), computed on read.

`decisions/` is symlinked, not snapshotted, because it is append-only by design. Symlink target is captured in `manifest.json.symlinks[]` (§2.3).

### 2.3 `manifest.json` extras

```json
{
  "symlinks": [
    { "path": "decisions/", "target": "../../decisions/" }
  ],
  "skipped": [
    { "path": ".DS_Store", "reason": "blacklist" },
    { "path": "health/", "reason": "out-of-scope (M1 health probes)" }
  ]
}
```

`skipped` documents directories the snapshotter intentionally did not copy. P0 contract: any path in `skipped` must also be excluded from auditor conservation diffs (§4).

### 2.4 `staged/` directory

Worker writes mutations to `staged/<file>.tmp`, NOT in-place next to originals. This keeps the originals clean if the run fails before audit passes. On audit-PASS, files in `staged/` are atomic-renamed to their final paths (see `atomicity-contract.md`). On audit-FAIL, `staged/` is preserved untouched and the dream-log records the path so JJ can inspect.

Once the rename sweep completes, `staged/` is deleted in the same transaction. Presence of `staged/` in a finalized snapshot directory means the run aborted between rename and cleanup — recovery procedure: re-run the dream pass; the lock-and-tmp-cleanup logic (`atomicity-contract.md` §4.2) handles it.

### 2.5 `event.json` (canonical machine-readable run record)

`event.json` is written in Phase 5 (REBUILD INDEXES) alongside `dream-log-entry.md`. The markdown is the human-readable summary; the JSON is the canonical record consumed by:

- The weekly digest generator (P5)
- Future replay tooling (`lib/recovery.js` and beyond)
- Cross-day analyses (e.g., "show me all promotions in May")

Schema:

```json
{
  "schema_version": "1.0.0",
  "run_id": "2026-05-09T03:00:14-04:00",
  "consumer_name": "claude-code-m4-vault",
  "git_tag": "dream/pre/2026-05-09",
  "verdict": "PASS",
  "source_signal": {
    "sessions_in_24h": 3,
    "journal_entries_consumed": 14,
    "corrections_received": 2,
    "quarantined_entries": 1
  },
  "insights": [
    {
      "id": "insight-2026-05-09-1",
      "importance": 9,
      "summary": "external-DOM-drift rule fired 3x today — reinforced",
      "source_citations": [
        "learning-journals/2026-05-09.md#L42",
        "session-logs/2026-05-09.md#L201"
      ],
      "routed_to": "patterns/active/external-dom-drift-llm-default.md"
    }
  ],
  "routed": {
    "patterns_reinforced": [
      { "pattern": "external-dom-drift-llm-default", "sightings_after": 12 }
    ],
    "patterns_promoted": [],
    "patterns_promotion_declined": [
      {
        "candidate": "verify-live-claims-against-git",
        "reason": "weighted_evidence=2.5 < threshold=3.0"
      }
    ],
    "corrections_appended": 2,
    "decisions_logged": ["2026-05-09-bazaar-mercury-only-locked"]
  },
  "pruned": {
    "corrections_lines_archived": 12,
    "corrections_archive_path": "archive/corrections/2026-05.md",
    "session_index_lines_before": 1126,
    "session_index_lines_after": 198,
    "journals_archived_count": 1,
    "next_session_prompts_rotated": 1,
    "patterns_demoted": []
  },
  "contradictions_surfaced": [
    {
      "description": "Phase-Gated review rounds: CLAUDE.md says 2-cap; corrections.md has 5-round entries",
      "file_paths": ["~/.claude/CLAUDE.md", "corrections.md"],
      "decision": "JJ to resolve next morning"
    }
  ],
  "audit": {
    "stage_a": { "verdict": "PASS", "findings": [] },
    "stage_b": { "verdict": "PASS", "findings": [], "model": "gpt-5-codex" }
  },
  "token_cost": {
    "worker_input_tokens": 18420,
    "worker_output_tokens": 3210,
    "auditor_input_tokens": 4150,
    "auditor_output_tokens": 612,
    "usd_estimate": 0.42
  },
  "duration_seconds": 142
}
```

`schema_version` is bumped on any breaking change. The Stage A auditor verifies that `dream-log-entry.md` and `event.json` agree on the bottom-line numbers (insights count, routed counts, prune deltas, audit verdict). Disagreement → FAIL.

Adding `event.json` partially closes the High-severity industry gap "no standardized audit log format" (per the 2026-05-08 Agent OS audit). Cross-consumer interop is not a goal of v1.0; the schema is consumer-internal and machine-portable within this repo.

---

## 3. Other archive subdirectories

### 3.1 `archive/sessions/YYYY-MM/`

One directory per month. Session logs older than 14 days move here verbatim (file name preserved). Index entry written into `archive/sessions/YYYY-MM/index.md` listing each session log + a one-line summary cribbed from the session log's own header.

**Conservation invariant**: `wc -l` of a session log under `archive/sessions/` must equal `wc -l` of the same file at the moment it was archived. No reformatting. No truncation.

### 3.2 `archive/corrections/YYYY-MM.md`

One file per month, append-only. Holds RESOLVED entries from `corrections.md` that aged past 30 days. Format mirrors `corrections.md` exactly (same heading style, same fields). The dream worker appends new entries; never rewrites.

**Conservation invariant**: `tail` of `archive/corrections/YYYY-MM.md` for any month must match (line-for-line) the lines removed from `corrections.md` during the dream pass on that day.

### 3.3 `archive/journals/YYYY-MM/`

Learning journals are consumed by the dream pass on the day they are created. After Phase 1 (REPLAY) reads the journal, Phase 3 (PRUNE) moves it to `archive/journals/YYYY-MM/<original-name>.md`. Verbatim, no edits.

### 3.4 `archive/next-session-prompts/`

Flat directory (no monthly subdirs because volume is low: ~1/day). The dream worker moves stale `next-session-prompt-*.md` files here when collapsing to the single `next-session.md` overwrite path (P2 work).

### 3.5 `archive/patterns/YYYY-MM-DD/`

Reserved for pattern retirement (full delete from active/ + reference/). Not written by the routine dream pass. Used by `/memory-demote --retire <pattern>` and similar admin tools. Same directory contains a `reason.md` explaining why the pattern was retired.

---

## 4. Conservation invariants (the auditor diff)

The Stage A auditor (per ADR 003) verifies these at the end of every dream pass.

### 4.1 Per-file conservation

For every file `F` in the warm or hot tier that was modified:

```
lines(F at end of run)
  + lines(content of F that was archived)
  = lines(F at start of run)
```

The auditor enumerates files in `archive/dreams/YYYY-MM-DD/snapshot/` (§2.1), reads the live file post-run, reads any matching archive append (§3.2 for corrections, §3.1 for session logs, etc.), and asserts the equation holds. Tolerance: zero. Off-by-one fails the audit.

### 4.2 Dropped lines vs moved lines

A dropped line (removed without archive trail) FAILS the audit. Every removed line must be either:
- Moved to a month-archive (e.g., `archive/corrections/2026-04.md`)
- Captured in the per-night snapshot (`archive/dreams/<date>/snapshot/<file>`)

Both is fine, but at minimum one must hold. In practice the snapshot is the safety net and the month-archive is the queryable home.

### 4.3 No cross-tier teleportation

Lines do not move from `working-memory.md` directly to `archive/corrections/YYYY-MM.md`. Cross-tier flows go through the canonical promotion/demotion pipeline (working-memory → corrections → archive/corrections). The auditor refuses runs where conservation holds globally but a line appears in the "wrong" archive bucket.

### 4.4 Append-only files

`pattern-firing-log.md` (see `pattern-firing-log-spec.md`) and `decisions/*.md` are append-only. The auditor refuses any run that modifies an existing line in either. Acceptable mutations: append new lines/entries only.

### 4.5 Manifest match

`manifest.json.files[]` must match exactly the files present in `snapshot/`. Hashes verified. Any extra file in `snapshot/` not in manifest, or any manifest entry without a corresponding file, FAILS Stage A.

---

## 5. Retention

| Artifact | Retention |
|---|---|
| `archive/dreams/YYYY-MM-DD/` | Indefinite — never garbage-collected by the worker. JJ may prune manually. |
| `archive/dreams/YYYY-MM-DD/staged/` | Cleared on the next successful run; preserved on FAIL for inspection. |
| `git tag dream/pre/YYYY-MM-DD` | Last 14 retained by the worker. Older tags GC'd at end of each successful run via `git tag -d` + push. |
| `archive/sessions/`, `archive/corrections/`, `archive/journals/` | Indefinite. ~1MB/week per consumer; not worth GC'ing. |
| `archive/next-session-prompts/` | Indefinite. |
| `archive/patterns/` | Indefinite. |

The 14-tag window is the **fast rollback** path (`git reset --hard dream/pre/<date>`). Beyond 14 days, recovery uses the indefinite snapshot directories — slower but fully recoverable. Recovery tooling lives in `lib/recovery.js` (P5).

---

## 6. Lifecycle

| Action | Phase | Writer |
|---|---|---|
| Create `archive/dreams/YYYY-MM-DD/{manifest.json, snapshot/}` | Phase 0 | Worker |
| Append entries to `archive/corrections/YYYY-MM.md` | Phase 3 | Worker |
| Move session logs into `archive/sessions/YYYY-MM/` | Phase 3 | Worker |
| Move journal into `archive/journals/YYYY-MM/` | Phase 3 | Worker |
| Move stale next-session prompts into `archive/next-session-prompts/` | Phase 3 | Worker (P2 hook) |
| Move retired patterns into `archive/patterns/YYYY-MM-DD/` | n/a | Human-invoked admin tool |
| Write `archive/dreams/YYYY-MM-DD/diff.md`, `dream-log-entry.md`, `event.json` | Phase 5 | Worker |
| Verify conservation invariants + dream-log-entry.md ⇔ event.json agreement | Stage A audit | Auditor |
| Clean `staged/` after rename sweep | Atomic-commit step | Worker |
| GC tags older than 14 days | Phase 5 cleanup | Worker |

---

## 7. Out of scope

- **Compression**: archives are stored as plain markdown / JSON. No gzip. Disk pressure is not a concern at consumer scale.
- **Cloud backup**: handled separately by the consumer's existing backup pipeline (e.g., JJ's restic→B2 nightly). The dream system trusts that backup of `memory_root/` covers `archive/`.
- **Cross-consumer archive sharing**: out of scope. Each consumer has its own `archive/` rooted at its own `memory_root`.
- **Indexing for search**: archives are filesystem-flat. Find via `grep -r` / `rg`. Search index is a future enhancement.

---

## 8. Done definition

P0 archive-schema is locked once:

1. Section 2 (per-night snapshot) names every file expected and the `manifest.json` shape JJ wants
2. Section 4 (conservation invariants) is exhaustive — adding a new tier later requires updating §4 first
3. P1 implementations (`lib/atomic-write.js`, wrap-up TTL helpers) reference paths from this doc, not their own conventions
4. The Stage A auditor (P5) implements §4 verbatim — every named invariant is a test

After lock, changes require a new ADR or schema-version bump on `manifest.json`.

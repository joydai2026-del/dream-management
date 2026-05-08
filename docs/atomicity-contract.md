---
title: Atomicity Contract
status: P0 contract — locked once JJ approves
audience: implementers (P1 atomic-write helper, P4 worker, memory-loader integration)
related:
  - ADR/004-archive-never-delete.md
  - ADR/003-cross-model-auditor.md
  - docs/archive-schema.md
  - SUCCESS-CRITERIA.md (P4 #4 lock file, P4 #8 max runtime, XPT-5 crash recovery)
date: 2026-05-08
---

# Atomicity Contract

The dream worker mutates multiple files per run. A crash partway through must leave the consumer's memory tier in its **prior valid state** — not a partial mutation. This document specifies how that guarantee is achieved.

Two mechanisms work together:

1. **Atomic write per file**: write to `<file>.tmp`, fsync, rename to `<file>`. POSIX rename is atomic on the same filesystem. Reader (memory-loader) sees either the old file or the new file, never half-written content.
2. **Cross-file commit barrier**: the worker writes ALL `*.tmp` files first, runs both audit stages on the staged tree, and only sweeps renames after both PASS. A crash before the sweep leaves the live tree untouched.

The worker also coordinates with concurrent readers via a lock file. Memory-loader respects the lock; the dream worker holds the lock for the duration of its run.

---

## 1. Subject files

Atomic-write applies to every file the dream worker mutates. Concretely:

| Tier | File | Mutation |
|---|---|---|
| Hot | `working-memory.md` | Updated last-session block, line-cap enforced |
| Hot | `pre-action.md` | Regenerated end-of-run |
| Hot | `patterns/active/<pattern>.md` | Reinforcement (sightings, latest_seen) |
| Hot | `patterns/active/<new>.md` | Auto-promotion (rare, gated) |
| Warm | `corrections.md` | Append, prune RESOLVED >30d |
| Warm | `session-index.md` | Append today's session, prune old |
| Warm | `memory-index.md` | Regenerated end-of-run |
| Cold | `archive/corrections/YYYY-MM.md` | Append moved entries |
| Cold | `archive/sessions/YYYY-MM/...` | Move (rename, no atomic-write) |
| Cold | `archive/journals/YYYY-MM/...` | Move (rename, no atomic-write) |
| Cold | `patterns/reference/<demoted>.md` | Move (rename, no atomic-write) |
| Log | `pattern-firing-log.md` | Append (atomic, single-line) |
| Log | `.dream-log.md` | Append entire run summary |
| Snapshot | `archive/dreams/YYYY-MM-DD/manifest.json` | Single write |

Files marked "Move" use `os.rename` directly across the live tree → archive. POSIX semantics make this atomic on the same filesystem; the file simply changes path. No tmp-rename needed — the source becomes the destination.

Files marked "Append" still go through the same `*.tmp` → rename pattern: read existing, append, write tmp, rename. Append is not atomic at the OS level for our purposes; we use the rename pattern uniformly.

---

## 2. Write order (the commit barrier)

The dream worker's mutation phase is structured as a single transaction:

```
PHASE 0 — SAFETY
  1. Acquire write lock (§ 4)
  2. git tag dream/pre/<date>
  3. Snapshot live tree → archive/dreams/<date>/snapshot/  (per archive-schema.md § 2)

PHASE 1-4 — MUTATIONS (worker writes ONLY into archive/dreams/<date>/staged/)
  4. For every file F to mutate, worker writes the new contents to:
       archive/dreams/<date>/staged/<relative-path-of-F>.tmp
     Append-mode files use the read-existing-then-write-new pattern.
  5. Worker writes archive/dreams/<date>/manifest.json (final form)

AUDIT — both stages run on the staged tree, NOT on live files
  6. Stage A invariant checks read from staged/ + live (for diff)
  7. Stage B /codex audit reads from staged/

COMMIT — atomic only after both audits PASS
  8. For every staged file, atomic-rename:
       archive/dreams/<date>/staged/<rel-path>.tmp  →  <memory_root>/<rel-path>
     ORDER: leaf-first (e.g., archive appends before the source pruning).
     This means a crash mid-sweep leaves a still-valid state where archives
     have content that hasn't been removed from source — duplicated, not lost.
  9. Move-style mutations (file moves to archive subdirs) execute next, in the
     same order as their staged metadata records.
 10. Append .dream-log.md success entry (atomic write).
 11. Delete archive/dreams/<date>/staged/.
 12. Release lock.

ON AUDIT FAIL
  - Skip steps 8-11.
  - Keep archive/dreams/<date>/staged/ intact for inspection.
  - Append .dream-log.md FAIL entry with rollback command (no rollback needed; nothing was committed).
  - Release lock.
```

The atomic property: **at any point during steps 4-7, the live tree is exactly as it was at the end of step 3**. A crash during these phases requires no recovery beyond cleaning up the lock file (§ 4.2) and the staged directory (which is preserved as evidence).

The non-atomic property: steps 8-9 are a sweep of multiple individual atomic operations. A crash mid-sweep leaves a **conservatively-valid** state — content might be duplicated (in both source file and archive) but never lost. The auditor on the next run detects duplicates via line-equality checks and reports the partial commit so JJ can resolve manually. Rare; only happens on hard kernel crash mid-rename, which is itself rare in modern macOS / Linux.

### 2.1 Sweep ordering rationale

Leaf-first means: archives are written before source pruning. Concretely, for the corrections.md TTL flow:

1. `archive/corrections/2026-04.md` gets the moved-out entries (atomic write to archive)
2. `corrections.md` gets the trimmed copy (atomic write to source)

Crash after step 1, before step 2: archive contains the entries; source still contains them too. Duplicate, not lost. Recovery is "delete the dupes from archive" or "trim source manually" — both safe operations.

The opposite order (source-first) would mean a crash leaves the lines in neither file. Lost data. Forbidden by this contract.

---

## 3. Atomic-write helper API (P1 deliverable — `lib/atomic-write.js`)

The helper enforces the contract for every subject file. P1 ships a single function:

```js
/**
 * @param {string} dest - final path relative to memory_root
 * @param {string} contents - new file contents
 * @param {object} opts
 * @param {boolean} [opts.staged=true] - write tmp into archive/dreams/<date>/staged/
 *                                       instead of alongside dest. Default true
 *                                       for dream worker; false for wrap-up's
 *                                       single-file appends.
 * @param {string} [opts.snapshotDate] - YYYY-MM-DD for staged path resolution
 * @param {boolean} [opts.fsync=true] - fsync before rename. Default true.
 * @returns {Promise<void>}
 *
 * Failure modes:
 *  - Throws if dest's parent dir does not exist.
 *  - Throws if rename target is on a different filesystem (would not be atomic).
 *  - Throws if a stale .tmp exists at the resolved tmp path AND its mtime is
 *    within the last 60s (concurrent writer suspected; caller decides retry).
 *  - On any throw, leaves no partial state at dest.
 */
async function atomicWrite(dest, contents, opts) { ... }
```

### 3.1 Append-mode helper

```js
/**
 * Atomic append: read existing file (or empty), append, atomic-write.
 * Used for pattern-firing-log.md, .dream-log.md, archive/corrections/YYYY-MM.md.
 *
 * @param {string} dest
 * @param {string} appendContents
 * @returns {Promise<void>}
 */
async function atomicAppend(dest, appendContents) { ... }
```

`atomicAppend` is used by wrap-up directly (no commit barrier needed for single-line appends; the rename gives sufficient atomicity). The dream worker still routes its appends through the staged tree because they are part of the multi-file transaction.

### 3.2 Move-style mutations

```js
/**
 * Atomic rename of an existing file across the tree (e.g., session log → archive).
 *
 * @param {string} from - existing path
 * @param {string} to - destination path
 *
 * Asserts both paths are on the same filesystem. Throws otherwise.
 */
async function atomicMove(from, to) { ... }
```

---

## 4. Lock contract

### 4.1 Lock file format

Path: `<memory_root>/.dream.lock`

JSON contents:

```json
{
  "schema_version": "1.0.0",
  "pid": 84512,
  "hostname": "Mac.lan",
  "started_at": "2026-05-09T03:00:14-04:00",
  "expected_completion_at": "2026-05-09T03:10:14-04:00",
  "phase": "phase-1-replay",
  "git_tag": "dream/pre/2026-05-09"
}
```

`expected_completion_at` is `started_at + 10 min` (the worker's max-runtime cap; SUCCESS-CRITERIA.md P4 #8). Updated to current `phase` every 30s by the worker so a watcher can see liveness.

### 4.2 Lock acquisition

```
1. Worker reads .dream.lock (if exists).
2. If file exists:
   2a. If .pid is alive AND .started_at within max-runtime → ABORT with
       "lock held" (concurrent run; safe to skip this tick).
   2b. If .pid is dead OR .started_at > max-runtime ago →
       STALE LOCK. Worker logs warning, archives the stale lock to
       archive/dreams/<date>/stale-locks/.dream.lock.<timestamp>,
       and proceeds.
3. Worker writes new .dream.lock (atomically — same atomicWrite helper).
4. On normal completion: rename .dream.lock to .dream.lock.completed
   (preserved one tick for audit; deleted by next run's start).
5. On crash: lock orphans. Detected as STALE on next run.
```

`pid alive` check on macOS uses `kill -0 <pid>`; failure (ESRCH) means dead. Hostname mismatch (lock written by a different machine and still appears alive there) is a configuration error and aborts with "cross-machine lock detected — investigate."

### 4.3 Reader coordination (memory-loader)

Memory-loader reads memory at session start. Coordination protocol:

```
1. Memory-loader starts.
2. Checks .dream.lock:
   - if absent → proceed normally
   - if present AND fresh (<60s old) → wait up to 5s with 500ms polling for
     lock to clear; if still held, proceed with read (acceptable: dream
     finishes mid-load in ~3am; memory-loader runs at session-start, not 3am)
   - if present AND stale → log warning to next session prompt, proceed
3. Memory-loader takes no lock itself — reads are advisory.
```

Reads are advisory because the atomic-rename guarantee already covers the consistency case: at any instant, a file is either old-version or new-version, not torn. The 5-second wait is courtesy to avoid the race where dream is in step 8 (sweep mid-rename) — waiting briefly avoids "files I read are inconsistent across each other," not "files are torn."

In practice, memory-loader runs at human session-start (~9am, ~2pm, ~10pm) and dream runs at 3am. Collision is rare. The contract still defines behavior because reliability ≠ "rarely collides."

### 4.4 Watchdog (optional, P5)

A simple watchdog can run separately: if `.dream.lock` exists with `expected_completion_at` in the past, it logs to `.dream-log.md` and (optionally) emails JJ. Off by default in v1.0.

---

## 5. Audit-then-commit ordering (where atomicity meets ADR 003)

```
Worker writes staged/  →  Stage A invariants  →  Stage B /codex audit  →  Sweep renames  →  Commit
                          (read staged + live)   (read staged)            (atomic, leaf-first)   (cleanup)
```

- Stage A reading both staged and live is mandatory: line-count conservation can only be checked by comparing source-pre to source-post + archive-append.
- Stage B reads only the staged tree to verify the proposed mutation makes semantic sense; no need to see live state.
- The sweep is the **commit point**. Before it: nothing has changed. After it: the new state is durable. The lock file's `phase` field says `committing` during the sweep so a watcher can see it.

If Stage A FAILS, the run aborts before Stage B (saves /codex tokens).
If Stage B FAILS, the run aborts before sweep.
Both stages are deterministic in their FAIL outputs (specific findings cited) — see ADR 003.

### 5.1 What "PASS" means at audit-time

PASS means **safe to commit**. The audit does NOT promise the dream's content is good — only that it doesn't violate invariants (Stage A) and isn't obviously hallucinated/lost-information (Stage B). Quality lives elsewhere (the dream-log entry JJ reviews next morning).

### 5.2 Partial PASS (WARN with mitigation)

Stage B may emit `WARN-with-mitigation` per ADR 003. In this case:

- The mitigation is applied to the staged tree (not live)
- Stage A re-runs on the mitigated staged tree
- If Stage A still PASS, sweep proceeds; mitigation logged in `.dream-log.md`
- If Stage A now FAILS, the whole run aborts (mitigation broke an invariant — surface to JJ)

---

## 6. Failure semantics

| Failure | When | Live tree state | Recovery |
|---|---|---|---|
| Crash before step 3 (snapshot) | Phase 0 | Untouched | Re-run; clean lock |
| Crash during step 3 | Phase 0 | Untouched | Re-run; clean lock and partial snapshot |
| Crash during steps 4-5 | Mutation phase | Untouched | Re-run; clean lock; staged/ may have orphans, deleted by next snapshot creation |
| Crash during steps 6-7 | Audit | Untouched | Re-run; clean lock; staged/ preserved as evidence (next run starts fresh) |
| Crash during step 8 (sweep) | Commit | Partial — leaf-first ordering means content duplicated, not lost | Run reconciler (P5 `lib/recovery.js`); manual diff easy |
| Crash during step 11 (cleanup) | Post-commit | Fully committed | Next run cleans `staged/`; no data risk |
| Lock orphan (worker process killed) | Any phase | Depends on phase (above) | Next run detects stale lock, archives it, proceeds |
| Stage A FAIL | Audit | Untouched | JJ reviews staged/ next morning; optionally re-runs with patched worker |
| Stage B FAIL | Audit | Untouched | Same as Stage A FAIL |
| Disk full mid-write | Mutation phase | Untouched (write to .tmp fails, original intact) | Free space; re-run |
| Different filesystem rename target | Atomic-write helper | Untouched (helper throws) | Configuration error — fix `archive_root` to be on same fs as `memory_root` |

The contract guarantees: no crash leaves the live tree in a "partially mutated" state. Worst case is "duplicated content, both copies valid markdown, easy to reconcile."

---

## 7. Recovery procedure

### 7.1 Within 14 days (fast path)

```bash
git reset --hard dream/pre/<date>
rm -f <memory_root>/.dream.lock
```

That's it. The git tag was created in Phase 0 before any mutation. Memory tree returns to pre-dream state. Note: this discards any non-dream commits since the tag — not common because the dream runs at 3am and memory edits during the day are rare for the consumer; but JJ's wrap-up scripts also commit, so check `git log dream/pre/<date>..HEAD` first.

### 7.2 Beyond 14 days (slow path)

```bash
node lib/recovery.js --restore-from archive/dreams/<date>/snapshot/
```

The snapshot is a verbatim copy of the hot+warm tier as of Phase 0. Recovery overwrites live files from snapshot. Append-only logs and ongoing session work since that date are NOT recovered (intentional — the snapshot is a point-in-time state, not a transaction log replay).

### 7.3 Partial-commit recovery

If a crash during step 8 sweep left duplicates:

```bash
node lib/recovery.js --reconcile-partial-commit <date>
```

Reads `archive/dreams/<date>/manifest.json` to determine intended target state, diffs against current live tree, prompts JJ for each conflict. Conservative — never auto-resolves.

---

## 8. Out of scope

- **Cross-machine concurrency**: lock file is local-only. Two machines mutating the same memory tree concurrently is a configuration error. Detection is best-effort (hostname check) but not prevention.
- **NFS / network filesystems**: rename atomicity is filesystem-specific. The contract assumes APFS (macOS) or ext4 (Linux). Network filesystems are unsupported in v1.0.
- **Strong fsync guarantees**: `fsync=true` is set by default but the OS may still buffer at the disk level on power loss. Power-loss-during-rename is an OS-level concern outside this contract; mitigations are at the consumer's backup layer.
- **Distributed dream workers**: one worker per consumer per machine. Sharding is unnecessary at consumer scale.

---

## 9. Done definition

P0 atomicity contract is locked once:

1. Section 2 (write order) is exhaustive — adding a new mutation type later requires extending the table in § 1 and clarifying its placement in the sweep ordering.
2. Section 4 (lock contract) covers the failure modes JJ has hit before (raw-sweep PATH ghost in 2026-04-19 — same launchd category, but here covered by the stale-lock detection).
3. P1 ships `lib/atomic-write.js` implementing § 3 verbatim. Tests cover § 6 failure-table rows.
4. Memory-loader integration follows § 4.3 protocol — no separate read-side lock.
5. P5 auditor's Stage A invariants reference § 2.1 (leaf-first sweep ordering) when checking duplicates after partial-commit detection.

After lock, mechanism changes require a new ADR; tuning (timeouts, polling intervals) is config-only.

# ADR 004: Archive-Never-Delete + Multi-Night Rollback

**Status**: Accepted, 2026-05-08
**Context**: Memory mutations are inherently risky. A bad consolidation can silently corrupt for nights before detection. Need recovery story.

## Decision

The dream system **never deletes**. Every prune moves to a dated archive. Every nightly run creates a git tag. Last 14 tags retained.

### Mechanisms

1. **Per-night snapshot**: at start of dream, full hot+warm tier copied to `archive/dreams/YYYY-MM-DD/`
2. **Per-night git tag**: `git tag dream/pre/YYYY-MM-DD` before any mutation
3. **Atomic writes**: dream worker writes to `*.tmp`, then atomic-renames at end of run. Partial-failure leaves prior state intact.
4. **Pruned content moves to archive subdirectories**:
   - `archive/sessions/` — full session logs >14 days
   - `archive/corrections/` — resolved corrections >30 days
   - `archive/journals/` — learning journals after consolidation
   - `archive/dreams/` — pre-dream snapshots
   - `patterns/reference/` — patterns not fired in 60 days (still active codebase, just demoted)
5. **14-tag rolling window**: keep last 14 dream-tags. Older ones GC'd. Within 14 days, recovery = `git reset --hard dream/pre/<date>`.
6. **Beyond 14 days**: replay from `archive/dreams/` snapshots + `session-logs/` (which always survive). Recovery tool ships in `lib/recovery.js`.

### Anomaly detection

Weekly digest (`dream-log-weekly.md`) shows hot-tier line count delta, pattern promotions, corrections aged out. Anomalies (e.g., +50 lines in a week, 7 promotions) surface to human visually — no need for explicit alerting in v1.0.

## Consequences

- Disk usage grows: ~1MB/week per consumer for snapshots + archives. Trivial at JJ scale.
- Git history grows by 365 tags/year. Tags are cheap; ignore.
- Recovery is one git command for 14 days; multi-step beyond that.
- This is the foundation that makes auto-merge + pruning safe — every action is reversible.

## Alternatives considered

- **In-place mutation, no archive**: not safe. One bad night can be unrecoverable.
- **Full daily git commit on memory**: noisier history; tags are sufficient.
- **Cloud backup**: separate concern (handled by JJ's existing restic→B2 nightly per project memory).

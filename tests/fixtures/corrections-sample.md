---
type: note
created: 2026-01-15
modified: 2026-05-08
tags: [corrections, agent-memory, claude-code-m4]
---

# Corrections Ledger
<!-- Test fixture for corrections-ttl. -->

## Resolved Corrections (recent)

### Old resolved entry should archive (2026-01-15)
- **First occurrence**: This is from January and is RESOLVED. With now=2026-05-08, it's 113 days old, well past the 30-day TTL. Archive it.
- **Resolution**: Archived to archive/corrections/2026-01.md.
- **Status**: RESOLVED.

### Recent resolved entry should keep (2026-05-01)
- **First occurrence**: This is from May 1 and is RESOLVED. With now=2026-05-08, it's 7 days old, within the 30-day window. Keep it.
- **Resolution**: Kept in live file.
- **Status**: RESOLVED structurally.

### Older resolved entry, structurally (2026-02-10)
- **First occurrence**: This is from February and is RESOLVED structurally. Should archive.
- **Resolution**: Should land in archive/corrections/2026-02.md.
- **Status**: RESOLVED structurally.

### Aged but UNRESOLVED — must keep (2025-12-01)
- **First occurrence**: This is from December and is UNRESOLVED. Aged but not resolved → keep.
- **Status**: UNRESOLVED.

### Resolved with no date — must keep (defensive)
- **First occurrence**: No date in the body or heading.
- **Status**: RESOLVED.

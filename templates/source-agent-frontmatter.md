---
title: source_agent Frontmatter Snippet
purpose: Wrap-up writes this field into every episodic input so /dream Phase 1 can route by trust
referenced_by: ADR/007-source-trust-boundary.md
schema_version: 1.0.0
---

# `source_agent` Frontmatter Snippet

ADR 007 requires every episodic input the dream worker reads to declare which
agent wrote it. Trusted inputs (the canonical consumer, e.g. `claude-code-m4`)
flow through the regular reflection pipeline. Untrusted inputs (everything
else, including absent `source_agent`) get quarantined and surfaced to JJ for
review next morning — never auto-promoted, never used as evidence.

The dream-management repo only specifies the contract. The wrap-up skill in
`joy-claude-skills/wrap-up/SKILL.md` is responsible for actually writing this
field; that integration is tracked separately and lands after this repo's P2
ships.

## Where it must appear

The wrap-up skill writes `source_agent: <agent-name>` into the YAML frontmatter
of every file in the following set:

1. **Today's learning journal** — `learning-journals/<YYYY-MM-DD>.md`
2. **Each new entry appended to `corrections.md`** — entry-level frontmatter,
   either at the top of the entry block or as a `**Source agent**:` line in the
   entry body when the corrections format already uses YAML for the file but not
   per-entry.
3. **Each session log** — `session-logs/<YYYY-MM-DD>.md`

For the canonical consumer (M4 Claude Code), the value is `claude-code-m4`. For
any other deployment, use that consumer's `consumer_name` from
`dream.config.json`.

## Snippet — learning journal

```yaml
---
type: learning-journal
created: 2026-05-09
project: dream-management
branch: feat/p2-read-path
source_agent: claude-code-m4
tags: [learning-journal, claude-code-m4, dream-management, p2]
---
```

## Snippet — session log

```yaml
---
type: session-log
date: 2026-05-09
agent: claude-code-m4
source_agent: claude-code-m4
projects: [dream-management]
---
```

## Snippet — corrections.md (file-level header)

```yaml
---
title: Corrections Ledger
agent: claude-code-m4
source_agent: claude-code-m4
schema: corrections-v1
---
```

If the corrections schema does not carry per-entry frontmatter today, add a
`**Source agent**:` line to each new entry until the per-entry schema is
upgraded:

```markdown
### Recon-staleness blindspot recurred (2026-05-09)
- **Source agent**: claude-code-m4
- **First occurrence**: ...
```

## Quarantine semantics

`/dream` Phase 1 (REPLAY) treats inputs as follows:

| `source_agent` value | Treatment |
|---|---|
| Matches `episodic.trusted_source_agents[]` in `dream.config.json` | Routed normally (reflection, promotion candidate, firing-log evidence) |
| Any other value | Recorded under `quarantine_summary` in `.dream-log.md`. NOT routed. NOT counted in promotion gates. NOT used as firing-log evidence. |
| Absent | Same as "any other value" — untrusted by default |

JJ adopts a quarantined entry by hand-editing the frontmatter to set
`source_agent: claude-code-m4` (with an optional `promoted_from: <orig-agent>`
provenance line). The next dream run treats the file as canonical.

## Auditor behavior

Stage A invariants (P5 deliverable) include: "every routed insight in Phase 2
must cite only trusted-source evidence." A FAIL here pauses the dream commit
and surfaces the offending insight to JJ via `.dream-log.md`. The Stage B
adversarial auditor (`/codex`) attacks the trust boundary independently.

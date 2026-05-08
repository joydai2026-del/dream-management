# ADR 007: Source-Trust Boundary on Episodic Inputs

**Status**: Accepted, 2026-05-08
**Context**: First consumer's vault is Obsidian-synced across devices. The M4 (where `/dream` runs) shares the vault with the M1 OpenClaw fleet (Maxim/Herald/Atlas/etc.) via symlinked agent directories and Obsidian Sync. Any of those M1 agents may write into directories that the dream worker reads as episodic input — `learning-journals/`, `corrections.md`, `session-logs/`. Some of those agents ingest external content (Herald scrapes RSS; Atlas fetches papers). The OWASP-Top-10-for-Agentic-Apps "Agent A poisons Agent B's context" attack is live by construction unless we add a trust filter.

ADR 005 settled that cloud sessions ship no memory. This ADR settles the symmetric question: what about local cross-agent writes that arrive via the shared vault?

## Decision

Every episodic input the dream worker consumes carries a `source_agent:` field. The worker treats `claude-code-m4` (the canonical consumer) as trusted and routes other sources through a quarantine pathway.

### Mechanism

1. **Wrap-up writes `source_agent: claude-code-m4`** in the frontmatter of every `learning-journals/<date>.md`, every entry it appends to `corrections.md`, and every session-log header. This is automatic and non-negotiable.

2. **/dream Phase 1 (REPLAY) filters episodic inputs by `source_agent`**:
   - Inputs with `source_agent: claude-code-m4` enter the regular reflection pipeline.
   - Inputs with any other `source_agent:` value (including absent — treated as untrusted-by-default) go to a `quarantine_summary` block in `.dream-log.md` for JJ review the next morning. They are NOT routed to pattern reinforcement, NOT counted toward auto-promotion gates, NOT used as evidence for firing-log cross-references.

3. **Auto-promotion (ADR 002) requires all journal-mention citations to be from trusted sources**. A candidate pattern whose evidence relies on quarantined entries fails the citation gate and stays unpromoted, regardless of importance score or count.

4. **JJ adopts a quarantined entry by hand-editing it**: changing the frontmatter to `source_agent: claude-code-m4` (with a `promoted_from: <original-agent>` provenance line) signals review-and-trust. The next /dream run treats it as canonical.

5. **Trusted-source allowlist** lives in `dream.config.json` under `episodic.trusted_source_agents: ["claude-code-m4"]`. Future deployments may add their own canonical agent name and (carefully) extend the allowlist.

### What this does NOT do

- Does not block M1 agents from writing to the vault. The vault stays shared.
- Does not delete or alter quarantined entries — they remain readable by JJ via Obsidian and via `grep`.
- Does not require cryptographic signing (deferred to v2; see "alternatives considered").
- Does not handle sub-document tampering — if a trusted agent's journal is hand-edited maliciously after the fact, this ADR has no defense. That's a `git log` audit problem, not a content-trust problem.

## Consequences

- The dream worker cannot be tricked into auto-promoting a pattern that originated outside `claude-code-m4`. Cross-agent context poisoning becomes a JJ-review problem, not a silent-corruption problem.
- M1 OpenClaw fleet workflows are unaffected — they continue writing to the vault as today. Only their consolidation behavior changes (quarantined, surface-to-JJ).
- Wrap-up gets a small extra step: writing the `source_agent` frontmatter into journals/corrections/session-logs.
- `dream.config.json` gets one new field (`episodic.trusted_source_agents`).
- The Stage A auditor adds one invariant: every routed insight (Phase 2) must cite only trusted-source evidence; otherwise FAIL.

## Alternatives considered

- **Cryptographic signing of every entry**: would defend against post-hoc tampering and impersonation. Real value but high cost (key management, rotation, revocation) for a solo-user setup. Deferred to v2 if/when the cross-agent surface area grows or a multi-user variant ships.
- **No trust filter (consolidate everything)**: matches the current write-everything-in semantics. Vulnerable to the OWASP "agent poisons agent" attack. Reviewer-flagged loophole.
- **Per-directory permissions** (M1 agents can write `inbox/` but not `learning-journals/`): would force a sync-architecture refactor. Effort >> benefit for a problem better solved by a metadata field.
- **Whitelist by file path / pattern** (e.g., trust everything under `claude-code-m4/`): too brittle. Symlinks, accidental writes, and future reorganization break it.

## Reviewer note

This ADR is the resolution of Loophole 1 from the 2026-05-08 Agent OS landscape audit (NotebookLM-driven). The audit confirmed cross-agent memory poisoning as a High-severity gap industry-wide; ADR 005 covered the cloud direction, this covers the local direction. Together they specify the consumer's full episodic-input trust boundary.

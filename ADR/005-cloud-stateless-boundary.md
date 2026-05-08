# ADR 005: Cloud Sessions Are Stateless — Memory Stays Local

**Status**: Accepted, 2026-05-08
**Context**: First consumer (JJ) plans to use cloud-based Claude Code (Dispatch / GitHub cloud agents) for some work. Question: do cloud agents need access to vault memory, and if so, how?

## Decision

Cloud routine sessions are **stateless executors**. They receive a task spec, do the work, return a result via PR or git commit. No memory is shipped to the cloud. No cross-project memory sharing.

### Boundary properties

- Vault stays **local-only** on the consumer's primary device (JJ's M4)
- Cloud agents read only what's already in the cloned repo (CLAUDE.md, code, project-level docs)
- Cloud session output (PR, commit) merges locally on the primary device via normal review
- The next nightly dream pass on the primary device absorbs merged work into vault memory normally

### Privacy / security guarantees

- Private project memory cannot leak into public-project cloud sessions, ever
- Hard cut between memory residency (local) and execution (cloud)
- No need for memory subset distribution, scope tagging, or cross-repo sync — those are deferred or never built

### Trade-offs

- Cloud agents work with less context than local sessions — they only see what's in the repo
- Compensation: project-level CLAUDE.md is the contract; if cloud agents need a rule, it goes in CLAUDE.md, which is in-repo and version-controlled

## Consequences

- Plan stays at the local-only scope (~31-40h, not the +6h cloud-distribution add-on)
- Privacy boundary is hard and easy to reason about
- Future cloud-mode integration is a separate ADR if/when needed — not blocked, just not done yet

## Alternatives considered

- **Memory subset distribution per repo** (Option C from earlier exploration): would have required scope tagging, dream redistribution phase, write-back ingestion. Real cost for marginal gain. Privacy risk if scope tagging is buggy.
- **Single private memory repo as submodule**: leaks irrelevant project context across repos. Submodule pain.
- **Memory-as-a-service**: needs auth, latency, consistency story; out of scope for v1.0.

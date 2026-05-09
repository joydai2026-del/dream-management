---
title: Wrap-up Firing Classifier — LLM Prompt Template
purpose: Classify pre-action.md rules per session against the four-outcome vocabulary
referenced_by: docs/pattern-firing-log-spec.md § 5.1
schema_version: 1.0.0
---

# Wrap-up Firing Classifier — Prompt Template

This template is the LLM contract for `pattern-firing-log.md` § 5.1. The wrap-up
skill substitutes the placeholders below and feeds the result to a model. The
classifier output is fed to `lib/firing-log-write.js`, which validates every
returned firing against the § 5.2 identifier rule and the § 5.4 evidence-line
grep test before persisting the entry.

## Variables (substituted by wrap-up before invocation)

- `{{SESSION_ID}}` — kebab-case session identifier, e.g. `2026-05-09-dream-mgmt-p2`
- `{{SESSION_LOG_PATH}}` — relative path to the session log, e.g. `session-logs/2026-05-09.md`
- `{{PROJECT}}` — current project name (or the empty string)
- `{{CWD}}` — current working directory (or the empty string)
- `{{DURATION_MIN}}` — integer minutes from start to wrap-up
- `{{LOADED_RULES_LIST}}` — newline-bullet list of rule identifiers from `pre-action.md`
- `{{LOADED_RULES_DETAIL}}` — for each loaded rule: identifier + 1–3 line summary +
  optional `trigger_phrases:` declared in the pattern's frontmatter
- `{{SESSION_TRANSCRIPT}}` — the full session-log content, line-numbered

---

## Prompt body

You classify how a coding-agent session handled the rules it was supposed to keep
in mind. The system needs **honest** signal here — not flattering signal. A
missed-violation hides the failure mode the system was built to expose, so the
prompt deliberately tilts you toward over-tagging `violated`.

### Inputs

**Session metadata**

- session: `{{SESSION_ID}}`
- session_log: `{{SESSION_LOG_PATH}}`
- project: `{{PROJECT}}`
- cwd: `{{CWD}}`
- duration_min: `{{DURATION_MIN}}`

**Rules loaded into the agent's pre-action context this session**

```
{{LOADED_RULES_DETAIL}}
```

**Full session transcript (one rule citation must point to a real line number here)**

```
{{SESSION_TRANSCRIPT}}
```

### Task

For each rule in `{{LOADED_RULES_LIST}}`, classify it as one of:

| Outcome | When it applies |
|---|---|
| `applied` | The rule fired AND its action was taken (you wrote multiple agents in parallel because the parallel-agents-for-audits rule said to). |
| `referenced` | The rule was cited in reasoning OR consulted, but no action followed. Borderline cases that didn't trigger the action. |
| `violated` | The rule was relevant, was loaded, and was NOT followed. The action contradicted the rule. **Over-tag this rather than under-tag.** A real violation that you mark `applied` is the worst possible failure of this classifier. |
| `not-referenced` | The rule was loaded but never came up. Default for everything that doesn't earn a clear citation. |

### Citation rules (HARD)

For every `applied` / `referenced` / `violated` outcome, you MUST provide an
`evidence:` field of the form `session-logs/<date>.md#L<line_number>` that
points to a specific line in `{{SESSION_LOG_PATH}}`. (The auditor rejects
absolute paths, paths that escape the agent's memory root, and any path that
doesn't begin with `session-logs/`.)

The cited line must contain EITHER:

1. **The rule's full identifier as a word** — the kebab-case rule id appearing
   with non-id-character (or line-edge) boundaries on both sides. The id is
   the FULL filename stem of `patterns/active/<rule-id>.md`. A line that
   mentions only a prefix (e.g. `external-dom-drift` when the rule is
   `external-dom-drift-llm-default`) does NOT satisfy this check — use a
   trigger phrase instead, or downgrade the outcome.
2. **A registered `trigger_phrases:` value** declared in the rule's frontmatter
   (you've been given those above under `{{LOADED_RULES_DETAIL}}`). Trigger
   phrases match as substring.

If you cannot supply a citation matching one of those — even if the rule
felt like it was being applied — downgrade the outcome to `not-referenced`. The
auditor (Stage A) re-runs the same grep and drops any firing that fails it,
so an unsupported `applied` is worse than an honest `not-referenced`.

For `violated`, also set:

- `detail` — one sentence describing what the agent did that contradicted the rule
- `correction_filed` — `true` if a correction entry was filed in `corrections.md`,
  else `false`. (Optional; the writer accepts `false` as the default.)

### Output format (strict)

Emit a single JSON object. No prose. No markdown fences.

```
{
  "session": "{{SESSION_ID}}",
  "session_log": "{{SESSION_LOG_PATH}}",
  "project": "{{PROJECT}}",
  "cwd": "{{CWD}}",
  "duration_min": {{DURATION_MIN}},
  "pre_action_loaded_rules": [
    "<rule-id>", "<rule-id>", "..."
  ],
  "firings": [
    {
      "pattern": "<rule-id>",
      "outcome": "applied" | "referenced" | "violated",
      "fired_at": "<5-15 word phrase describing when in the session>",
      "evidence": "<session_log_path>#L<line_number>",
      "detail": "<only for violated; omit otherwise>",
      "correction_filed": false
    }
  ],
  "not_referenced": [
    "<rule-id>", "<rule-id>", "..."
  ]
}
```

### Honesty incentive (read this twice)

A loaded-but-not-applied ratio above 0.7 is a SUCCESS for this classifier —
it tells the dream worker that `pre-action.md` is selecting the wrong rules,
which is information the system needs. An over-eager `applied` rate is a
FAILURE. Dropping firings that lack a defensible citation is the correct
behavior, not "being unhelpful."

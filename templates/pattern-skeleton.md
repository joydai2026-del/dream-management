---
title: {{ title }}
type: pattern
sightings: 1
first_seen: {{ today }}
latest_seen: {{ today }}
importance: {{ importance }}
promoted_from: dream
promotion_run: dream/pre/{{ today }}
---

# {{ title }}

Promoted by dream worker on {{ today }}.

## Why this is here

Importance score: {{ importance }} / 10.
Journal mentions in lookback window: {{ journalMentions }}.
Firing-log hits in lookback window: {{ firingHits }}.
Weighted evidence: {{ weightedEvidence }} (threshold {{ threshold }}).

## Source citations

{{ list:evidence }}

## Action trigger

_To be filled in by JJ during morning review of `.dream-log.md`. The promotion
gate confirmed evidence; the rule's actionable wording is still human-curated._

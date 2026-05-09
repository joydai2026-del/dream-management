#!/usr/bin/env bash
# verify-p3-3.sh — Verifies SUCCESS-CRITERIA P3 #3 (bootstrap concession).
# Usage: bash scripts/verify-p3-3.sh <patterns/reference/ dir>
# Exits 0 on PASS with "OK N/N" line; exits 1 on FAIL with per-file reasons.
#
# Validates: every file in <reference/> with `demotion_phase: p3-2026-05-09`
# satisfies EITHER:
#   (a) `last_fired:` date ≤ 2026-03-08 (strict ≥60-days-old criterion), OR
#   (b) `bootstrap: true` AND `bootstrap_at: 2026-05-09` AND
#       `bootstrap_method:` AND `last_fired:` (any date) present
#
# Also asserts the scoped count matches the expected 16 files for the
# 2026-05-09 cleanup. Future cleanups must use the dream worker's Phase 3
# demotion gate (per docs/pattern-firing-log-spec.md § 6.1) which uses
# firing-log evidence, not bootstrap.

set -euo pipefail

REF_DIR="${1:?usage: verify-p3-3.sh <patterns/reference/ dir>}"
EXPECTED_COUNT=16
PHASE_TAG="^demotion_phase: p3-2026-05-09\$"
STRICT_CUTOFF="2026-03-08"  # last_fired must be ≤ this for path (a)

targets=$(grep -l "$PHASE_TAG" "$REF_DIR"/*.md 2>/dev/null || true)
n=$(printf "%s\n" "$targets" | grep -c '\.md$' || true)

if [ "$n" -ne "$EXPECTED_COUNT" ]; then
  echo "FAIL: scoped count=$n expected=$EXPECTED_COUNT (P3 #3 scope drift; check demotion_phase frontmatter)"
  exit 1
fi

fail=0
for f in $targets; do
  lf=$(grep -E "^last_fired:[[:space:]]" "$f" | head -1 | awk '{print $2}' || true)
  has_b=$(grep -cE "^bootstrap:[[:space:]]+true[[:space:]]*$" "$f" || true)
  has_bat=$(grep -cE "^bootstrap_at:[[:space:]]+2026-05-09[[:space:]]*$" "$f" || true)
  has_bm=$(grep -cE "^bootstrap_method:[[:space:]]" "$f" || true)

  if [ -z "$lf" ]; then
    echo "FAIL: $(basename "$f") missing last_fired:"
    fail=1
    continue
  fi

  # Path (a): strict — last_fired ≤ 2026-03-08
  if [[ "$lf" < "$STRICT_CUTOFF" ]] || [[ "$lf" == "$STRICT_CUTOFF" ]]; then
    continue  # passes (a)
  fi

  # Path (b): bootstrap requires all 4 fields
  if [ "$has_b" = "0" ] || [ "$has_bat" = "0" ] || [ "$has_bm" = "0" ]; then
    missing=()
    [ "$has_b" = "0" ] && missing+=("bootstrap:true")
    [ "$has_bat" = "0" ] && missing+=("bootstrap_at:2026-05-09")
    [ "$has_bm" = "0" ] && missing+=("bootstrap_method:")
    echo "FAIL: $(basename "$f") last_fired=$lf (>$STRICT_CUTOFF) requires bootstrap; missing: ${missing[*]}"
    fail=1
  fi
done

if [ "$fail" = "0" ]; then
  echo "OK $n/$EXPECTED_COUNT"
  exit 0
else
  echo "FAIL: see lines above"
  exit 1
fi

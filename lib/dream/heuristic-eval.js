// Heuristic-scorer eval harness — calibration for scoreHeuristic.
//
// Per ARCHITECTURE.md § 6 should-fix list ("Calibration prompt: show LLM
// 30-day score distribution before scoring") + reviewer MF-11. The
// harness scores a fixture set of insights with the rule-based scorer,
// and reports the resulting distribution + per-bucket calibration so JJ
// can detect drift in the heuristic vs. reality.
//
// This is OBSERVABILITY tooling, not a worker dependency. It runs:
//   - As a `node bin/eval-heuristic.js` invocation (manual / CI sanity)
//   - Optionally embedded into the weekly digest output
//
// Usage:
//   const result = await evalHeuristic({
//     fixtures: [{ insight, expected_band: 'low'|'mid'|'high' }],
//   });
//   console.log(result.report);
//
// Each fixture's `expected_band` is the human's label for what the score
// should be (low=1-4, mid=5-7, high=8-10). The harness compares actual
// scores to bands and reports:
//   - distribution (count per integer score)
//   - per-band hit rate (% of fixtures where score band == expected)
//   - per-bucket distribution (BUCKET_BASE * fixtures with that bucket)
//   - drift indicators (e.g., all high fixtures scoring 7 → calibration low)

import { scoreHeuristic } from './importance-score.js';

const BAND = {
  low:  { min: 1, max: 4, label: '1-4 (low)' },
  mid:  { min: 5, max: 7, label: '5-7 (mid)' },
  high: { min: 8, max: 10, label: '8-10 (high)' },
};

const VALID_BANDS = new Set(['low', 'mid', 'high']);

/**
 * Score every fixture and produce a calibration report.
 *
 * @param {object} opts
 * @param {Array<{insight, expected_band}>} opts.fixtures
 * @param {function} [opts.scorer]              default scoreHeuristic
 * @returns {{
 *   total: number,
 *   distribution: Record<string, number>,     // score → count
 *   band_hits: { low: number, mid: number, high: number, none: number },
 *   band_misses: Array<{insight_label, expected_band, actual_score, actual_band}>,
 *   per_bucket: Record<string, { count, mean, stddev }>,
 *   calibration: { hit_rate: number, drift_detected: boolean, notes: string[] },
 *   report: string,                            // markdown summary
 * }}
 */
export function evalHeuristic(opts) {
  const { fixtures = [], scorer = scoreHeuristic } = opts || {};
  if (!Array.isArray(fixtures)) {
    throw new Error('evalHeuristic: fixtures must be an array');
  }
  const distribution = Object.fromEntries(
    Array.from({ length: 10 }, (_, i) => [String(i + 1), 0]),
  );
  const band_hits = { low: 0, mid: 0, high: 0, none: 0 };
  const band_misses = [];
  const perBucket = new Map();

  for (const fx of fixtures) {
    if (!fx || !fx.insight) continue;
    const { score } = scorer(fx.insight);
    distribution[String(score)] += 1;
    const actual_band = scoreToBand(score);
    if (VALID_BANDS.has(fx.expected_band)) {
      if (actual_band === fx.expected_band) {
        band_hits[fx.expected_band] += 1;
      } else {
        band_misses.push({
          insight_label: fx.insight.label || (fx.insight.text || '').slice(0, 60),
          expected_band: fx.expected_band,
          actual_score: score,
          actual_band,
        });
      }
    } else {
      band_hits.none += 1;
    }
    const bucket = fx.insight.bucket || 'other';
    if (!perBucket.has(bucket)) perBucket.set(bucket, []);
    perBucket.get(bucket).push(score);
  }

  const per_bucket = {};
  for (const [bucket, scores] of perBucket.entries()) {
    const mean = scores.reduce((s, n) => s + n, 0) / scores.length;
    const variance = scores.reduce((s, n) => s + (n - mean) ** 2, 0) / scores.length;
    per_bucket[bucket] = {
      count: scores.length,
      mean: Number(mean.toFixed(2)),
      stddev: Number(Math.sqrt(variance).toFixed(2)),
    };
  }

  const total = fixtures.length;
  const totalHits = band_hits.low + band_hits.mid + band_hits.high;
  const labelled = total - band_hits.none;
  const hit_rate = labelled > 0 ? Number((totalHits / labelled).toFixed(2)) : 0;

  const notes = [];
  // Drift heuristics:
  // - If all "high" fixtures scored low or mid (none in high), the
  //   heuristic systematically under-scores severity.
  const highMisses = band_misses.filter(m => m.expected_band === 'high');
  if (highMisses.length > 0 && highMisses.every(m => m.actual_band !== 'high')) {
    notes.push('all "high" fixtures landed below high band — heuristic under-scores severity');
  }
  // - If hit rate < 0.5, calibration is poor.
  if (labelled >= 3 && hit_rate < 0.5) {
    notes.push(`hit rate ${(hit_rate * 100).toFixed(0)}% over ${labelled} fixtures — calibration drift likely`);
  }

  const report = renderReport({
    total, distribution, band_hits, band_misses, per_bucket, hit_rate, notes,
  });

  return {
    total,
    distribution,
    band_hits,
    band_misses,
    per_bucket,
    calibration: {
      hit_rate,
      drift_detected: notes.length > 0,
      notes,
    },
    report,
  };
}

function scoreToBand(score) {
  if (score >= BAND.high.min) return 'high';
  if (score >= BAND.mid.min) return 'mid';
  return 'low';
}

function renderReport({ total, distribution, band_hits, band_misses, per_bucket, hit_rate, notes }) {
  const lines = [];
  lines.push(`# Heuristic Scorer Calibration`);
  lines.push('');
  lines.push(`- **Total fixtures**: ${total}`);
  lines.push(`- **Hit rate**: ${(hit_rate * 100).toFixed(0)}% (low ${band_hits.low}, mid ${band_hits.mid}, high ${band_hits.high}, unlabelled ${band_hits.none})`);
  lines.push('');

  lines.push('## Score distribution');
  lines.push('');
  for (const score of Object.keys(distribution).sort((a, b) => Number(a) - Number(b))) {
    const count = distribution[score];
    if (count === 0) continue;
    lines.push(`- ${score}: ${'█'.repeat(count)} (${count})`);
  }
  lines.push('');

  if (Object.keys(per_bucket).length > 0) {
    lines.push('## Per-bucket statistics');
    lines.push('');
    for (const [bucket, stats] of Object.entries(per_bucket)) {
      lines.push(`- **${bucket}**: n=${stats.count} mean=${stats.mean} stddev=${stats.stddev}`);
    }
    lines.push('');
  }

  if (band_misses.length > 0) {
    lines.push('## Band misses (first 10)');
    lines.push('');
    for (const m of band_misses.slice(0, 10)) {
      lines.push(`- expected=${m.expected_band} actual=${m.actual_band}(${m.actual_score}): ${m.insight_label}`);
    }
    lines.push('');
  }

  if (notes.length > 0) {
    lines.push('## Drift indicators');
    lines.push('');
    for (const n of notes) lines.push(`- ${n}`);
    lines.push('');
  }
  return lines.join('\n');
}

export const _internals = {
  BAND,
  scoreToBand,
  renderReport,
};

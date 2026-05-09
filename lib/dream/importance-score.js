// Importance scoring for Phase-2 ROUTE.
//
// Each Insight gets an integer score 1-10. Score gates downstream routing
// (importance ≥7 is required for reinforcement and promotion per ARCHITECTURE
// § 3.2 and ADR 002).
//
// The architecture mandates LLM-generated scoring in production. Tests must be
// deterministic and offline. So this module exposes:
//
//   scoreHeuristic(insight) → { score, rationale }
//     Rule-based scoring from bucket + signal-word matches. Default for
//     test/CI and as the offline fallback when an LLM provider is unreachable.
//
//   createOllamaScorer({ url, model }) → async (insight) → { score, rationale }
//     Provider stub. Hooks the Ollama HTTP API contract used elsewhere in the
//     vault (Qwen via `/ingest`). Implementation intentionally minimal — the
//     P5 launchd path will configure model + url; until then this is
//     mechanism-only and exercised by integration tests that require a live
//     Ollama. Unit tests use the heuristic.
//
//   scoreAll(insights, scorer) → Promise<ScoredInsight[]>
//     Drives a scorer over a list. Sequential to keep the cost predictable
//     (LLM scorers will batch internally if they want).
//
// ScoredInsight shape: { insight, score, rationale }

const BUCKET_BASE = {
  mistake: 7,
  correction: 8,
  'method-worked': 5,
  'didnt-work': 6,
  other: 4,
};

// Word-class bumps. Matched case-insensitively against insight.text.
// Each match adds its bump (capped at 10 overall).
const POSITIVE_BUMPS = [
  // Severity / criticality cues
  { re: /\b(critical|crash|broke[ns]?|broken|data[- ]loss|corruption|outage)\b/i, bump: 2 },
  { re: /\b(production|prod|live|shipped)\b/i, bump: 1 },
  { re: /\b(jj (?:said|corrected|told|asked)|jj's correction)\b/i, bump: 2 },
  { re: /\b(rule (?:fired|loaded|violated)|caveman check|phase[- ]gated|4-reviewer)\b/i, bump: 1 },
  { re: /\b(blocker|blocked|regression|recurrent|repeat)\b/i, bump: 1 },
];

const NEGATIVE_BUMPS = [
  // Markers of trivial / cleanup work
  { re: /\b(typo|nit|comment-only|whitespace|formatting only|cleanup|cosmetic|minor)\b/i, bump: -1 },
  { re: /\b(experiment|prototype|spike|throwaway)\b/i, bump: -1 },
];

const SCORE_MIN = 1;
const SCORE_MAX = 10;

function clamp(n) {
  if (n < SCORE_MIN) return SCORE_MIN;
  if (n > SCORE_MAX) return SCORE_MAX;
  return n;
}

/**
 * Deterministic heuristic scorer.
 *
 * @param {Insight} insight
 * @returns {{score: number, rationale: string}}
 */
export function scoreHeuristic(insight) {
  if (!insight) return { score: SCORE_MIN, rationale: 'no insight' };
  const base = BUCKET_BASE[insight.bucket] ?? BUCKET_BASE.other;
  const text = String(insight.text || '');

  let bumps = 0;
  const matched = [];
  for (const { re, bump } of POSITIVE_BUMPS) {
    if (re.test(text)) { bumps += bump; matched.push(`+${bump}:${re.source.slice(0, 16)}`); }
  }
  for (const { re, bump } of NEGATIVE_BUMPS) {
    if (re.test(text)) { bumps += bump; matched.push(`${bump}:${re.source.slice(0, 16)}`); }
  }

  const score = clamp(base + bumps);
  const rationale = `bucket=${insight.bucket}(${base})${matched.length ? ' ' + matched.join(' ') : ''} → ${score}`;
  return { score, rationale };
}

/**
 * Ollama HTTP scorer factory. Returns an async fn `(insight) → {score, rationale}`.
 *
 * Stubbed mechanism: the network call is wired but the prompt template is the
 * minimum that produces parseable JSON. Production tuning lands in P5 along
 * with calibration prompts (the should-fix from MF-11 Should-Fix list).
 *
 * Falls back to the heuristic on ANY error (network down, parse failure, score
 * out-of-range). Failure is logged into the rationale string so the dream-log
 * shows the degraded path rather than silently misattributing scores.
 */
export function createOllamaScorer(opts = {}) {
  const {
    url = 'http://127.0.0.1:11434/api/generate',
    model = 'qwen2.5:14b-instruct',
    timeoutMs = 30_000,
    fallback = scoreHeuristic,
  } = opts;

  return async function scoreOllama(insight) {
    const prompt = ollamaPrompt(insight);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt, stream: false, format: 'json' }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const fb = fallback(insight);
        return { score: fb.score, rationale: `ollama HTTP ${res.status}; fallback: ${fb.rationale}` };
      }
      const body = await res.json();
      const parsed = JSON.parse(body.response || '{}');
      const score = clamp(Number.isFinite(parsed.score) ? Math.round(parsed.score) : NaN);
      if (!Number.isFinite(score)) {
        const fb = fallback(insight);
        return { score: fb.score, rationale: `ollama unparseable score; fallback: ${fb.rationale}` };
      }
      const rationale = String(parsed.rationale || '').slice(0, 200);
      return { score, rationale: `ollama:${model} ${rationale}` };
    } catch (e) {
      const fb = fallback(insight);
      return { score: fb.score, rationale: `ollama error '${e.code || e.name || 'unknown'}'; fallback: ${fb.rationale}` };
    } finally {
      clearTimeout(t);
    }
  };
}

function ollamaPrompt(insight) {
  return [
    'You are scoring a memory insight on importance from 1-10.',
    'Higher = more behavior-changing for an AI agent\'s next session. JJ\'s corrections and rule violations are highest signal; cleanup notes are lowest.',
    'Respond ONLY with JSON: {"score": <1-10 integer>, "rationale": "<≤30 words>"}.',
    '',
    `Insight (bucket=${insight.bucket}): ${String(insight.text || '').slice(0, 500)}`,
  ].join('\n');
}

/**
 * Apply a scorer over a list of insights, sequentially.
 *
 * @param {Array<Insight>} insights
 * @param {(insight) => Promise<{score, rationale}> | {score, rationale}} scorer
 * @returns {Promise<Array<{insight, score, rationale}>>}
 */
export async function scoreAll(insights, scorer = scoreHeuristic) {
  if (!Array.isArray(insights)) return [];
  const out = [];
  for (const insight of insights) {
    const { score, rationale } = await scorer(insight);
    out.push({ insight, score, rationale });
  }
  return out;
}

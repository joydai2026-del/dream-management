import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreHeuristic, createOllamaScorer, scoreAll } from '../lib/dream/importance-score.js';

function makeInsight(bucket, text) {
  return { id: 'x', source: 'journal', bucket, text, date: '2026-05-10', evidence: { path: 'p', lineNumber: 1 } };
}

test('scoreHeuristic returns bucket base for plain text', () => {
  assert.equal(scoreHeuristic(makeInsight('mistake', 'plain note')).score, 7);
  assert.equal(scoreHeuristic(makeInsight('correction', 'plain note')).score, 8);
  assert.equal(scoreHeuristic(makeInsight('method-worked', 'plain note')).score, 5);
  assert.equal(scoreHeuristic(makeInsight('didnt-work', 'plain note')).score, 6);
  assert.equal(scoreHeuristic(makeInsight('other', 'plain note')).score, 4);
});

test('scoreHeuristic bumps on severity / criticality cues', () => {
  const r = scoreHeuristic(makeInsight('mistake', 'broke production data-loss critical'));
  assert.ok(r.score >= 9, `expected ≥9, got ${r.score} (${r.rationale})`);
});

test('scoreHeuristic bumps on JJ correction phrasing', () => {
  const r = scoreHeuristic(makeInsight('correction', 'JJ said do it differently'));
  assert.ok(r.score >= 9, `expected ≥9, got ${r.score} (${r.rationale})`);
});

test('scoreHeuristic discounts trivial / cleanup cues', () => {
  const r = scoreHeuristic(makeInsight('correction', 'typo cleanup nit'));
  assert.ok(r.score <= 7, `expected ≤7, got ${r.score}`);
});

test('scoreHeuristic clamps to [1, 10]', () => {
  const high = scoreHeuristic(makeInsight('correction', 'critical broke production data-loss JJ corrected blocker recurrent regression'));
  assert.ok(high.score === 10);
  const low = scoreHeuristic(makeInsight('other', 'typo nit cleanup minor'));
  assert.ok(low.score >= 1);
});

test('scoreHeuristic returns rationale string mentioning bucket and matches', () => {
  const r = scoreHeuristic(makeInsight('mistake', 'JJ said critical'));
  assert.match(r.rationale, /bucket=mistake/);
  assert.match(r.rationale, /→\s*\d+/);
});

test('scoreAll iterates a list and keeps shape', async () => {
  const out = await scoreAll([
    makeInsight('mistake', 'a'),
    makeInsight('correction', 'JJ said critical'),
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].score, 7);
  assert.ok(out[1].score >= 9);
  assert.ok(out[1].rationale);
});

test('scoreAll accepts a custom synchronous scorer', async () => {
  const out = await scoreAll([makeInsight('other', 'x')], () => ({ score: 9, rationale: 'forced' }));
  assert.equal(out[0].score, 9);
  assert.equal(out[0].rationale, 'forced');
});

test('scoreAll handles empty / non-array inputs', async () => {
  assert.deepEqual(await scoreAll([]), []);
  assert.deepEqual(await scoreAll(null), []);
});

test('createOllamaScorer falls back to heuristic when fetch errors', async () => {
  // Point at a port nothing is listening on. Connection refused → catch → fallback.
  const scorer = createOllamaScorer({ url: 'http://127.0.0.1:1/api/generate', timeoutMs: 500 });
  const r = await scorer(makeInsight('mistake', 'plain note'));
  assert.equal(r.score, 7); // heuristic for mistake bucket
  assert.match(r.rationale, /ollama (error|HTTP)/);
});

test('createOllamaScorer falls back to heuristic on timeout', async () => {
  // Timeout 10ms against a non-listening endpoint reliably fires AbortError.
  const scorer = createOllamaScorer({ url: 'http://127.0.0.1:1/api/generate', timeoutMs: 10 });
  const r = await scorer(makeInsight('correction', 'JJ said critical'));
  assert.ok(r.score >= 9);
  assert.match(r.rationale, /(error|HTTP)/);
});

test('createOllamaScorer: success path parses score + rationale from API response', async () => {
  // Reviewer R1 (test-automator): the happy path was untested. Spin up a
  // minimal HTTP server that mimics Ollama's /api/generate JSON contract.
  const http = await import('node:http');
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        response: JSON.stringify({ score: 8, rationale: 'critical correction signal' }),
      }));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const scorer = createOllamaScorer({ url: `http://127.0.0.1:${port}/api/generate`, timeoutMs: 5000 });
    const r = await scorer(makeInsight('mistake', 'plain note'));
    assert.equal(r.score, 8);
    assert.match(r.rationale, /critical correction signal/);
    assert.match(r.rationale, /ollama:/);
  } finally {
    await new Promise(r => server.close(r));
  }
});

test('createOllamaScorer: HTTP non-200 falls back to heuristic with explicit rationale', async () => {
  const http = await import('node:http');
  const server = http.createServer((req, res) => {
    res.writeHead(503).end('upstream busy');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const scorer = createOllamaScorer({ url: `http://127.0.0.1:${port}/api/generate`, timeoutMs: 5000 });
    const r = await scorer(makeInsight('correction', 'plain note'));
    assert.equal(r.score, 8); // heuristic for correction bucket
    assert.match(r.rationale, /ollama HTTP 503/);
  } finally {
    await new Promise(r => server.close(r));
  }
});

test('createOllamaScorer: out-of-range score is clamped, not fallback', async () => {
  const http = await import('node:http');
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ response: JSON.stringify({ score: 99, rationale: 'hot' }) }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const scorer = createOllamaScorer({ url: `http://127.0.0.1:${port}/api/generate`, timeoutMs: 5000 });
    const r = await scorer(makeInsight('mistake', 'plain note'));
    assert.equal(r.score, 10); // clamped, not fallback
    assert.match(r.rationale, /ollama:/);
  } finally {
    await new Promise(r => server.close(r));
  }
});

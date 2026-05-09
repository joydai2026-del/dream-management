import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { collectInsights } from '../lib/dream/insights.js';

const memoryRoot = '/Users/example/agent';

function fakeReplay() {
  return {
    today: '2026-05-10',
    journal: {
      found: true,
      path: path.join(memoryRoot, 'learning-journals', '2026-05-10.md'),
      entries: [
        { time: '09:30', category: 'mistake', bucket: 'Mistakes', summary: 'forgot to cut a branch' },
        { time: '09:45', category: 'JJ-input', bucket: 'Corrections / JJ inputs', summary: 'JJ said cut a branch first' },
        { time: '10:15', category: 'method-worked', bucket: 'Methods that worked', summary: 'parallel batch saved 20 min' },
        { time: '11:00', category: 'random-tag', bucket: 'Other', summary: 'misc note' },
      ],
    },
    sessionLogs: {
      scanned: 1,
      withMarkers: 1,
      entries: [
        {
          date: '2026-05-09',
          name: '2026-05-09.md',
          path: path.join(memoryRoot, 'session-logs', '2026-05-09.md'),
          markers: [
            { lineNumber: 142, kind: 'correction', text: '- [11:00] [correction] JJ corrected the framing' },
            { lineNumber: 201, kind: 'method-worked', text: '- [11:30] [method-worked] 4-reviewer batch passed' },
          ],
        },
      ],
    },
    summary: {},
  };
}

test('collectInsights flattens journal + session markers into a uniform shape', () => {
  const insights = collectInsights(fakeReplay(), { memoryRoot });
  assert.equal(insights.length, 6);
  assert.equal(insights[0].source, 'journal');
  assert.equal(insights[0].bucket, 'mistake');
  assert.equal(insights[0].evidence.path, 'learning-journals/2026-05-10.md');
  assert.match(insights[0].id, /^journal:learning-journals\/2026-05-10\.md#L1$/);
  assert.equal(insights[1].bucket, 'correction');
  assert.equal(insights[2].bucket, 'method-worked');
  assert.equal(insights[3].bucket, 'other');
});

test('collectInsights normalizes session-marker entries with line numbers', () => {
  const insights = collectInsights(fakeReplay(), { memoryRoot });
  const markers = insights.filter(i => i.source === 'session-marker');
  assert.equal(markers.length, 2);
  assert.equal(markers[0].evidence.lineNumber, 142);
  assert.equal(markers[0].bucket, 'correction');
  assert.equal(markers[0].date, '2026-05-09');
  assert.equal(markers[1].bucket, 'method-worked');
});

test('collectInsights handles missing journal cleanly', () => {
  const replay = fakeReplay();
  replay.journal.found = false;
  replay.journal.entries = [];
  const insights = collectInsights(replay, { memoryRoot });
  assert.ok(insights.every(i => i.source === 'session-marker'));
});

test('collectInsights returns absolute path when memoryRoot omitted', () => {
  const insights = collectInsights(fakeReplay());
  assert.ok(insights[0].evidence.path.startsWith('/'));
});

test('collectInsights returns [] for null/empty input', () => {
  assert.deepEqual(collectInsights(null), []);
  assert.deepEqual(collectInsights({}), []);
});

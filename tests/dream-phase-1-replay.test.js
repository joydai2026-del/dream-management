import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  listSessionLogs,
  scanSessionMarkers,
  runReplay,
} from '../lib/dream/phase-1-replay.js';

async function tmpDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'dream-p1-'));
}

test('listSessionLogs returns date-stamped logs sorted ascending', async () => {
  const dir = await tmpDir();
  await fs.mkdir(path.join(dir, 'session-logs'));
  await fs.writeFile(path.join(dir, 'session-logs', '2026-05-07.md'), 'a');
  await fs.writeFile(path.join(dir, 'session-logs', '2026-05-09-late-3.md'), 'b');
  await fs.writeFile(path.join(dir, 'session-logs', 'README.md'), 'skip me');
  await fs.writeFile(path.join(dir, 'session-logs', '2026-05-08.md'), 'c');
  const logs = await listSessionLogs(dir);
  assert.deepEqual(logs.map(l => l.date), ['2026-05-07', '2026-05-08', '2026-05-09']);
});

test('listSessionLogs --since filters older entries out', async () => {
  const dir = await tmpDir();
  await fs.mkdir(path.join(dir, 'session-logs'));
  await fs.writeFile(path.join(dir, 'session-logs', '2026-05-01.md'), 'a');
  await fs.writeFile(path.join(dir, 'session-logs', '2026-05-08.md'), 'b');
  await fs.writeFile(path.join(dir, 'session-logs', '2026-05-09.md'), 'c');
  const logs = await listSessionLogs(dir, { since: '2026-05-08' });
  assert.deepEqual(logs.map(l => l.date), ['2026-05-08', '2026-05-09']);
});

test('listSessionLogs returns [] when session-logs dir missing', async () => {
  const dir = await tmpDir();
  const logs = await listSessionLogs(dir);
  assert.deepEqual(logs, []);
});

test('listSessionLogs throws on invalid --since', async () => {
  const dir = await tmpDir();
  await fs.mkdir(path.join(dir, 'session-logs'));
  await assert.rejects(() => listSessionLogs(dir, { since: 'yesterday' }));
});

test('scanSessionMarkers extracts the four MF-10 marker kinds', async () => {
  const dir = await tmpDir();
  const fp = path.join(dir, 'log.md');
  await fs.writeFile(fp, [
    '# Session log',
    '',
    '- [09:00] [correction] JJ said cut a branch first',
    '- [09:30] [mistake] forgot to fetch origin',
    'normal prose',
    '- [10:15] [method-worked] parallel agent batch saved 20min',
    '- [11:00] [didnt-work] sed pattern matched empty line',
    '- [11:30] [other] random tag, ignored',
  ].join('\n'));
  const markers = await scanSessionMarkers(fp);
  assert.equal(markers.length, 4);
  assert.deepEqual(
    markers.map(m => m.kind),
    ['correction', 'mistake', 'method-worked', 'didnt-work'],
  );
  assert.equal(markers[0].lineNumber, 3);
});

test('scanSessionMarkers is case-insensitive on the marker tag', async () => {
  const dir = await tmpDir();
  const fp = path.join(dir, 'log.md');
  await fs.writeFile(fp, '- [09:00] [Correction] JJ\n- [09:30] [MISTAKE] x\n');
  const markers = await scanSessionMarkers(fp);
  assert.equal(markers.length, 2);
  assert.equal(markers[0].kind, 'correction');
  assert.equal(markers[1].kind, 'mistake');
});

test('runReplay combines journal + session-log markers', async () => {
  const dir = await tmpDir();
  await fs.mkdir(path.join(dir, 'learning-journals'));
  await fs.writeFile(path.join(dir, 'learning-journals', '2026-05-09.md'), [
    '## Entries',
    '- [09:00] [mistake] X',
    '- [09:15] [correction] JJ said Y',
  ].join('\n'));
  await fs.mkdir(path.join(dir, 'session-logs'));
  await fs.writeFile(path.join(dir, 'session-logs', '2026-05-08.md'), [
    '- [11:00] [correction] something',
    '- [11:30] [method-worked] something else',
  ].join('\n'));
  await fs.writeFile(path.join(dir, 'session-logs', '2026-05-09.md'), '## empty\n');

  const replay = await runReplay({ memoryRoot: dir, today: '2026-05-09', since: '2026-05-07' });
  assert.equal(replay.journal.found, true);
  assert.equal(replay.journal.entries.length, 2);
  assert.equal(replay.sessionLogs.scanned, 2);
  assert.equal(replay.sessionLogs.withMarkers, 1);
  assert.equal(replay.summary.sessionMarkersByKind.correction, 1);
  assert.equal(replay.summary.sessionMarkersByKind['method-worked'], 1);
  assert.equal(replay.summary.journalEntriesByBucket.Mistakes, 1);
});

test('runReplay tolerates a missing journal file', async () => {
  const dir = await tmpDir();
  const replay = await runReplay({ memoryRoot: dir, today: '2026-05-09' });
  assert.equal(replay.journal.found, false);
  assert.equal(replay.journal.entries.length, 0);
  assert.equal(replay.sessionLogs.scanned, 0);
});

test('runReplay requires memoryRoot and today', async () => {
  await assert.rejects(() => runReplay({ today: '2026-05-09' }));
  await assert.rejects(() => runReplay({ memoryRoot: '/tmp' }));
});

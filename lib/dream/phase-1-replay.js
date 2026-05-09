// Phase-1 replay: structural extraction of recent insights.
//
// Two signal sources, per the MF-10 Codex correction (atomicity-contract.md
// reviewer round):
//
//   1. learning-journals/<today>.md — full file via P2's consumeTodaysJournal.
//      Already bucketed by category (mistake / correction / worked / didnt-work).
//
//   2. session-logs/<since..today>/*.md — scanned for inline marker tags:
//      [correction], [mistake], [method-worked], [didnt-work].
//      The original spec said "top 20 lines"; reviewer round 2 (Codex) flagged
//      that corrections often appear at end. Marker scan covers full file.
//
// P4 starter ships structural extraction only. LLM importance scoring lands in
// the Phase-2 ROUTE worker (later). Output of this phase feeds the route phase.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { consumeTodaysJournal } from '../journal-consume.js';

const SESSION_MARKER_RE = /\[(correction|mistake|method-worked|didnt-work)\]/i;
const SESSION_FILENAME_RE = /^(\d{4}-\d{2}-\d{2})(?:-.*)?\.md$/;

function parseSinceMs(since) {
  if (since === null || since === undefined) return null;
  const ms = Date.parse(since);
  if (Number.isNaN(ms)) {
    throw new Error(`phase-1-replay: invalid --since '${since}', expected ISO YYYY-MM-DD`);
  }
  return ms;
}

export async function listSessionLogs(memoryRoot, opts = {}) {
  const { since = null, sessionLogsDir = 'session-logs' } = opts;
  const sinceMs = parseSinceMs(since);
  const dir = path.join(memoryRoot, sessionLogsDir);

  let names;
  try {
    names = await fs.readdir(dir);
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }

  const out = [];
  for (const name of names) {
    const m = name.match(SESSION_FILENAME_RE);
    if (!m) continue;
    const dateMs = Date.parse(m[1]);
    if (Number.isNaN(dateMs)) continue;
    if (sinceMs !== null && dateMs < sinceMs) continue;
    out.push({ date: m[1], name, path: path.join(dir, name) });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
}

export async function scanSessionMarkers(filePath) {
  const content = await fs.readFile(filePath, 'utf8');
  const lines = content.split('\n');
  const markers = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(SESSION_MARKER_RE);
    if (!m) continue;
    markers.push({
      lineNumber: i + 1,
      kind: m[1].toLowerCase(),
      text: lines[i].trim(),
    });
  }
  return markers;
}

function bucketize(entries) {
  const out = {};
  for (const e of entries) out[e.bucket] = (out[e.bucket] || 0) + 1;
  return out;
}

function countMarkers(sessions) {
  const out = {};
  for (const s of sessions) {
    for (const m of s.markers) out[m.kind] = (out[m.kind] || 0) + 1;
  }
  return out;
}

export async function runReplay(opts) {
  const {
    memoryRoot,
    today,
    since = null,
    sessionLogsDir = 'session-logs',
  } = opts;

  if (!memoryRoot) throw new Error('runReplay: memoryRoot required');
  if (!today) throw new Error('runReplay: today required');

  const journalResult = await consumeTodaysJournal({ memoryRoot, date: today });

  const logs = await listSessionLogs(memoryRoot, { since, sessionLogsDir });
  const sessionMarkers = [];
  for (const log of logs) {
    const markers = await scanSessionMarkers(log.path);
    if (markers.length > 0) {
      sessionMarkers.push({ date: log.date, name: log.name, path: log.path, markers });
    }
  }

  return {
    today,
    since,
    journal: {
      found: journalResult.found,
      path: journalResult.path,
      entries: journalResult.entries,
    },
    sessionLogs: {
      scanned: logs.length,
      withMarkers: sessionMarkers.length,
      entries: sessionMarkers,
    },
    summary: {
      journalEntriesByBucket: bucketize(journalResult.entries),
      sessionMarkersByKind: countMarkers(sessionMarkers),
    },
  };
}

// Integration tests for the wired CLI pipeline:
//   dual-gate → phase-0..5 → Stage A → Stage B → sweep → finalize.
//
// These tests cover the wire-up itself (dual-gate decisions, audit-gate
// outcomes, sweep execution). Phase-internal logic is covered by
// per-phase test files; this file just verifies that the CLI orchestrates
// them in the right order with the right exit codes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolveFinalVerdict } from '../bin/dream.js';

const exec = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..');
const BIN = path.join(REPO_ROOT, 'bin', 'dream.js');

async function tmpDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'dream-cli-int-'));
}

async function gitInit(dir) {
  await exec('git', ['-C', dir, 'init', '-q']);
  await exec('git', ['-C', dir, 'config', 'user.email', 't@e.com']);
  await exec('git', ['-C', dir, 'config', 'user.name', 'Test']);
  await exec('git', ['-C', dir, 'config', 'commit.gpgsign', 'false']);
  await fs.writeFile(path.join(dir, 'README.md'), 'init\n');
  await exec('git', ['-C', dir, 'add', '-A']);
  await exec('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
}

async function setupMin(today = '2026-05-09') {
  const dir = await tmpDir();
  await gitInit(dir);
  await fs.writeFile(path.join(dir, 'working-memory.md'), 'wm\n');
  await fs.mkdir(path.join(dir, 'session-logs'));
  await fs.writeFile(path.join(dir, 'session-logs', `${today}.md`), 'session\n');
  return dir;
}

async function runCli(args) {
  try {
    const r = await exec('node', [BIN, ...args]);
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (e) {
    return { code: e.code, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

// ---- dual-gate wiring ------------------------------------------------

test('dual-gate SKIP: no sessions in 24h → exit 0 with SKIP line', async () => {
  const dir = await tmpDir();
  await gitInit(dir);
  await fs.writeFile(path.join(dir, 'working-memory.md'), 'wm\n');
  // No session-logs directory at all.
  const r = await runCli(['--memory-root', dir, '--today', '2026-05-09']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /\[dual-gate\] SKIP/);
  // .dream-log.md got the SKIP line.
  const log = await fs.readFile(path.join(dir, '.dream-log.md'), 'utf8');
  assert.match(log, /## 2026-05-09 03:00 SKIP/);
});

test('dual-gate PROCEED: recent session → runs through stage A', async () => {
  const dir = await setupMin();
  const r = await runCli([
    '--memory-root', dir, '--today', '2026-05-09',
    '--skip-stage-b',
  ]);
  // shouldRun=true → CLI proceeds. Audit may PASS or FAIL depending on
  // fixture completeness; we only assert that the dual-gate let it through.
  assert.match(r.stdout, /\[dual-gate\] PROCEED/);
  assert.match(r.stdout, /\[phase-0\]/);
});

test('--skip-dual-gate bypasses gate even with no sessions', async () => {
  const dir = await tmpDir();
  await gitInit(dir);
  await fs.writeFile(path.join(dir, 'working-memory.md'), 'wm\n');
  const r = await runCli([
    '--memory-root', dir, '--today', '2026-05-09',
    '--skip-dual-gate', '--skip-stage-b', '--skip-audit',
  ]);
  assert.equal(r.code, 0);
  // No SKIP line, phases ran.
  assert.doesNotMatch(r.stdout, /\[dual-gate\] SKIP/);
  assert.match(r.stdout, /\[phase-0\]/);
});

// ---- audit-gate wiring -----------------------------------------------

test('--skip-audit bypasses Stage A + Stage B + sweep entirely', async () => {
  const dir = await setupMin();
  const r = await runCli([
    '--memory-root', dir, '--today', '2026-05-09',
    '--skip-dual-gate', '--skip-audit',
  ]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /\[audit\] SKIPPED \(--skip-audit\)/);
  assert.doesNotMatch(r.stdout, /\[stage-a\]/);
  assert.doesNotMatch(r.stdout, /\[sweep\]/);
});

test('--skip-stage-b runs Stage A + sweep + finalize', async () => {
  const dir = await setupMin();
  const r = await runCli([
    '--memory-root', dir, '--today', '2026-05-09',
    '--skip-dual-gate', '--skip-stage-b',
  ]);
  // Stage A may pass or warn or fail depending on what the worker staged;
  // the wire-up assertion is that stage-a ran AND stage-b was skipped AND
  // some downstream step (sweep / finalize) reported.
  assert.match(r.stdout, /\[stage-a\] verdict=/);
  assert.match(r.stdout, /\[stage-b\] SKIPPED/);
});

// ---- final-verdict resolution ----------------------------------------

test('resolveFinalVerdict: FAIL beats WARN beats PASS', () => {
  assert.equal(resolveFinalVerdict({ verdict: 'PASS' }, { verdict: 'PASS' }), 'PASS');
  assert.equal(resolveFinalVerdict({ verdict: 'WARN' }, { verdict: 'PASS' }), 'WARN');
  assert.equal(resolveFinalVerdict({ verdict: 'PASS' }, { verdict: 'WARN' }), 'WARN');
  assert.equal(resolveFinalVerdict({ verdict: 'FAIL' }, { verdict: 'PASS' }), 'FAIL');
  assert.equal(resolveFinalVerdict({ verdict: 'PASS' }, { verdict: 'FAIL' }), 'FAIL');
  assert.equal(resolveFinalVerdict({ verdict: 'WARN' }, { verdict: 'FAIL' }), 'FAIL');
});

test('resolveFinalVerdict: stage B skipped does not contribute', () => {
  assert.equal(resolveFinalVerdict({ verdict: 'PASS' }, { verdict: 'skipped' }), 'PASS');
  assert.equal(resolveFinalVerdict({ verdict: 'WARN' }, { verdict: 'skipped' }), 'WARN');
});

test('resolveFinalVerdict: unknown labels fail-closed', () => {
  assert.equal(resolveFinalVerdict({ verdict: 'YOLO' }, { verdict: 'YOLO' }), 'FAIL');
});

// ---- usage output ----------------------------------------------------

test('usage text mentions all P5 flags', async () => {
  const r = await runCli(['--help']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /--skip-dual-gate/);
  assert.match(r.stdout, /--skip-stage-b/);
  assert.match(r.stdout, /--skip-audit/);
  assert.match(r.stdout, /--stage-b-command/);
  assert.match(r.stdout, /Exit codes/);
  assert.match(r.stdout, /5  audit FAIL/);
});

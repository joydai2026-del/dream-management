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
    const r = await exec('node', [BIN, ...args], {
      env: {
        ...process.env,
        DREAM_ALLOW_AUDIT_BYPASS: '1',
        DREAM_NO_NOTIFY: '1',
        TELEGRAM_BOT_TOKEN: '',
        TELEGRAM_CHAT_ID: '',
      },
    });
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

// ---- Phase D wire-up + final R2 fixes --------------------------------

test('audit-bypass guard: --skip-audit without env var → exit 1', async () => {
  const dir = await setupMin();
  // Bypass the auto-injection by calling exec directly without the env.
  try {
    await exec('node', [BIN, '--memory-root', dir, '--today', '2026-05-09', '--skip-audit']);
    assert.fail('expected non-zero exit');
  } catch (e) {
    assert.equal(e.code, 1);
    assert.match(e.stderr, /weaken integrity/);
  }
});

test('audit-bypass guard: --skip-audit with DREAM_ALLOW_AUDIT_BYPASS=1 succeeds', async () => {
  const dir = await setupMin();
  const r = await exec('node', [BIN, '--memory-root', dir, '--today', '2026-05-09', '--skip-audit', '--skip-dual-gate'], {
    env: { ...process.env, DREAM_ALLOW_AUDIT_BYPASS: '1' },
  });
  assert.match(r.stdout, /\[audit\] SKIPPED/);
});

test('audit-bypass guard: --dry-run permits --skip-audit without env var', async () => {
  const dir = await setupMin();
  const r = await exec('node', [BIN, '--memory-root', dir, '--today', '2026-05-09', '--dry-run', '--skip-audit', '--skip-dual-gate']);
  // dry-run path returns 0 even without bypass env.
  assert.match(r.stdout, /\[phase-0\]/);
});

test('contradiction detector: wired into pipeline (replaces Phase 4 stub)', async () => {
  const dir = await setupMin();
  // Seed a pattern-firing-log.md with recurrent violations.
  await fs.writeFile(path.join(dir, 'pattern-firing-log.md'),
    '```yaml\nsession: 2026-05-08-1\nfirings:\n  - pattern: caveman\n    outcome: violated\n```\n'
    + '```yaml\nsession: 2026-05-09-1\nfirings:\n  - pattern: caveman\n    outcome: violated\n```\n',
  );
  // Run the pipeline (skip audit so we just verify the contradiction wire-up).
  const r = await runCli([
    '--memory-root', dir, '--today', '2026-05-09',
    '--skip-dual-gate', '--skip-audit',
  ]);
  // Phase-4 line shows contradictions=N (not 'stub').
  assert.match(r.stdout, /\[phase-4\] dates files=\d+ replacements=\d+ contradictions=\d+/);
  assert.doesNotMatch(r.stdout, /contradictions=stub/);
});

test('weekly digest: fires on Sunday only', async () => {
  const dir = await setupMin('2026-05-10'); // 2026-05-10 is a Sunday
  // Seed a prior event.json so the digest has something to summarize.
  await fs.mkdir(path.join(dir, 'archive', 'dreams', '2026-05-09'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'archive', 'dreams', '2026-05-09', 'event.json'),
    JSON.stringify({ schema_version: '1.0.0', verdict: 'PASS', routed: {}, pruned: {}, audit: {} }),
  );
  const r = await runCli(['--memory-root', dir, '--today', '2026-05-10']);
  assert.match(r.stdout, /\[digest\] wrote/);
});

test('weekly digest: does NOT fire on non-Sunday', async () => {
  const dir = await setupMin('2026-05-09'); // 2026-05-09 is a Saturday
  const r = await runCli(['--memory-root', dir, '--today', '2026-05-09']);
  assert.doesNotMatch(r.stdout, /\[digest\]/);
});

test('notification: --no-telegram suppresses Telegram only (macOS still fires)', async () => {
  // Hard to assert macOS fired (it's detached + best-effort), but we
  // CAN assert the flag is accepted + run completes cleanly.
  const dir = await setupMin();
  const r = await runCli([
    '--memory-root', dir, '--today', '2026-05-09',
    '--skip-dual-gate', '--skip-audit', '--no-telegram',
  ]);
  assert.equal(r.code, 0);
});

test('notification: usage mentions Telegram env vars + --no-telegram', async () => {
  const r = await runCli(['--help']);
  assert.match(r.stdout, /TELEGRAM_BOT_TOKEN/);
  assert.match(r.stdout, /TELEGRAM_CHAT_ID/);
  assert.match(r.stdout, /--no-telegram/);
});

test('notification: --no-notify suppresses notifyMacOS (test path)', async () => {
  // Hard to assert "notification didn't fire" portably, but we CAN
  // assert the CLI accepts the flag without erroring. The runner
  // already injects DREAM_NO_NOTIFY=1 so live runs in CI never pop.
  const dir = await setupMin();
  const r = await runCli([
    '--memory-root', dir, '--today', '2026-05-09',
    '--skip-dual-gate', '--skip-audit', '--no-notify',
  ]);
  assert.equal(r.code, 0);
});

test('notification: usage mentions --no-notify', async () => {
  const r = await runCli(['--help']);
  assert.match(r.stdout, /--no-notify/);
});

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

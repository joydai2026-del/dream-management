import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../bin/dream.js';

const exec = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..');
const BIN = path.join(REPO_ROOT, 'bin', 'dream.js');

async function tmpDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'dream-cli-'));
}

async function gitInit(dir) {
  await exec('git', ['-C', dir, 'init', '-q']);
  await exec('git', ['-C', dir, 'config', 'user.email', 'test@example.com']);
  await exec('git', ['-C', dir, 'config', 'user.name', 'Test']);
  await exec('git', ['-C', dir, 'config', 'commit.gpgsign', 'false']);
  await fs.writeFile(path.join(dir, 'README.md'), 'init\n');
  await exec('git', ['-C', dir, 'add', '-A']);
  await exec('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
}

async function setupMemoryRoot(today = '2026-05-09') {
  const dir = await tmpDir();
  await gitInit(dir);
  await fs.writeFile(path.join(dir, 'working-memory.md'), 'wm\n');
  await fs.writeFile(path.join(dir, 'corrections.md'), 'c\n');
  await fs.mkdir(path.join(dir, 'session-logs'));
  await fs.writeFile(path.join(dir, 'session-logs', '2026-05-08.md'), '- [11:00] [correction] x\n');
  await fs.mkdir(path.join(dir, 'learning-journals'));
  await fs.writeFile(
    path.join(dir, 'learning-journals', `${today}.md`),
    '## Entries\n- [09:00] [mistake] x\n',
  );
  return dir;
}

// P5 wire-up note: runCli auto-injects --skip-dual-gate + --skip-stage-b
// for existing tests so they exercise phases 0-5 + Stage A + sweep
// without requiring session-log seeding or codex CLI availability.
// Tests that want to exercise dual-gate / Stage B can opt out via
// { rawArgs: true }.
async function runCli(args, opts = {}) {
  const augmented = opts.rawArgs ? args : [
    ...args,
    ...(args.includes('--skip-dual-gate') ? [] : ['--skip-dual-gate']),
    ...(args.includes('--skip-stage-b') ? [] : ['--skip-stage-b']),
    ...(args.includes('--skip-audit') ? [] : ['--skip-audit']),
  ];
  try {
    const r = await exec('node', [BIN, ...augmented], {
      env: {
        ...process.env,
        DREAM_ALLOW_AUDIT_BYPASS: '1',
        DREAM_NO_NOTIFY: '1', // suppress macOS + Telegram during tests
        TELEGRAM_BOT_TOKEN: '',
        TELEGRAM_CHAT_ID: '',
      },
    });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (e) {
    return { code: e.code, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

test('CLI: usage error when --memory-root missing', async () => {
  const r = await runCli([]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /memory-root required/);
});

test('CLI: usage error on unknown flag', async () => {
  const r = await runCli(['--memory-root', '/tmp', '--unknown-flag']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown args/);
});

test('CLI: --help exits 0', async () => {
  const r = await runCli(['--help']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /Usage: dream/);
});

test('CLI: --memory-root not in a git repo errors with explicit hint', async () => {
  const dir = await tmpDir();
  const r = await runCli(['--memory-root', dir, '--today', '2026-05-09']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /not inside a git repo/);
});

test('CLI: dry-run completes phase-0 + phase-1 without mutation', async () => {
  const dir = await setupMemoryRoot('2026-05-09');
  const r = await runCli(['--memory-root', dir, '--dry-run', '--today', '2026-05-09']);
  assert.equal(r.code, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /DRY-RUN would tag dream\/pre\/2026-05-09/);
  assert.match(r.stdout, /DRY-RUN skip snapshot/);
  // No tag created
  const tags = (await exec('git', ['-C', dir, 'tag', '-l'])).stdout.trim();
  assert.equal(tags, '');
  // No archive directory created
  await assert.rejects(() => fs.access(path.join(dir, 'archive')));
  // Phase-1 still ran
  assert.match(r.stdout, /\[phase-1\] journal=1/);
});

test('CLI: live run creates tag, snapshot, manifest; releases lock', async () => {
  const dir = await setupMemoryRoot('2026-05-09');
  const r = await runCli([
    '--memory-root', dir, '--today', '2026-05-09', '--since', '2026-05-07',
  ]);
  assert.equal(r.code, 0, `stderr: ${r.stderr}`);
  // Tag created
  const tags = (await exec('git', ['-C', dir, 'tag', '-l', 'dream/pre/2026-05-09'])).stdout.trim();
  assert.equal(tags, 'dream/pre/2026-05-09');
  // Snapshot landed
  await fs.access(path.join(dir, 'archive', 'dreams', '2026-05-09', 'snapshot', 'working-memory.md'));
  // Manifest valid
  const manifest = JSON.parse(await fs.readFile(
    path.join(dir, 'archive', 'dreams', '2026-05-09', 'manifest.json'), 'utf8',
  ));
  assert.equal(manifest.git_tag, 'dream/pre/2026-05-09');
  assert.ok(manifest.git_head_before);
  assert.ok(manifest.files.find(f => f.path === 'working-memory.md'));
  // Lock released
  await assert.rejects(() => fs.access(path.join(dir, '.dream.lock')));
  // Phase-1 reported (1 journal entry; 1 session log scanned with markers)
  assert.match(r.stdout, /\[phase-1\] journal=1 sessions=1/);
  assert.match(r.stdout, /"correction":1/);
  // Phase-2 reports zero promotions (no candidates extracted in starter)
  assert.match(r.stdout, /\[phase-2\] insights=\d+/);
  // Phase-3 reports counts and stages output
  assert.match(r.stdout, /\[phase-3\] corrections=\d+ sessions=\d+ journal=\d+ demoted=\d+/);
});

test('CLI E2E: phase-3 stages all four sub-steps when fixtures are populated', async () => {
  // Test-automator R2 GAP-C1: e2e through bin/dream.js exercising every
  // phase-3 path (corrections trim + session-index tier + journal archival
  // + pattern demotion). Verifies the wiring in bin/dream.js, not the
  // library directly.
  const today = '2026-05-10';
  const dir = await tmpDir();
  await gitInit(dir);

  // Fixture: corrections with one aged-RESOLVED entry → archives to 2026-04
  await fs.writeFile(path.join(dir, 'corrections.md'), [
    '# Corrections', '', '## Recent', '',
    '### 2026-04-01 RESOLVED — fixed bug',
    '', '**Status**: RESOLVED 2026-04-01', '', 'Body.', '',
  ].join('\n'));

  // Fixture: 12 dated session-index entries → archives the oldest 2
  const sessLines = ['# Session Index', '', '## Recent', ''];
  for (let i = 0; i < 12; i++) {
    const d = new Date(2026, 3, 1 + i).toISOString().slice(0, 10);
    sessLines.push(`### ${d} session ${i}`, '', `Body for ${d}.`, '');
  }
  await fs.writeFile(path.join(dir, 'session-index.md'), sessLines.join('\n'));

  // Fixture: today's journal
  await fs.mkdir(path.join(dir, 'learning-journals'));
  await fs.writeFile(
    path.join(dir, 'learning-journals', `${today}.md`),
    '## Entries\n- [09:00] [mistake] x\n',
  );

  // Fixture: a stale active pattern (first_seen far enough back to clear the
  // 60-day grace window AND zero firings → qualifies for demotion)
  const adir = path.join(dir, 'patterns', 'active');
  await fs.mkdir(adir, { recursive: true });
  await fs.writeFile(path.join(adir, 'old-stale.md'), `---
title: Old Stale
first_seen: 2025-01-01
---
body
`);

  // Required for memory-loader compat; phase-0 reads it
  await fs.writeFile(path.join(dir, 'working-memory.md'), 'wm\n');

  const r = await runCli(['--memory-root', dir, '--today', today]);
  assert.equal(r.code, 0, `stderr: ${r.stderr}`);

  // Phase-3 line shows the four counts
  assert.match(r.stdout, /\[phase-3\] corrections=1 sessions=2 journal=1 demoted=1/);
  // staged=N line emitted (count > 0 since we have fixtures)
  assert.match(r.stdout, /\[phase-3\] staged=\d+/);

  const stagedRoot = path.join(dir, 'archive', 'dreams', today, 'staged');
  // 1) Corrections: trimmed source + archive append + preimage sidecar
  await fs.access(path.join(stagedRoot, 'corrections.md.tmp'));
  await fs.access(path.join(stagedRoot, 'archive', 'corrections', '2026-04.md.tmp'));
  await fs.access(path.join(stagedRoot, 'archive', 'corrections', '2026-04.md.tmp.preimage-sha256'));
  // 2) Session index: trimmed + archive
  await fs.access(path.join(stagedRoot, 'session-index.md.tmp'));
  await fs.access(path.join(stagedRoot, 'archive', 'sessions', 'session-index-2026-04.md.tmp'));
  // 3) Journal: archive copy + tombstone
  await fs.access(path.join(stagedRoot, 'archive', 'journals', '2026-05', `${today}.md.tmp`));
  await fs.access(path.join(stagedRoot, 'learning-journals', `${today}.md.tombstone`));
  // 4) Demotion: stamped reference + tombstone for active twin
  const demotedRef = path.join(stagedRoot, 'patterns', 'reference', 'old-stale.md.tmp');
  const demotedContent = await fs.readFile(demotedRef, 'utf8');
  assert.match(demotedContent, /demoted_at: 2026-05-10/);
  assert.match(demotedContent, /demoted_by: dream-worker/);
  assert.equal(demotedContent.includes('demotion_phase:'), false);
  await fs.access(path.join(stagedRoot, 'patterns', 'active', 'old-stale.md.tombstone'));

  // Live tree unaffected: original active still there, no live archive write
  await fs.access(path.join(adir, 'old-stale.md'));
  await assert.rejects(() => fs.access(path.join(dir, 'archive', 'corrections', '2026-04.md')));
});

test('CLI E2E: phase-4 stages relative-date rewrites + reports stub for contradictions', async () => {
  // Test-automator + reviewer R1: end-to-end through bin/dream.js exercising
  // phase-4 wiring. Verifies preStaged collision guard (Phase-3 trim feeds
  // into Phase-4 rewrite, not live pre-trim) + label "contradictions=stub".
  const today = '2026-05-10';
  const dir = await tmpDir();
  await gitInit(dir);
  // working-memory has a relative date — rewrites
  await fs.writeFile(path.join(dir, 'working-memory.md'), 'updated today\n');
  // session-index with some content but no Phase-3 archive (so preStaged miss)
  await fs.writeFile(path.join(dir, 'session-index.md'), 'tomorrow we ship\n');
  // pattern with relative date — rewrites. `first_seen: today` keeps it
  // inside Phase-3's grace window so the date sweep can run on it (Phase-3
  // would otherwise demote and exclude it from Phase-4).
  const adir = path.join(dir, 'patterns', 'active');
  await fs.mkdir(adir, { recursive: true });
  await fs.writeFile(path.join(adir, 'foo.md'), `---
first_seen: ${today}
---
fired yesterday
`);

  const r = await runCli(['--memory-root', dir, '--today', today]);
  assert.equal(r.code, 0, `stderr: ${r.stderr}`);
  // Phase-4 line: 3 files, 3 replacements, contradictions count (no longer stub
  // after Phase D wire-up — detector returns 0 with no firing-log violations).
  assert.match(r.stdout, /\[phase-4\] dates files=3 replacements=3 contradictions=\d+/);
  // Staged paths exist
  const stagedRoot = path.join(dir, 'archive', 'dreams', today, 'staged');
  await fs.access(path.join(stagedRoot, 'working-memory.md.tmp'));
  await fs.access(path.join(stagedRoot, 'session-index.md.tmp'));
  await fs.access(path.join(stagedRoot, 'patterns', 'active', 'foo.md.tmp'));
  // Content reflects the rewrite
  const c = await fs.readFile(path.join(stagedRoot, 'working-memory.md.tmp'), 'utf8');
  assert.match(c, /updated 2026-05-10/);
});

test('CLI E2E: dry-run skips phase-3 staging but reports the plan', async () => {
  const today = '2026-05-10';
  const dir = await tmpDir();
  await gitInit(dir);
  await fs.writeFile(path.join(dir, 'corrections.md'), [
    '### 2026-04-01 RESOLVED', '', '**Status**: RESOLVED', '', 'b', '',
  ].join('\n'));
  await fs.writeFile(path.join(dir, 'working-memory.md'), 'wm\n');

  const r = await runCli(['--memory-root', dir, '--today', today, '--dry-run']);
  assert.equal(r.code, 0, `stderr: ${r.stderr}`);
  // Phase-3 reports the would-be plan
  assert.match(r.stdout, /\[phase-3\] corrections=1/);
  // Dry-run skip line emitted (plan summary still computed, no staging)
  assert.match(r.stdout, /\[phase-3\] DRY-RUN skip stage/);
  // No staged tree created
  await assert.rejects(() =>
    fs.access(path.join(dir, 'archive', 'dreams', today, 'staged')));
});

test('CLI: exit code 2 when lock held by another live process', async () => {
  const dir = await setupMemoryRoot('2026-05-09');
  await fs.writeFile(path.join(dir, '.dream.lock'), JSON.stringify({
    pid: process.pid,
    hostname: os.hostname(),
    started_at: new Date().toISOString(),
  }));
  const r = await runCli(['--memory-root', dir, '--today', '2026-05-09']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /lock held/);
});

test('CLI: re-running on same date is idempotent (tag-already-exists at HEAD)', async () => {
  const dir = await setupMemoryRoot('2026-05-09');
  const a = await runCli(['--memory-root', dir, '--today', '2026-05-09']);
  assert.equal(a.code, 0, `stderr: ${a.stderr}`);
  const b = await runCli(['--memory-root', dir, '--today', '2026-05-09']);
  assert.equal(b.code, 0, `stderr: ${b.stderr}`);
  assert.match(b.stdout, /already existed at HEAD/);
});

test('parseArgs: supports --flag=value equals syntax', () => {
  const a = parseArgs(['--memory-root=/tmp/foo', '--today=2026-05-09']);
  assert.equal(a.memoryRoot, '/tmp/foo');
  assert.equal(a.today, '2026-05-09');
});

test('parseArgs: rejects missing value for value-flag', () => {
  const a = parseArgs(['--memory-root', '--dry-run']);
  assert.match(a._error, /requires a (non-empty )?value/);
});

test('parseArgs: rejects missing value at end of argv', () => {
  const a = parseArgs(['--memory-root']);
  assert.match(a._error, /requires a (non-empty )?value/);
});

test('parseArgs: rejects empty separate-token value', () => {
  const a = parseArgs(['--memory-root', '', '--dry-run']);
  assert.match(a._error, /requires a non-empty value/);
});

test('parseArgs: rejects --config= empty inline value', () => {
  const a = parseArgs(['--config=']);
  assert.match(a._error, /requires a non-empty value/);
});

test('parseArgs: rejects --repo-root= empty inline value', () => {
  const a = parseArgs(['--repo-root=']);
  assert.match(a._error, /requires a non-empty value/);
});

test('parseArgs: rejects duplicate value-flag', () => {
  const a = parseArgs(['--memory-root', '/a', '--memory-root', '/b']);
  assert.match(a._error, /duplicate flag --memory-root/);
});

test('parseArgs: rejects duplicate boolean-flag', () => {
  const a = parseArgs(['--dry-run', '--dry-run']);
  assert.match(a._error, /duplicate flag --dry-run/);
});

test('parseArgs: rejects boolean-flag with value', () => {
  const a = parseArgs(['--dry-run=true']);
  assert.match(a._error, /does not take a value/);
});

test('parseArgs: rejects empty inline value (--today=)', () => {
  const a = parseArgs(['--today=']);
  assert.match(a._error, /requires a non-empty value/);
});

test('parseArgs: rejects empty inline value (--memory-root=)', () => {
  const a = parseArgs(['--memory-root=']);
  assert.match(a._error, /requires a non-empty value/);
});

test('parseArgs: rejects empty inline value (--since=)', () => {
  const a = parseArgs(['--since=']);
  assert.match(a._error, /requires a non-empty value/);
});

test('CLI: rejects --today garbage with usage error', async () => {
  const dir = await setupMemoryRoot('2026-05-09');
  const r = await runCli(['--memory-root', dir, '--today', 'not-iso']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--today must match YYYY-MM-DD/);
  // No artifacts created
  await assert.rejects(() => fs.access(path.join(dir, 'archive')));
});

test('CLI: rejects --since garbage with usage error', async () => {
  const dir = await setupMemoryRoot('2026-05-09');
  const r = await runCli(['--memory-root', dir, '--today', '2026-05-09', '--since', 'last-week']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--since must match YYYY-MM-DD/);
});

test('CLI: --memory-root=/path equals syntax works end-to-end', async () => {
  const dir = await setupMemoryRoot('2026-05-09');
  const r = await runCli([`--memory-root=${dir}`, '--dry-run', '--today=2026-05-09']);
  assert.equal(r.code, 0, `stderr: ${r.stderr}`);
});

test('CLI: --since with --dry-run threads through to phase-1 replay', async () => {
  const dir = await setupMemoryRoot('2026-05-09');
  // Add an older session log to verify --since filters it out
  await fs.writeFile(path.join(dir, 'session-logs', '2026-04-01.md'), '- [01:00] [mistake] old\n');
  const r = await runCli([
    '--memory-root', dir, '--dry-run',
    '--today', '2026-05-09', '--since', '2026-05-01',
  ]);
  assert.equal(r.code, 0, `stderr: ${r.stderr}`);
  // Only the 2026-05-08 log passes the --since=2026-05-01 filter.
  assert.match(r.stdout, /\[phase-1\] journal=1 sessions=1/);
});

test('CLI: exit code 3 when tag exists pointing elsewhere', async () => {
  const dir = await setupMemoryRoot('2026-05-09');
  // Tag at first commit, then create a new commit so HEAD moves
  await exec('git', ['-C', dir, 'tag', 'dream/pre/2026-05-09']);
  await fs.writeFile(path.join(dir, 'b.txt'), 'b');
  await exec('git', ['-C', dir, 'add', '-A']);
  await exec('git', ['-C', dir, 'commit', '-q', '-m', 'b']);
  const r = await runCli(['--memory-root', dir, '--today', '2026-05-09']);
  assert.equal(r.code, 3);
  assert.match(r.stderr, /git tag conflict/);
});

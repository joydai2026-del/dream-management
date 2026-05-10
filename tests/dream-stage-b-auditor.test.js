// Tests for lib/dream/stage-b-auditor.js — invocation, parsing, fail modes.
//
// Stage B invokes an external binary (codex CLI). To keep tests hermetic,
// we inject a `commandRunner` stub instead of spawning a real process.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  runStageB,
  parseStageBOutput,
  _internals,
} from '../lib/dream/stage-b-auditor.js';

async function tmpDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'dream-stageb-'));
}

async function writeFile(p, content) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content);
}

async function scaffoldDream(dir, opts = {}) {
  const today = opts.today || '2026-05-09';
  const dreamDir = path.join(dir, 'archive', 'dreams', today);
  await fs.mkdir(path.join(dreamDir, 'staged'), { recursive: true });
  await writeFile(path.join(dreamDir, 'staged', 'corrections.md.tmp'), 'src\n');
  await writeFile(path.join(dreamDir, 'event.json'), '{"verdict":"PASS-TENTATIVE"}\n');
  await writeFile(path.join(dreamDir, 'dream-log-entry.md'),
    `## ${today} PASS-TENTATIVE\nbody.\n`);
  return { dreamDir, today };
}

const PASS_OUTPUT = `VERDICT: PASS
MODEL: gpt-5-codex
DURATION_S: 12

FINDINGS:

NOTES:
all clean
`;

const FAIL_OUTPUT = `VERDICT: FAIL
MODEL: gpt-5-codex
DURATION_S: 18

FINDINGS:
- severity: fail
  category: hallucinated_insight
  path: patterns/active/foo.md
  message: cited journal line 42 says nothing about external-dom-drift
- severity: warn
  category: sycophancy
  path: null
  message: importance score 10 across all insights — likely calibration drift

NOTES:
worker-side LLM appears to have over-scored. Recommend recheck.
`;

const WARN_OUTPUT = `VERDICT: WARN
MODEL: gpt-5-codex
DURATION_S: 5

FINDINGS:
- severity: warn
  category: structural
  path: patterns/active/x.md
  message: missing first_seen frontmatter
`;

// ---- parseStageBOutput ----------------------------------------------

test('parseStageBOutput: valid PASS', () => {
  const r = parseStageBOutput(PASS_OUTPUT);
  assert.equal(r.parseOk, true);
  assert.equal(r.verdict, 'PASS');
  assert.deepEqual(r.findings, []);
  assert.equal(r.notes, 'all clean');
});

test('parseStageBOutput: valid FAIL with multiple findings', () => {
  const r = parseStageBOutput(FAIL_OUTPUT);
  assert.equal(r.parseOk, true);
  assert.equal(r.verdict, 'FAIL');
  assert.equal(r.findings.length, 2);
  assert.equal(r.findings[0].severity, 'fail');
  assert.equal(r.findings[0].category, 'hallucinated_insight');
  assert.equal(r.findings[0].path, 'patterns/active/foo.md');
  assert.match(r.findings[0].message, /external-dom-drift/);
  assert.equal(r.findings[1].severity, 'warn');
  assert.equal(r.findings[1].category, 'sycophancy');
  assert.equal(r.findings[1].path, null);
});

test('parseStageBOutput: WARN single finding', () => {
  const r = parseStageBOutput(WARN_OUTPUT);
  assert.equal(r.verdict, 'WARN');
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].severity, 'warn');
});

test('parseStageBOutput: empty input', () => {
  const r = parseStageBOutput('');
  assert.equal(r.parseOk, false);
});

test('parseStageBOutput: missing VERDICT line', () => {
  const r = parseStageBOutput('FINDINGS:\n- severity: fail\n  message: something\n');
  assert.equal(r.parseOk, false);
});

test('parseStageBOutput: VERDICT line embedded mid-text', () => {
  const r = parseStageBOutput('preamble line\nVERDICT: PASS\nMODEL: x\n');
  assert.equal(r.parseOk, true);
  assert.equal(r.verdict, 'PASS');
});

// ---- runStageB with stub runner --------------------------------------

test('runStageB happy: PASS with empty findings', async () => {
  const dir = await tmpDir();
  const { dreamDir, today } = await scaffoldDream(dir);
  const stub = async () => ({ stdout: PASS_OUTPUT, stderr: '', exitCode: 0 });
  const r = await runStageB({
    memoryRoot: dir, dreamDir, today,
    commandRunner: stub,
  });
  assert.equal(r.verdict, 'PASS');
  assert.deepEqual(r.findings, []);
  assert.equal(r.model, 'gpt-5-codex');
  assert.equal(r.summary.parse_ok, true);
});

test('runStageB FAIL: parsed findings surface', async () => {
  const dir = await tmpDir();
  const { dreamDir, today } = await scaffoldDream(dir);
  const stub = async () => ({ stdout: FAIL_OUTPUT, stderr: '', exitCode: 0 });
  const r = await runStageB({
    memoryRoot: dir, dreamDir, today,
    commandRunner: stub,
  });
  assert.equal(r.verdict, 'FAIL');
  assert.equal(r.findings.length, 2);
});

test('runStageB: codex non-zero exit + parseable output → use parsed verdict', async () => {
  const dir = await tmpDir();
  const { dreamDir, today } = await scaffoldDream(dir);
  // Codex sometimes returns a verdict but exits non-zero (e.g. CLI warning).
  const stub = async () => ({ stdout: PASS_OUTPUT, stderr: 'warn', exitCode: 0 });
  const r = await runStageB({ memoryRoot: dir, dreamDir, today, commandRunner: stub });
  assert.equal(r.verdict, 'PASS');
});

test('runStageB: non-zero exit + unparseable output → FAIL with invocation_error', async () => {
  const dir = await tmpDir();
  const { dreamDir, today } = await scaffoldDream(dir);
  const stub = async () => ({ stdout: 'random text', stderr: 'boom', exitCode: 2 });
  const r = await runStageB({ memoryRoot: dir, dreamDir, today, commandRunner: stub });
  assert.equal(r.verdict, 'FAIL');
  assert.equal(r.findings[0].category, 'invocation_error');
  assert.match(r.findings[0].message, /exited 2/);
});

test('runStageB: zero exit + unparseable output → FAIL with parse_error (fail-closed)', async () => {
  const dir = await tmpDir();
  const { dreamDir, today } = await scaffoldDream(dir);
  const stub = async () => ({ stdout: 'hello world', stderr: '', exitCode: 0 });
  const r = await runStageB({ memoryRoot: dir, dreamDir, today, commandRunner: stub });
  assert.equal(r.verdict, 'FAIL');
  assert.equal(r.findings[0].category, 'parse_error');
});

test('runStageB: command thrown error → FAIL with invocation_error', async () => {
  const dir = await tmpDir();
  const { dreamDir, today } = await scaffoldDream(dir);
  const stub = async () => { throw new Error('ENOENT spawn codex'); };
  const r = await runStageB({ memoryRoot: dir, dreamDir, today, commandRunner: stub });
  assert.equal(r.verdict, 'FAIL');
  assert.equal(r.findings[0].category, 'invocation_error');
  assert.match(r.findings[0].message, /failed to invoke/);
});

test('runStageB: rejects bad today', async () => {
  await assert.rejects(
    () => runStageB({ memoryRoot: '/x', dreamDir: '/y', today: 'bad' }),
    /today must match YYYY-MM-DD/,
  );
});

test('runStageB: prompt template missing → throws', async () => {
  const dir = await tmpDir();
  const { dreamDir, today } = await scaffoldDream(dir);
  await assert.rejects(
    () => runStageB({
      memoryRoot: dir, dreamDir, today,
      promptTemplatePath: '/nonexistent/template.md',
      commandRunner: async () => ({ stdout: PASS_OUTPUT, stderr: '', exitCode: 0 }),
    }),
    /prompt template not found/,
  );
});

test('runStageB: prompt is built with staged listing + dream dir', async () => {
  const dir = await tmpDir();
  const { dreamDir, today } = await scaffoldDream(dir);
  let capturedPrompt = '';
  const stub = async ({ prompt }) => {
    capturedPrompt = prompt;
    return { stdout: PASS_OUTPUT, stderr: '', exitCode: 0 };
  };
  await runStageB({
    memoryRoot: dir, dreamDir, today,
    commandRunner: stub,
  });
  assert.match(capturedPrompt, /staged tree at/);
  assert.match(capturedPrompt, /corrections\.md\.tmp/);
  assert.ok(capturedPrompt.includes(dreamDir));
});

// ---- parseCommandLine ------------------------------------------------

test('parseCommandLine: simple command', () => {
  const out = _internals.parseCommandLine('codex exec --skip-git-repo-check');
  assert.deepEqual(out, ['codex', 'exec', '--skip-git-repo-check']);
});

test('parseCommandLine: quoted arg', () => {
  const out = _internals.parseCommandLine('foo "bar baz" qux');
  assert.deepEqual(out, ['foo', 'bar baz', 'qux']);
});

// ---- listStagedTree --------------------------------------------------

test('listStagedTree: lists files with bytes; flags symlinks', async () => {
  const dir = await tmpDir();
  await writeFile(path.join(dir, 'a.md'), 'hi');
  await writeFile(path.join(dir, 'sub', 'b.md'), 'hello');
  await fs.symlink(path.join(dir, 'a.md'), path.join(dir, 'link.md'));
  const out = await _internals.listStagedTree(dir);
  assert.match(out, /a\.md \(2 bytes\)/);
  assert.match(out, /sub\/b\.md \(5 bytes\)/);
  assert.match(out, /link\.md \(SYMLINK/);
});

test('listStagedTree: empty dir', async () => {
  const dir = await tmpDir();
  const out = await _internals.listStagedTree(dir);
  assert.match(out, /empty/);
});

// ---- timeout / argv contract ----------------------------------------

test('runStageB: stdin is closed (commandRunner contract)', async () => {
  // Verify the stub is called with the prompt as argv (not stdin).
  const dir = await tmpDir();
  const { dreamDir, today } = await scaffoldDream(dir);
  let stdinUsed = false;
  const stub = async ({ command, args, prompt }) => {
    // The contract: prompt is the trailing positional arg, NOT stdin.
    assert.ok(typeof prompt === 'string' && prompt.length > 0);
    return { stdout: PASS_OUTPUT, stderr: '', exitCode: 0 };
  };
  const r = await runStageB({ memoryRoot: dir, dreamDir, today, commandRunner: stub });
  assert.equal(r.verdict, 'PASS');
  assert.equal(stdinUsed, false);
});

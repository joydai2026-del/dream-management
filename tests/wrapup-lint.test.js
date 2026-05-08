import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { lintMemory } from '../lib/wrapup-lint.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const BIN = path.join(REPO_ROOT, 'bin', 'wrapup-lint.js');
const FIXTURE_PASS = path.join(__dirname, 'fixtures', 'working-memory-pass.md');
const FIXTURE_OVER = path.join(__dirname, 'fixtures', 'working-memory-over-cap.md');

async function tmpDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'dream-lint-'));
}

function baseConfig() {
  return {
    consumer_name: 'test',
    memory_root: '/will/be/overridden',
    tiers: {
      hot: {
        working_memory: 'working-memory.md',
        pre_action: 'pre-action.md',
        max_lines_working_memory: 80,
        max_lines_pre_action: 30,
      },
      warm: {
        corrections: 'corrections.md',
        session_index: 'session-index.md',
        max_lines_corrections: 150,
        max_lines_session_index: 200,
      },
    },
  };
}

async function setupValidMemory(dir) {
  await fs.copyFile(FIXTURE_PASS, path.join(dir, 'working-memory.md'));
  await fs.writeFile(path.join(dir, 'corrections.md'), 'short\n');
  await fs.writeFile(path.join(dir, 'session-index.md'), 'short\n');
}

async function writeConfig(dir, config) {
  const configPath = path.join(dir, 'dream.config.json');
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
  return configPath;
}

// ---------- library function ----------

test('lib PASS: working-memory.md within cap, pre-action.md absent', async () => {
  const dir = await tmpDir();
  await setupValidMemory(dir);
  const errors = await lintMemory({ memoryRoot: dir, config: baseConfig() });
  assert.deepEqual(errors, []);
});

test('lib FAIL: working-memory.md over cap', async () => {
  const dir = await tmpDir();
  await fs.copyFile(FIXTURE_OVER, path.join(dir, 'working-memory.md'));
  await fs.writeFile(path.join(dir, 'corrections.md'), 'short\n');
  await fs.writeFile(path.join(dir, 'session-index.md'), 'short\n');
  const errors = await lintMemory({ memoryRoot: dir, config: baseConfig() });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].kind, 'over-cap');
  assert.equal(errors[0].file, 'working-memory.md');
  assert.ok(errors[0].lines > 80);
});

test('lib FAIL: working-memory.md missing reports as missing (required)', async () => {
  const dir = await tmpDir();
  await fs.writeFile(path.join(dir, 'corrections.md'), 'short\n');
  await fs.writeFile(path.join(dir, 'session-index.md'), 'short\n');
  const errors = await lintMemory({ memoryRoot: dir, config: baseConfig() });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].kind, 'missing');
  assert.equal(errors[0].file, 'working-memory.md');
});

test('lib PASS: pre-action.md absence is OK (optional file)', async () => {
  const dir = await tmpDir();
  await setupValidMemory(dir);
  const errors = await lintMemory({ memoryRoot: dir, config: baseConfig() });
  assert.deepEqual(errors.filter(e => e.file === 'pre-action.md'), []);
});

test('lib FAIL: corrections.md over cap reports with archive hint', async () => {
  const dir = await tmpDir();
  await fs.copyFile(FIXTURE_PASS, path.join(dir, 'working-memory.md'));
  await fs.writeFile(path.join(dir, 'corrections.md'), 'x\n'.repeat(200));
  await fs.writeFile(path.join(dir, 'session-index.md'), 'short\n');
  const errors = await lintMemory({ memoryRoot: dir, config: baseConfig() });
  const ccErr = errors.find(e => e.file === 'corrections.md');
  assert.ok(ccErr, 'expected corrections.md error');
  assert.equal(ccErr.kind, 'over-cap');
  assert.match(ccErr.message, /corrections-ttl/);
});

test('lib FAIL: session-index.md over cap reports with tiering hint', async () => {
  const dir = await tmpDir();
  await fs.copyFile(FIXTURE_PASS, path.join(dir, 'working-memory.md'));
  await fs.writeFile(path.join(dir, 'corrections.md'), 'short\n');
  await fs.writeFile(path.join(dir, 'session-index.md'), 'x\n'.repeat(250));
  const errors = await lintMemory({ memoryRoot: dir, config: baseConfig() });
  const siErr = errors.find(e => e.file === 'session-index.md');
  assert.ok(siErr, 'expected session-index.md error');
  assert.match(siErr.message, /session-index-tier/);
});

test('lib FAIL: pre-action.md present and over cap reports', async () => {
  const dir = await tmpDir();
  await setupValidMemory(dir);
  await fs.writeFile(path.join(dir, 'pre-action.md'), 'rule\n'.repeat(50));
  const errors = await lintMemory({ memoryRoot: dir, config: baseConfig() });
  const paErr = errors.find(e => e.file === 'pre-action.md');
  assert.ok(paErr, 'expected pre-action.md error');
  assert.equal(paErr.kind, 'over-cap');
});

// ---------- CLI subprocess (verifies exit-code contract from SUCCESS-CRITERIA.md P1 #6) ----------

test('CLI PASS exits 0 with PASS message on stdout', async () => {
  const dir = await tmpDir();
  await setupValidMemory(dir);
  const configPath = await writeConfig(dir, { ...baseConfig(), memory_root: dir });
  const result = spawnSync('node', [BIN, '--config', configPath]);
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.match(result.stdout.toString(), /wrapup-lint PASS/);
});

test('CLI FAIL exits 1 on over-cap', async () => {
  const dir = await tmpDir();
  await fs.copyFile(FIXTURE_OVER, path.join(dir, 'working-memory.md'));
  await fs.writeFile(path.join(dir, 'corrections.md'), 'short\n');
  await fs.writeFile(path.join(dir, 'session-index.md'), 'short\n');
  const configPath = await writeConfig(dir, { ...baseConfig(), memory_root: dir });
  const result = spawnSync('node', [BIN, '--config', configPath]);
  assert.equal(result.status, 1);
  assert.match(result.stderr.toString(), /wrapup-lint FAIL/);
  assert.match(result.stderr.toString(), /over-cap/);
});

test('CLI FAIL exits 1 on missing required file', async () => {
  const dir = await tmpDir();
  // Missing working-memory.md
  await fs.writeFile(path.join(dir, 'corrections.md'), 'short\n');
  await fs.writeFile(path.join(dir, 'session-index.md'), 'short\n');
  const configPath = await writeConfig(dir, { ...baseConfig(), memory_root: dir });
  const result = spawnSync('node', [BIN, '--config', configPath]);
  assert.equal(result.status, 1);
  assert.match(result.stderr.toString(), /missing/);
});

test('CLI exits 2 on missing config arg', () => {
  const result = spawnSync('node', [BIN]);
  assert.equal(result.status, 2);
  assert.match(result.stderr.toString(), /--config/);
});

test('CLI exits 2 on bad config path', () => {
  const result = spawnSync('node', [BIN, '--config', '/nonexistent/dream.config.json']);
  assert.equal(result.status, 2);
  assert.match(result.stderr.toString(), /failed to read config/);
});

test('CLI --memory-root override takes precedence over config', async () => {
  const dir = await tmpDir();
  await setupValidMemory(dir);
  // Config points elsewhere; override forces our tmp dir
  const configPath = await writeConfig(dir, { ...baseConfig(), memory_root: '/wrong/path' });
  const result = spawnSync('node', [BIN, '--config', configPath, '--memory-root', dir]);
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
});

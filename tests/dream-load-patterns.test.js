import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadPatterns, findReferenceFrontmatter, _internals } from '../lib/dream/load-patterns.js';

async function tmpDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'dream-load-pat-'));
}

test('loadPatterns returns [] when patterns dir missing', async () => {
  const dir = await tmpDir();
  assert.deepEqual(await loadPatterns(dir, 'active'), []);
  assert.deepEqual(await loadPatterns(dir, 'reference'), []);
});

test('loadPatterns rejects unknown which arg', async () => {
  await assert.rejects(() => loadPatterns('/tmp', 'frozen'), /must be 'active' or 'reference'/);
});

test('loadPatterns parses identifier_stem from filename, scalar fields, list fields', async () => {
  const dir = await tmpDir();
  const adir = path.join(dir, 'patterns', 'active');
  await fs.mkdir(adir, { recursive: true });
  await fs.writeFile(path.join(adir, 'caveman-check.md'), `---
title: Caveman Check
sightings: 11
trigger_phrases:
  - caveman check
  - 'plain language'
  - 10-second skim
---

body
`);
  await fs.writeFile(path.join(adir, 'inline-list.md'), `---
title: Inline List
sightings: 4
trigger_phrases: [foo, "bar baz"]
---
`);
  // Skip non-md
  await fs.writeFile(path.join(adir, 'README'), 'ignored');

  const pats = await loadPatterns(dir, 'active');
  assert.equal(pats.length, 2);
  assert.equal(pats[0].name, 'caveman-check');
  assert.equal(pats[0].identifierStem, 'caveman-check');
  assert.equal(pats[0].sightings, 11);
  assert.deepEqual(pats[0].triggerPhrases, ['caveman check', 'plain language', '10-second skim']);

  assert.equal(pats[1].sightings, 4);
  assert.deepEqual(pats[1].triggerPhrases, ['foo', 'bar baz']);
});

test('loadPatterns tolerates missing or malformed frontmatter', async () => {
  const dir = await tmpDir();
  const adir = path.join(dir, 'patterns', 'active');
  await fs.mkdir(adir, { recursive: true });
  await fs.writeFile(path.join(adir, 'no-fm.md'), '# Just markdown\n\nbody\n');

  const pats = await loadPatterns(dir, 'active');
  assert.equal(pats.length, 1);
  assert.equal(pats[0].name, 'no-fm');
  assert.deepEqual(pats[0].triggerPhrases, []);
  assert.equal(pats[0].sightings, 0);
});

test('findReferenceFrontmatter returns null on missing slug', async () => {
  const dir = await tmpDir();
  const fm = await findReferenceFrontmatter(dir, 'missing-slug');
  assert.equal(fm, null);
});

test('findReferenceFrontmatter returns parsed frontmatter on hit (incl. bootstrap)', async () => {
  const dir = await tmpDir();
  const rdir = path.join(dir, 'patterns', 'reference');
  await fs.mkdir(rdir, { recursive: true });
  await fs.writeFile(path.join(rdir, 'foo.md'), `---
title: Foo
bootstrap: true
demotion_phase: p3-2026-05-09
sightings: 0
---
body
`);
  const fm = await findReferenceFrontmatter(dir, 'foo');
  assert.equal(fm.bootstrap, true);
  assert.equal(fm.demotion_phase, 'p3-2026-05-09');
  assert.equal(fm.sightings, 0);
});

test('parseScalars: coerces ints, bools, leaves strings', () => {
  const out = _internals.parseScalars(['title: t', 'sightings: 7', 'bootstrap: true', 'flag: false', 'phase: p3-2026-05-09'].join('\n'));
  assert.equal(out.title, 't');
  assert.equal(out.sightings, 7);
  assert.equal(out.bootstrap, true);
  assert.equal(out.flag, false);
  assert.equal(out.phase, 'p3-2026-05-09');
});

test('parseScalars: strips YAML inline comments from scalar values', () => {
  // Reality-checker R1 F4: `sightings: 11  # bumped` previously parsed as a
  // string and was coerced to 0, silently corrupting the next reinforcement.
  const out = _internals.parseScalars([
    'title: t  # main title',
    'sightings: 11  # bumped manually',
    'bootstrap: true # one-time concession',
    'phase: p3-2026-05-09',
  ].join('\n'));
  assert.equal(out.title, 't');
  assert.equal(out.sightings, 11);
  assert.equal(out.bootstrap, true);
  assert.equal(out.phase, 'p3-2026-05-09');
});

test('parseScalars: preserves # inside quoted strings', () => {
  const out = _internals.parseScalars([
    'title: "value # with hash"',
    "name: 'a # b'",
  ].join('\n'));
  assert.equal(out.title, 'value # with hash');
  assert.equal(out.name, 'a # b');
});

test('parseScalars: handles inline list with no outer comment', () => {
  const out = _internals.parseScalars('phrases: [foo, "bar baz"]');
  assert.deepEqual(out.phrases, ['foo', 'bar baz']);
});

test('parseScalars: strips inline comments from indented list items', () => {
  const out = _internals.parseScalars([
    'trigger_phrases:',
    '  - caveman check  # canonical',
    "  - 'plain language # not a comment'",
    '  - 10-second skim',
  ].join('\n'));
  assert.deepEqual(out.trigger_phrases, [
    'caveman check',
    'plain language # not a comment',
    '10-second skim',
  ]);
});

test('stripInlineComment: only fires on `space-#`, not bare `#`', () => {
  assert.equal(_internals.stripInlineComment('11  # comment'), '11 ');
  assert.equal(_internals.stripInlineComment('#tag'), '#tag');
  assert.equal(_internals.stripInlineComment('"quoted # value"'), '"quoted # value"');
  assert.equal(_internals.stripInlineComment(''), '');
});

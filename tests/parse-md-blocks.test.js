import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBlocks, serializeBlocks, blockDateISO } from '../lib/parse-md-blocks.js';

test('roundtrip: parse + serialize reproduces original content', () => {
  const input = [
    '---',
    'tags: [test]',
    '---',
    '',
    '## H2 group',
    '',
    '### Entry A (2026-01-15)',
    'body of A',
    '',
    '### Entry B (2026-02-20)',
    'body of B',
    'more body',
  ].join('\n');
  const blocks = parseBlocks(input);
  const out = serializeBlocks(blocks);
  assert.equal(out, input);
});

test('H2 line acts as a sep boundary, not absorbed into prior item body', () => {
  const input = [
    '### Entry A',
    'body A',
    '## H2 boundary',
    '### Entry B',
    'body B',
  ].join('\n');
  const blocks = parseBlocks(input);
  const types = blocks.map(b => b.type);
  assert.deepEqual(types, ['item', 'sep', 'item']);
  assert.equal(serializeBlocks(blocks), input);
});

test('item block detection: only H3 lines start items', () => {
  const input = [
    'preamble',
    '#### h4 not a section start',
    '### h3 is',
    'body',
  ].join('\n');
  const blocks = parseBlocks(input);
  const items = blocks.filter(b => b.type === 'item');
  assert.equal(items.length, 1);
  assert.equal(items[0].lines[0], '### h3 is');
});

test('blockDateISO extracts first ISO date', () => {
  const block = {
    type: 'item',
    lines: ['### Some heading from 2026-04-15', 'body without date'],
  };
  assert.equal(blockDateISO(block), '2026-04-15');
});

test('blockDateISO returns null when no date', () => {
  const block = { type: 'item', lines: ['### no date here', 'body'] };
  assert.equal(blockDateISO(block), null);
});

test('roundtrip preserves trailing newline', () => {
  const input = '### A\nbody\n';
  const blocks = parseBlocks(input);
  assert.equal(serializeBlocks(blocks), input);
});

test('empty file yields no blocks', () => {
  const blocks = parseBlocks('');
  // split('') → [''], one sep block with one empty line
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'sep');
});

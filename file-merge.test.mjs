import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeTextHunks, redactMergeDecisions } from './file-merge.mjs';

test('mergeTextHunks selects server, installer and manual hunks', () => {
  const left = 'a\nold-1\nkeep\nold-2\nz';
  const right = 'a\nnew-1\nkeep\nnew-2\nz';
  assert.equal(mergeTextHunks(left, right, { 0: 'server', 1: 'installer' }).targetText, 'a\nold-1\nkeep\nnew-2\nz');
  assert.equal(mergeTextHunks(left, right, { 0: { mode: 'manual', text: 'custom\nvalue' }, 1: 'server' }).targetText, 'a\ncustom\nvalue\nkeep\nold-2\nz');
});

test('mergeTextHunks reports unresolved hunks', () => {
  const result = mergeTextHunks('a\nb', 'a\nc', {});
  assert.deepEqual(result.unresolved, [0]);
});

test('redactMergeDecisions never stores manual plaintext', () => {
  assert.deepEqual(redactMergeDecisions({ 0: 'installer', 1: { mode: 'manual', text: 'secret' } }), {
    0: 'installer', 1: { mode: 'manual', text: '[redacted]', bytes: 6 },
  });
});

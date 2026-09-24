import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTarget,
  coerceManualValue,
  flatten,
  hasJsonComments,
  materialize,
  parseConfig,
  parseEnv,
  parseJsonc,
  reconcile,
  unflatten,
} from './config-reconcile.mjs';

test('parseJsonc keeps comment-like text inside strings and accepts JSONC', () => {
  const value = parseJsonc('\uFEFF{\n  // comment\n  "url": "http://host/a/*b",\n  "items": [1, 2,],\n}');
  assert.deepEqual(value, { url: 'http://host/a/*b', items: [1, 2] });
});

test('hasJsonComments ignores URL-like strings and detects actual comments', () => {
  assert.equal(hasJsonComments('{"url":"http://host/a/*b"}'), false);
  assert.equal(hasJsonComments('{// note\n"a":1}'), true);
  assert.equal(hasJsonComments('{"a":1/* note */}'), true);
});

test('parseEnv supports export, quotes and inline comments', () => {
  assert.deepEqual(parseEnv('export PORT=8080\nNAME="qa portal" # ignored\nEMPTY=\n# comment\n'), {
    PORT: '8080', NAME: 'qa portal', EMPTY: '',
  });
});

test('flatten and unflatten preserve nested values, arrays and empty nodes', () => {
  const source = { App: { Enabled: true, Ports: [80, 443], Empty: {}, Nothing: null }, Tags: [] };
  assert.deepEqual(unflatten(flatten(source)), source);
});

test('reconcile classifies all MVP verdicts and QA wins', () => {
  const result = reconcile(
    { same: 1, conflict: 1, old: 'keep', qa: 'server' },
    { same: 1, conflict: 2, added: 'new', qa: 'installer' },
    { qa: 'qa' },
  );
  assert.deepEqual(result.summary, {
    'new-from-installer': 1,
    conflict: 1,
    'backup-only': 1,
    'qa-override': 1,
    same: 1,
  });
  assert.equal(result.conflicts, 1);
  assert.equal(result.rows.find(row => row.key === 'qa').target, 'qa');
});

test('buildTarget reports unresolved conflicts and preserves selected-side types', () => {
  const result = reconcile({ n: 1, enabled: false }, { n: 2, enabled: true });
  assert.deepEqual(buildTarget(result).unresolved, ['enabled', 'n']);
  const built = buildTarget(result, { n: 'installer', enabled: 'backup' });
  assert.equal(built.flat.n, 2);
  assert.equal(typeof built.flat.n, 'number');
  assert.equal(built.flat.enabled, false);
  assert.equal(typeof built.flat.enabled, 'boolean');
});

test('coerceManualValue restores JSON scalar types without guessing', () => {
  assert.equal(coerceManualValue('8', { backup: 1, installer: 2 }), 8);
  assert.equal(coerceManualValue('false', { backup: true, installer: false }), false);
  assert.equal(coerceManualValue('null', { backup: null, installer: null }), null);
  assert.equal(coerceManualValue('  text  ', { backup: 'a', installer: 'b' }), '  text  ');
  assert.deepEqual(coerceManualValue('[1, 2,]', { backup: [], installer: [3] }), [1, 2]);
  assert.throws(() => coerceManualValue('eight', { backup: 1, installer: 2 }), /очікується число/);
  assert.throws(() => coerceManualValue('8', { backup: '1', installer: 2 }), /неоднозначний/);
  assert.equal(coerceManualValue('008', { backup: '1', installer: '2' }, 'env'), '008');
});

test('materialize emits valid typed JSON and semantic env text', () => {
  const json = materialize('appsettings.json', { 'A.Count': 8, 'A.Enabled': false, 'A.Value': null });
  assert.deepEqual(parseConfig('appsettings.json', json), { A: { Count: 8, Enabled: false, Value: null } });
  assert.equal(materialize('.env', { PORT: '008', EMPTY: '' }), 'PORT=008\nEMPTY=\n');
});

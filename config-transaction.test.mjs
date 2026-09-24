import test from 'node:test';
import assert from 'node:assert/strict';
import { assertRemoteConfigPath, transactionPaths, redactDecisions, containerHealth, isConfigApplyTransactionKind, isConfigBatchKind, summarizeBatchRollback, selectTransactionBaseline, selectLatestConfigBatch } from './config-transaction.mjs';

test('transaction paths stay beside the target', () => {
  assert.deepEqual(transactionPaths('/usr/local/rscore/volumes/config/appsettings.json', 'tx_123'), {
    target: '/usr/local/rscore/volumes/config/appsettings.json',
    temporary: '/usr/local/rscore/volumes/config/.appsettings.json.standwatch-tx_123.tmp',
    snapshot: '/usr/local/rscore/volumes/config/.appsettings.json.standwatch-tx_123.t2',
  });
});

test('remote config path permits managed YAML/scripts and rejects traversal/env', () => {
  assert.equal(assertRemoteConfigPath('/usr/local/rscore/volumes/config/api/envoy.yaml'), '/usr/local/rscore/volumes/config/api/envoy.yaml');
  assert.equal(assertRemoteConfigPath('/usr/local/rscore/home/02_platform.yml'), '/usr/local/rscore/home/02_platform.yml');
  assert.equal(assertRemoteConfigPath('/usr/local/rscore/scripts/update.sh'), '/usr/local/rscore/scripts/update.sh');
  assert.throws(() => assertRemoteConfigPath('/usr/local/../root/a.json'));
  assert.throws(() => assertRemoteConfigPath('/usr/local/rscore/.env'));
});

test('journal decision summary never keeps manual values', () => {
  const redacted = redactDecisions({ B: 'installer', A: { value: 'top-secret' }, C: 'server' });
  assert.deepEqual(redacted, [
    { key: 'A', source: 'manual' },
    { key: 'B', source: 'installer' },
    { key: 'C', source: 'backup' },
  ]);
  assert.equal(JSON.stringify(redacted).includes('top-secret'), false);
});

test('health requires running and healthy when Docker health exists', () => {
  const inspected = [
    { Name: '/a', RestartCount: 2, State: { Status: 'running', Health: { Status: 'healthy' } } },
    { Name: '/b', RestartCount: 0, State: { Status: 'running' } },
  ];
  assert.equal(containerHealth(inspected, ['a', 'b']).ok, true);
  inspected[0].State.Health.Status = 'unhealthy';
  assert.equal(containerHealth(inspected, ['a']).ok, false);
});

test('transaction baseline trusts only the latest completed matching SHA', () => {
  const one = '1'.repeat(64), two = '2'.repeat(64);
  const transactions = [
    { kind: 'json-config-apply', server: 's', group: 'g', path: 'a.json', status: 'applied', createdAt: '2026-01-01', completedAt: '2026-01-02', hashes: { before: one, target: two } },
    { kind: 'json-config-apply', server: 's', group: 'g', path: 'a.json', status: 'failed', createdAt: '2026-01-03', hashes: { before: two, target: one } },
  ];
  assert.equal(selectTransactionBaseline(transactions, { server: 's', group: 'g', path: 'a.json', liveSha256: two })?.expectedSha, two);
  assert.equal(selectTransactionBaseline(transactions, { server: 's', group: 'g', path: 'a.json', liveSha256: one }), null);
});

test('rolled back transaction verifies the before SHA', () => {
  const one = 'a'.repeat(64), two = 'b'.repeat(64);
  const value = { kind: 'json-config-apply', server: 's', group: 'g', path: 'a.json', status: 'rolled-back', rolledBackAt: '2026-01-04', hashes: { before: one, target: two } };
  assert.equal(selectTransactionBaseline([value], { server: 's', group: 'g', path: 'a.json', liveSha256: one })?.expectedSha, one);
});

test('DEBUG file transaction is eligible for rollback and becomes a verified baseline', () => {
  const before = 'c'.repeat(64), target = 'd'.repeat(64);
  const value = { kind: 'config-file-debug-apply', server: 's', group: 'g', path: 'a.json', status: 'applied', completedAt: '2026-01-05', hashes: { before, target } };
  assert.equal(isConfigApplyTransactionKind(value.kind), true);
  assert.equal(selectTransactionBaseline([value], { server: 's', group: 'g', path: 'a.json', liveSha256: target })?.expectedSha, target);
});

test('latest config batch never falls back to an older applied package', () => {
  const latest = selectLatestConfigBatch([
    { id: 'older', kind: 'config-file-batch', server: 'QA', group: 'rscore', status: 'applied', completedAt: '2026-09-20T10:00:00Z' },
    { id: 'newer', kind: 'config-file-debug-batch', server: 'QA', group: 'rscore', status: 'applied', completedAt: '2026-09-21T10:00:00Z' },
  ], { server: 'QA', group: 'rscore' });
  assert.equal(latest.id, 'newer');
});

test('latest config batch includes terminal operations so UI cannot silently step backwards', () => {
  const latest = selectLatestConfigBatch([
    { id: 'older-active', kind: 'config-file-batch', server: 'QA', group: 'rscore', status: 'applied', completedAt: '2026-09-20T10:00:00Z' },
    { id: 'newer-rolled-back', kind: 'config-file-batch', server: 'QA', group: 'rscore', status: 'rolled-back', completedAt: '2026-09-21T10:00:00Z' },
  ], { server: 'QA', group: 'rscore' });
  assert.equal(latest.id, 'newer-rolled-back');
});

test('batch rollback kinds and progress have durable terminal states', () => {
  assert.equal(isConfigBatchKind('config-file-batch'), true);
  assert.equal(isConfigBatchKind('config-file-debug-batch'), true);
  assert.equal(isConfigBatchKind('config-file-apply'), false);
  assert.deepEqual(summarizeBatchRollback([
    { status: 'rolled-back' },
    { status: 'rollback-failed' },
    { status: 'applied' },
  ]), {
    total: 3,
    rolledBack: 1,
    failed: 1,
    pending: 1,
    completed: 2,
    status: 'rollback-partial',
  });
  assert.equal(summarizeBatchRollback([{ status: 'rolled-back' }]).status, 'rolled-back');
  assert.equal(summarizeBatchRollback([{ status: 'rollback-failed' }]).status, 'rollback-failed');
  assert.equal(summarizeBatchRollback([{ status: 'applied' }]).status, 'rollback-in-progress');
});

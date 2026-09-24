import test from 'node:test';
import assert from 'node:assert/strict';
import { collectServerRenameBlockers } from './server-state-safety.mjs';

test('server rename is blocked while plans or transactions still reference the display name', () => {
  const result = collectServerRenameBlockers({
    serverName: 'Poruch QA',
    catalog: {
      serverProjects: { 'Poruch QA': 'poruch' },
      installRoots: { 'Poruch QA|rscore|vpo/installer': '/usr/local/rscore' },
      filePolicies: { 'Poruch QA|rscore|vpo/installer|envoy_dev.yaml': 'ignored' },
      groupInstaller: { 'Poruch QA|rscore': 'vpo/installer' },
    },
    plans: [{ server: 'Poruch QA' }, { server: 'Other' }],
    transactions: [{ server: 'Poruch QA' }],
  });
  assert.deepEqual(result, { plans: 1, transactions: 1, catalogKeys: 4, blocked: true });
});

test('server without durable history remains renameable', () => {
  const result = collectServerRenameBlockers({
    serverName: 'New QA',
    catalog: { serverProjects: { 'New QA': 'project' } },
    plans: [],
    transactions: [],
  });
  assert.equal(result.blocked, false);
  assert.equal(result.catalogKeys, 1);
});


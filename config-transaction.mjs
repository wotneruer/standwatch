const safeToken = value => /^[A-Za-z0-9_.-]+$/.test(String(value || ''));

export function assertTransactionId(value) {
  const id = String(value || '');
  if (!safeToken(id) || id.length > 120) throw new Error('некоректний transaction id');
  return id;
}

export function assertRemoteConfigPath(value) {
  const path = String(value || '').replace(/\/+$/, '');
  const allowed = /^\/usr\/local\/[A-Za-z0-9._-]+\/(?:volumes\/config\/[A-Za-z0-9._/-]+\.(?:json|ya?ml)|home\/[A-Za-z0-9._/-]+\.ya?ml|scripts\/[A-Za-z0-9._/-]+\.sh)$/i;
  if (!allowed.test(path) || path.includes('..') || /[\r\n\0]/.test(path)) {
    throw new Error('некоректний або недозволений шлях конфіг-файла');
  }
  return path;
}

export function transactionPaths(absolutePath, transactionId) {
  const target = assertRemoteConfigPath(absolutePath);
  const id = assertTransactionId(transactionId);
  const slash = target.lastIndexOf('/');
  const directory = target.slice(0, slash) || '/';
  const name = target.slice(slash + 1);
  return {
    target,
    temporary: `${directory}/.${name}.standwatch-${id}.tmp`,
    snapshot: `${directory}/.${name}.standwatch-${id}.t2`,
  };
}

// Values are deliberately excluded. A transaction journal must be useful for
// audit/rollback without becoming another plaintext configuration store.
export function redactDecisions(decisions = {}) {
  return Object.entries(decisions).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => ({
    key,
    source: value && typeof value === 'object' && 'value' in value ? 'manual' : value === 'installer' ? 'installer' : 'backup',
  }));
}

export function containerHealth(inspected, expected = []) {
  const byName = new Map((Array.isArray(inspected) ? inspected : []).map(item => [String(item?.Name || '').replace(/^\//, ''), item]));
  const rows = expected.map(name => {
    const item = byName.get(name);
    const state = item?.State || {};
    const health = state.Health?.Status || null;
    return {
      name,
      found: !!item,
      state: String(state.Status || ''),
      health,
      restartCount: Number(item?.RestartCount || 0),
      ok: !!item && state.Status === 'running' && (!health || health === 'healthy'),
    };
  });
  return { ok: rows.length > 0 && rows.every(row => row.ok), rows };
}

export function isConfigApplyTransactionKind(kind) {
  return ['json-config-apply', 'config-file-apply', 'config-file-debug-apply'].includes(kind);
}

export function selectTransactionBaseline(transactions, { server, group, path, liveSha256 }) {
  const candidates = (Array.isArray(transactions) ? transactions : []).flatMap(value => {
    if (!isConfigApplyTransactionKind(value?.kind) || value.server !== server || value.group !== group || value.path !== path) return [];
    const rolledBack = ['rolled-back', 'rolled-back-automatically'].includes(value.status);
    if (value.status !== 'applied' && !rolledBack) return [];
    const expectedSha = rolledBack ? value.hashes?.before : value.hashes?.target;
    if (!/^[0-9a-f]{64}$/.test(expectedSha || '')) return [];
    return [{ value, expectedSha, createdAt: value.rolledBackAt || value.completedAt || value.createdAt || '' }];
  }).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const latest = candidates[0];
  return latest && latest.expectedSha === liveSha256 ? latest : null;
}

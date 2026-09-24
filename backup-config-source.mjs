import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const safeJson = path => {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
};

const matchesBinding = (restorePoint, binding) => {
  if (!binding) return true;
  const target = restorePoint?.target || {};
  if (binding.project && target.project !== binding.project) return false;
  const wanted = String(binding.ref || '');
  if (!wanted) return true;
  return [target.ref, target.commit?.id, target.commit?.shortId].filter(Boolean).some(value => {
    const actual = String(value);
    return actual === wanted || actual.startsWith(wanted) || wanted.startsWith(actual);
  });
};

export function restorePointSnapshotSha256(restorePoint) {
  const artifacts = (Array.isArray(restorePoint?.artifacts) ? restorePoint.artifacts : []).map(item => ({
    kind: item.kind || null, name: item.name || null, bytes: Number(item.bytes) || 0, sha256: item.sha256 || null,
  }));
  return createHash('sha256').update(JSON.stringify({
    planId: restorePoint?.planId || null, server: restorePoint?.server || null, group: restorePoint?.group || null,
    installRoot: restorePoint?.installRoot || null, createdAt: restorePoint?.createdAt || null, artifacts,
  })).digest('hex');
}

// List only locally available restore points whose manifest and every recorded
// artifact still match the verified metadata. Stored absolute paths are
// deliberately ignored so a moved portable folder remains safe.
export function listVerifiedConfigBackups({ plansDir, backupsDir, serverName, group }) {
  if (!existsSync(plansDir) || !existsSync(backupsDir)) return [];
  const candidates = [];
  for (const file of readdirSync(plansDir).filter(name => name.endsWith('.json'))) {
    const id = file.slice(0, -5);
    const plan = safeJson(join(plansDir, file));
    if (!plan || plan.server !== serverName || plan.group !== group || plan.backup?.status !== 'verified') continue;
    const directory = join(backupsDir, id);
    const restorePointPath = join(directory, 'restore-point.json');
    const restorePoint = safeJson(restorePointPath);
    if (!restorePoint || restorePoint.status !== 'verified' || restorePoint.planId !== id) continue;
    if (restorePoint.server !== serverName || restorePoint.group !== group) continue;
    const artifacts = Array.isArray(restorePoint.artifacts) ? restorePoint.artifacts : [];
    if (!artifacts.length) continue;
    let artifactsValid = true;
    for (const item of artifacts) {
      let name;
      try { name = normalizeBackupEntry(item?.name); } catch { artifactsValid = false; break; }
      const artifactPath = join(directory, ...name.split('/'));
      if (!item?.verified || !existsSync(artifactPath)) { artifactsValid = false; break; }
      const stat = statSync(artifactPath);
      if (item.bytes && stat.size !== item.bytes) { artifactsValid = false; break; }
    }
    if (!artifactsValid) continue;
    const artifact = (restorePoint.artifacts || []).find(item => item.kind === 'stand-files' && item.verified);
    if (!artifact?.name) continue;
    const archive = join(directory, ...normalizeBackupEntry(artifact.name).split('/'));
    const manifestSha256 = createHash('sha256').update(readFileSync(restorePointPath)).digest('hex');
    candidates.push({ id, plan, restorePoint, directory, archive, artifact, manifestSha256,
      snapshotSha256: restorePointSnapshotSha256(restorePoint),
      totalBytes: artifacts.reduce((sum, item) => sum + (Number(item.bytes) || 0), 0),
      createdAt: restorePoint.createdAt || plan.createdAt || '' });
  }
  candidates.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return candidates;
}

// Resolve an explicitly pinned restore point, or (for legacy plans only) the
// newest point matching their installer binding.
export function resolveVerifiedConfigBackup({ plansDir, backupsDir, serverName, group, binding }) {
  const candidates = listVerifiedConfigBackups({ plansDir, backupsDir, serverName, group });
  if (binding?.backupId) return candidates.find(item => item.id === binding.backupId) || null;
  return candidates.find(item => matchesBinding(item.restorePoint, binding)) || null;
}

export function normalizeBackupEntry(relativePath) {
  const value = String(relativePath || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!value || value.startsWith('/') || /^[A-Za-z]:/.test(value) || value.split('/').includes('..') || /[\0\r\n]/.test(value)) {
    throw new Error('некоректний шлях файла у backup');
  }
  return value;
}

const extractOne = (archive, entry, maxBytes) => new Promise((resolve, reject) => {
  const executable = process.platform === 'win32' ? 'tar.exe' : 'tar';
  const child = spawn(executable, ['-xOzf', archive, entry], { windowsHide: true });
  const chunks = [];
  let bytes = 0, stderr = '', overflow = false;
  child.stdout.on('data', chunk => {
    bytes += chunk.length;
    if (bytes > maxBytes) { overflow = true; child.kill(); return; }
    chunks.push(chunk);
  });
  child.stderr.on('data', chunk => { if (stderr.length < 8192) stderr += chunk.toString(); });
  child.on('error', reject);
  child.on('close', code => {
    if (overflow) return reject(new Error(`файл у backup більший за ${maxBytes} байт`));
    if (code !== 0) return reject(new Error(stderr.trim() || `tar exit ${code}`));
    resolve(Buffer.concat(chunks).toString('utf8'));
  });
});

// Streams one exact entry; it never unpacks the archive onto disk.
export async function extractBackupConfigText(archive, relativePath, { maxBytes = 16 * 1024 * 1024 } = {}) {
  const entry = normalizeBackupEntry(relativePath);
  try { return await extractOne(archive, entry, maxBytes); }
  catch (first) {
    try { return await extractOne(archive, './' + entry, maxBytes); }
    catch { throw new Error(`файл ${entry} не знайдено у verified backup: ${first.message}`); }
  }
}

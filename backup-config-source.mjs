import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
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

// Find the newest locally available, recorded-as-verified T0 backup that belongs
// to the same server/group and the same installer ref/commit. Stored absolute
// paths are deliberately ignored so a moved portable folder remains safe.
export function resolveVerifiedConfigBackup({ plansDir, backupsDir, serverName, group, binding }) {
  if (!existsSync(plansDir) || !existsSync(backupsDir)) return null;
  const candidates = [];
  for (const file of readdirSync(plansDir).filter(name => name.endsWith('.json'))) {
    const id = file.slice(0, -5);
    const plan = safeJson(join(plansDir, file));
    if (!plan || plan.server !== serverName || plan.group !== group || plan.backup?.status !== 'verified') continue;
    const directory = join(backupsDir, id);
    const restorePointPath = join(directory, 'restore-point.json');
    const restorePoint = safeJson(restorePointPath);
    if (!restorePoint || restorePoint.status !== 'verified' || restorePoint.planId !== id) continue;
    if (restorePoint.server !== serverName || restorePoint.group !== group || !matchesBinding(restorePoint, binding)) continue;
    const artifact = (restorePoint.artifacts || []).find(item => item.kind === 'stand-files' && item.verified);
    if (!artifact?.name) continue;
    const archive = join(directory, artifact.name);
    if (!existsSync(archive)) continue;
    const stat = statSync(archive);
    if (artifact.bytes && stat.size !== artifact.bytes) continue;
    candidates.push({ id, plan, restorePoint, directory, archive, artifact, createdAt: restorePoint.createdAt || plan.createdAt || '' });
  }
  candidates.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return candidates[0] || null;
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

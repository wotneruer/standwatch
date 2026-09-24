#!/usr/bin/env node
// stand-panel.mjs — жива локальна панель версій стенду RCC.
//
// Чому локальний сервер, а не Artifact: панель має доступ до SSH-ключа, .env,
// внутрішнього реєстру / TeamCity / GitLab — а це можливо лише з твоєї машини.
// Опублікований Artifact у пісочниці такого доступу не має.
//
// Запуск:   node tools/stand-panel.mjs            → http://127.0.0.1:8799
//           node tools/stand-panel.mjs --port 9000
// Далі відкрий адресу в браузері. Кнопка «Сканувати» або автооновлення.
//
// Що вміє:
//   • живий скан: розгорнуто / у реєстрі / стан гілки dev / статус білда TeamCity;
//   • по кожному сервісу — випадайка гілок і тегів із реєстру;
//   • обравши тег — показує ТОЧНУ команду перемикання (не виконує сама:
//     теги пінуються в root-only test/.env, а безпечний деплой — ops-flow;
//     панель дає готову команду, яку ти запускаєш на стенді сам).

import { createServer } from 'node:http';
import { spawnSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync, readdirSync, createWriteStream, createReadStream, statfsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createGzip, createGunzip } from 'node:zlib';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { collect, listBranches, CFG, sshInspect, sshRun, setTokens, tokenStatus, PORTABLE, DATA_DIR, ENV_FILE } from './stand-version.mjs';
import { searchInstallerProjects, installerRefs, installerCommits, installerSnapshot, installerComparableFileHashes, installerFileText } from './installer-control.mjs';
import { reconcile as reconcileConfig, parseConfig, configFormat, flatten as flattenConfig, buildTarget as buildTargetConfig, materialize as materializeConfig, coerceManualValue, hasJsonComments } from './config-reconcile.mjs';
import { reconcileYaml, lineDiff as yamlLineDiff, parseYaml } from './yaml-reconcile.mjs';
import { mergeTextHunks, redactMergeDecisions } from './file-merge.mjs';
import { resolveVerifiedConfigBackup, extractBackupConfigText } from './backup-config-source.mjs';
import { findAffectedContainers } from './config-apply-safety.mjs';
import { transactionPaths, redactDecisions, containerHealth, assertTransactionId, isConfigApplyTransactionKind, selectTransactionBaseline } from './config-transaction.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
// портативно — усе в data/ біля exe; у dev — звичні шляхи
const SERVERS_PATH = PORTABLE ? join(DATA_DIR, 'servers.json') : join(__dirname, 'servers.json');
const CACHE_DIR = PORTABLE ? join(DATA_DIR, 'cache') : join(__dirname, 'cache');
const INSTALLER_CATALOG_PATH = PORTABLE ? join(DATA_DIR, 'installer-catalog.json') : join(__dirname, 'installer-catalog.json');
const PLANS_DIR = PORTABLE ? join(DATA_DIR, 'plans') : join(__dirname, 'plans');
const BACKUPS_DIR = PORTABLE ? join(DATA_DIR, 'backups') : join(__dirname, 'backups');
const CONFIG_TRANSACTIONS_DIR = PORTABLE ? join(DATA_DIR, 'config-transactions') : join(__dirname, 'config-transactions');
const backupJobs = new Map();
const restoreTestJobs = new Map();
const REMOTE_CONFIG_HELPER = '/usr/local/sbin/standwatch-config-helper';
const REMOTE_CONFIG_HELPER_VERSION = 'v3';
const ENV_PATH = ENV_FILE; // токени: dev → корінь/.env, portable → data/config.env

async function stageRemoteConfigHelper(targetServer) {
  const sshUser = String(targetServer?.ssh || '').split('@')[0];
  if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(sshUser)) throw new Error('не вдалося визначити SSH-користувача');
  if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,63}@[A-Za-z0-9._:-]+$/.test(String(targetServer.ssh || ''))) throw new Error('некоректна SSH-адреса сервера');
  let helperText, installerText;
  try {
    helperText = readFileSync(join(__dirname, 'standwatch-config-helper.sh'), 'utf8');
    installerText = readFileSync(join(__dirname, 'install-standwatch-config-helper.sh'), 'utf8');
  } catch (e) { throw new Error('helper-файли відсутні біля StandWatch: ' + e.message); }
  const stageDir = '$HOME/.standwatch-helper';
  const upload = async (name, text) => sshRun(targetServer.ssh, resolveSshSettings(targetServer).sshKey,
    [`set -eu; umask 077; mkdir -p ${stageDir}; cat > ${stageDir}/${name}; chmod 700 ${stageDir}/${name}`], { input: text, timeout: 30000 });
  const first = await upload('standwatch-config-helper.sh', helperText);
  if (first.status !== 0) throw new Error('stage helper: ' + (first.stderr || `exit ${first.status}`));
  const second = await upload('install-standwatch-config-helper.sh', installerText);
  if (second.status !== 0) throw new Error('stage installer: ' + (second.stderr || `exit ${second.status}`));
  const key = resolveSshSettings(targetServer).sshKey;
  if (key && !existsSync(key)) throw new Error('SSH-ключ не знайдено: ' + key);
  const quoteWindows = value => `"${String(value).replace(/"/g, '\\"')}"`;
  const command = `ssh -t${key ? ' -i ' + quoteWindows(key) : ''} ${targetServer.ssh} "sudo sh ~/.standwatch-helper/install-standwatch-config-helper.sh ${sshUser}"`;
  return { sshUser, key, command, staged: '~/.standwatch-helper' };
}

async function installRemoteConfigHelper(targetServer, password, verifyPath) {
  if (typeof password !== 'string' || !password || password.length > 1024 || /[\r\n\0]/.test(password)) throw new Error('введи коректний sudo-пароль');
  const staged = await stageRemoteConfigHelper(targetServer);
  const install = await sshRun(targetServer.ssh, staged.key,
    [`sudo -S -k -p '' sh ~/.standwatch-helper/install-standwatch-config-helper.sh ${shellQuote(staged.sshUser)}`],
    { input: password + '\n', timeout: 60000 });
  password = '';
  if (install.status !== 0) {
    const detail = String(install.stderr || `exit ${install.status}`).trim();
    if (/incorrect password|sorry, try again|no password was provided/i.test(detail)) {
      throw new Error(`sudo відхилив пароль Linux-користувача ${staged.sshUser}. Це не пароль Windows і не пароль SSH-ключа.`);
    }
    throw new Error('sudo не встановив helper: ' + detail.slice(0, 300));
  }
  const checkCommand = verifyPath
    ? `sudo -n ${shellQuote(REMOTE_CONFIG_HELPER)} check ${shellQuote(verifyPath)}`
    : `sudo -n ${shellQuote(REMOTE_CONFIG_HELPER)} version`;
  const check = await sshRun(targetServer.ssh, staged.key, [checkCommand], { timeout: 30000 });
  if (check.status !== 0) throw new Error('helper встановлено, але постійні права не пройшли перевірку: ' + String(check.stderr || `exit ${check.status}`).trim().slice(0, 300));
  if (!String(check.stdout || '').includes(`helper:${REMOTE_CONFIG_HELPER_VERSION}`)) throw new Error('helper встановлено, але повернув неочікувану версію');
  return { validator: String(check.stdout || '').trim() };
}

// upsert рядків у env-файл (не чіпає інші)
function saveEnv(kv) {
  let txt = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : '';
  for (const [k, v] of Object.entries(kv)) {
    if (v == null || v === '') continue;
    const re = new RegExp('^' + k + '=.*$', 'm');
    if (re.test(txt)) txt = txt.replace(re, k + '=' + v);
    else txt += (txt && !txt.endsWith('\n') ? '\n' : '') + k + '=' + v + '\n';
  }
  writeFileSync(ENV_PATH, txt);
}

// ── Кеш останнього скану на диск (переживає перезапуск панелі) ───────────────
const cacheFile = (name) => join(CACHE_DIR, (name || 'default').replace(/[^\w.-]+/g, '_') + '.json');
function saveCache(name, data) {
  try { mkdirSync(CACHE_DIR, { recursive: true }); writeFileSync(cacheFile(name), JSON.stringify({ savedAt: Date.now(), data })); }
  catch { /* кеш не критичний */ }
}
function loadCache(name) {
  try { return JSON.parse(readFileSync(cacheFile(name), 'utf8')); } catch { return null; }
}

const portArg = process.argv.indexOf('--port');
let PORT = Number(portArg >= 0 ? process.argv[portArg + 1] : (process.env.PANEL_PORT || 8799)) || 8799;
const BASE_PORT = PORT;                 // якщо зайнятий — підемо BASE_PORT+1, +2 … (незалежна копія)
const HOST = '127.0.0.1';

// ── Реєстр серверів (tools/servers.json) ─────────────────────────────────────
function loadServers() {
  if (existsSync(SERVERS_PATH)) {
    try { return JSON.parse(readFileSync(SERVERS_PATH, 'utf8')); } catch { /* fallthrough */ }
  }
  return { default: null, servers: [] }; // нема файлу → порожньо (додаси через «+ сервер»)
}
function saveServers(cfg) { writeFileSync(SERVERS_PATH, JSON.stringify(cfg, null, 2)); }
const catalogSlug = value => String(value || '').toLowerCase().replace(/[^a-z0-9а-яіїєґ]+/giu, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'item';
function installerProjectPath(value) {
  let raw = String(value || '').trim();
  try { if (/^https?:\/\//i.test(raw)) raw = decodeURIComponent(new URL(raw).pathname); } catch { throw new Error('Некоректний GitLab URL'); }
  raw = raw.split('?')[0].split('#')[0].replace(/^\/+|\/+$/g, '');
  const marker = raw.indexOf('/-/'); if (marker >= 0) raw = raw.slice(0, marker);
  if (raw.toLowerCase().endsWith('.git')) raw = raw.slice(0, -4);
  const parts = raw.split('/').filter(Boolean);
  if (parts.length < 2 || parts.some(x => !/^[A-Za-z0-9_.-]+$/.test(x))) throw new Error('GitLab project має вигляд group/project');
  return parts.join('/');
}
function validateInstallerCatalog(value) {
  const input = value && typeof value === 'object' ? value : {}, projects = [], ids = new Set();
  for (const rawProject of Array.isArray(input.projects) ? input.projects.slice(0, 100) : []) {
    const name = String(rawProject.name || '').trim().slice(0, 100); if (!name) continue;
    let id = String(rawProject.id || ('project_' + catalogSlug(name))).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80) || ('project_' + catalogSlug(name));
    while (ids.has(id)) id += '_2'; ids.add(id);
    const installers = [];
    for (const rawInstaller of Array.isArray(rawProject.installers) ? rawProject.installers.slice(0, 100) : []) {
      const installerName = String(rawInstaller.name || '').trim().slice(0, 120); if (!installerName) continue;
      let projectPath; try { projectPath = installerProjectPath(rawInstaller.projectPath || rawInstaller.gitUrl); } catch { continue; }
      let manifestRoot = String(rawInstaller.manifestRoot || 'home').trim().replace(/^\/+|\/+$/g, '');
      if (!manifestRoot || manifestRoot.includes('..') || !/^[A-Za-z0-9._/-]+$/.test(manifestRoot)) manifestRoot = 'home';
      let installerId = String(rawInstaller.id || ('installer_' + catalogSlug(projectPath))).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80) || ('installer_' + catalogSlug(projectPath));
      while (ids.has(installerId)) installerId += '_2'; ids.add(installerId);
      installers.push({ id: installerId, name: installerName, gitUrl: String(rawInstaller.gitUrl || projectPath).trim().slice(0, 500), projectPath, manifestRoot });
    }
    projects.push({ id, name, installers });
  }
  const projectIds = new Set(projects.map(x => x.id)), serverNames = new Set(loadServers().servers.map(x => x.name));
  const serverProjects = {}; for (const [serverName, projectId] of Object.entries(input.serverProjects || {})) if (serverNames.has(serverName) && projectIds.has(projectId)) serverProjects[serverName] = projectId;
  const installRoots = {}; for (const [key, rootValue] of Object.entries(input.installRoots || {})) { const root = String(rootValue || '').replace(/\/+$/, ''); if (key.length <= 500 && /^\/[A-Za-z0-9._/-]+$/.test(root) && !root.includes('..')) installRoots[key] = root; }
  // Запамʼятований installer на групу: ключ `server|group` → projectPath (щоб не дообирати щоразу).
  const groupInstaller = {}; for (const [key, pathValue] of Object.entries(input.groupInstaller || {})) { const p = String(pathValue || '').trim(); if (key.length <= 500 && /^[A-Za-z0-9_.\/-]+$/.test(p)) groupInstaller[key] = p; }
  // Політика конкретного installer-файла має бути scoped до server/group/project/path:
  // один і той самий *_dev.yaml може бути ignored на QA, але managed на DEV.
  const filePolicies = {};
  for (const [key, rawPolicy] of Object.entries(input.filePolicies || {})) {
    const policy = String(rawPolicy || '');
    if (key.length <= 1200 && !key.includes('..') && ['managed', 'observe-only', 'ignored'].includes(policy)) filePolicies[key] = policy;
  }
  return { version: 1, projects, serverProjects, installRoots, groupInstaller, filePolicies, updatedAt: new Date().toISOString() };
}
function migrateInstallerCatalog() {
  const projects = [], serverProjects = {}, installRoots = {}, byName = new Map();
  for (const server of loadServers().servers) {
    const groups = Object.entries(server.installerGroups || {}).filter(([, b]) => b && b.mode === 'installer' && b.project);
    if (!groups.length) continue;
    const name = String(server.name || 'Project').replace(/\s+(QA|DEV|PROD|STAGE|TEST)$/i, '').trim() || server.name;
    let project = byName.get(name.toLowerCase()); if (!project) { project = { id: 'project_' + catalogSlug(name), name, installers: [] }; byName.set(name.toLowerCase(), project); projects.push(project); }
    serverProjects[server.name] = project.id;
    for (const [group, binding] of groups) {
      const path = installerProjectPath(binding.project), manifestRoot = binding.manifestRoot || 'home';
      if (!project.installers.some(x => x.projectPath === path && x.manifestRoot === manifestRoot)) project.installers.push({ id: 'installer_' + catalogSlug(project.name + '_' + path + '_' + manifestRoot), name: project.name + ' installer', gitUrl: path, projectPath: path, manifestRoot });
      installRoots[server.name + '|' + group + '|' + path] = binding.installRoot || ('/usr/local/' + group);
    }
  }
  return validateInstallerCatalog({ projects, serverProjects, installRoots });
}
function loadInstallerCatalog() {
  if (existsSync(INSTALLER_CATALOG_PATH)) { try { return validateInstallerCatalog(JSON.parse(readFileSync(INSTALLER_CATALOG_PATH, 'utf8'))); } catch { /* migrate below */ } }
  const catalog = migrateInstallerCatalog(); saveInstallerCatalog(catalog); return catalog;
}
function saveInstallerCatalog(value) { const catalog = validateInstallerCatalog(value); writeFileSync(INSTALLER_CATALOG_PATH, JSON.stringify(catalog, null, 2)); return catalog; }
const planText = (value, max = 500) => String(value || '').slice(0, max);
function saveInstallerPlan(body) {
  const server = findServer(body.server), group = planText(body.group, 100);
  if (!server || !/^[A-Za-z0-9_.-]+$/.test(group)) throw new Error('некоректний сервер або група');
  const snapshot = body.snapshot || {}, commit = snapshot.commit || {};
  if (!/^[0-9a-f]{40}$/i.test(commit.id || '') || !/^[0-9a-f]{64}$/i.test(snapshot.checksum || ''))
    throw new Error('цільовий installer commit/checksum не зафіксовано');
  const installRoot = planText(body.installRoot).replace(/\/+$/, '');
  if (!/^\/[A-Za-z0-9._/-]+$/.test(installRoot) || installRoot.includes('..')) throw new Error('некоректний installation root');
  const pre = body.preflight || {}, cmp = body.comparison || {};
  const plan = {
    version: 1, status: 'read-only-draft', createdAt: new Date().toISOString(), server: server.name, group, installRoot,
    target: { project: planText(snapshot.project), ref: planText(snapshot.ref), manifestRoot: planText(snapshot.manifestRoot, 200),
      commit: { id: commit.id, shortId: planText(commit.shortId, 20), title: planText(commit.title), date: planText(commit.date, 80) },
      checksum: snapshot.checksum, serviceCount: Array.isArray(body.items) ? body.items.filter(x => x.target).length : 0,
      scopeFiles: (Array.isArray(body.scopeFiles) ? body.scopeFiles : []).filter(x => typeof x === 'string').slice(0, 200).map(x => planText(x)) },
    services: (Array.isArray(body.items) ? body.items : []).slice(0, 500).map(x => ({ image: planText(x.image, 200),
      current: planText(x.current, 200), target: planText(x.target, 200), status: planText(x.status, 40), reason: planText(x.reason) })),
    configComparison: { counts: cmp.counts || {}, files: (Array.isArray(cmp.files) ? cmp.files : []).filter(x => x.status !== 'same').slice(0, 1000)
      .map(x => ({ path: planText(x.path), status: planText(x.status, 40), expectedSize: Number(x.size) || null })) },
    backupPreflight: { readOnly: true, disk: pre.disk || null, directories: pre.directories || [],
      containerCount: Array.isArray(pre.containers) ? pre.containers.length : 0, mountCount: Array.isArray(pre.mounts) ? pre.mounts.length : 0,
      containers: (Array.isArray(pre.containers) ? pre.containers : []).slice(0, 500).map(value => ({ name: planText(value.name, 200), image: planText(value.image, 500),
        composeGroup: planText(value.composeGroup, 100), workingDir: planText(value.workingDir), databaseCandidate: !!value.databaseCandidate,
        mounts: (Array.isArray(value.mounts) ? value.mounts : []).slice(0, 200).map(mount => ({ type: planText(mount.type, 20), name: planText(mount.name, 300) || null,
          source: planText(mount.source), destination: planText(mount.destination), rw: !!mount.rw })) })),
      databaseCandidates: pre.databaseCandidates || [] },
    backup: { status: 'not-created' }, deploy: { status: 'blocked-until-backup' },
  };
  mkdirSync(PLANS_DIR, { recursive: true });
  const id = `${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 17)}_${catalogSlug(server.name)}_${catalogSlug(group)}`;
  const target = join(PLANS_DIR, id + '.json'), temporary = target + '.part';
  writeFileSync(temporary, JSON.stringify(plan, null, 2)); renameSync(temporary, target);
  return { id, plan, file: target };
}
function latestInstallerPlan(serverName, group) {
  if (!existsSync(PLANS_DIR)) return null;
  let latest = null, id = null;
  for (const file of readdirSync(PLANS_DIR).filter(x => x.endsWith('.json'))) {
    try {
      const value = JSON.parse(readFileSync(join(PLANS_DIR, file), 'utf8'));
      if (value.server !== serverName || value.group !== group || !value.createdAt) continue;
      if (!latest || value.createdAt > latest.createdAt) { latest = value; id = file.slice(0, -5); }
    } catch { /* пропустити пошкоджений/чужий файл */ }
  }
  if (!latest) return null;
  const cachedRows = loadCache(serverName)?.data?.rows || [];
  const current = new Map(cachedRows.filter(row => (row.deployed?.project || 'default') === group)
    .map(row => [row.image, row.deployed?.tag || '']));
  const changedServices = latest.services.filter(item => (current.get(item.image) || '') !== (item.current || ''))
    .map(item => ({ image: item.image, planned: item.current || null, current: current.get(item.image) || null }));
  return { id, plan: latest, serverUnchanged: cachedRows.length > 0 && changedServices.length === 0, changedServices };
}
function planFileById(id) {
  const value = String(id || '');
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) throw new Error('некоректний plan id');
  return join(PLANS_DIR, value + '.json');
}
// Джерело ref/project/installRoot для reconcile/reveal: спершу зафіксований binding,
// інакше — останній збережений план цієї групи (щоб reconcile працював і без окремого «фіксування»).
function resolveConfigBinding(server, group) {
  const b = (server.installerGroups || {})[group];
  if (b && b.project && b.ref)
    return { project: b.project, ref: b.ref, installRoot: String(b.installRoot || ('/usr/local/' + group)).replace(/\/+$/, ''), source: 'binding' };
  const latest = latestInstallerPlan(server.name, group), t = latest?.plan?.target;
  if (t && t.project && t.commit?.id)
    return { project: t.project, ref: t.commit.id, installRoot: String(latest.plan.installRoot || ('/usr/local/' + group)).replace(/\/+$/, ''), source: 'plan' };
  return null;
}
function persistInstallerPlan(id, plan) {
  const target = planFileById(id), temporary = target + '.part';
  writeFileSync(temporary, JSON.stringify(plan, null, 2)); renameSync(temporary, target);
}
const shellQuote = value => `'${String(value).replace(/'/g, `'\\''`)}'`;
const configSourceCache = new Map();
const reconcileApiCache = new Map();
const CONFIG_PREVIEW_CACHE_DIR = join(CACHE_DIR, 'config-previews');
const sha256Text = value => createHash('sha256').update(Buffer.from(String(value), 'utf8')).digest('hex');
const configPreviewCachePath = parts => join(CONFIG_PREVIEW_CACHE_DIR, createHash('sha256').update(parts.join('\n')).digest('hex') + '.json');
function loadConfigPreviewCache(parts) {
  try { const value = JSON.parse(readFileSync(configPreviewCachePath(parts), 'utf8')); return value?.version === 1 ? value : null; }
  catch { return null; }
}
function saveConfigPreviewCache(parts, payload) {
  try {
    mkdirSync(CONFIG_PREVIEW_CACHE_DIR, { recursive: true });
    const target = configPreviewCachePath(parts), temporary = target + '.part';
    writeFileSync(temporary, JSON.stringify({ version: 1, savedAt: new Date().toISOString(), payload })); renameSync(temporary, target);
  } catch { /* preview cache is optional */ }
}
function transactionConfigBaseline(serverName, group, path, liveText) {
  if (!existsSync(CONFIG_TRANSACTIONS_DIR)) return null;
  const transactions = [];
  for (const file of readdirSync(CONFIG_TRANSACTIONS_DIR).filter(name => name.endsWith('.json'))) {
    try {
      const value = JSON.parse(readFileSync(join(CONFIG_TRANSACTIONS_DIR, file), 'utf8'));
      transactions.push(value);
    } catch { /* ignore damaged journal */ }
  }
  const latest = selectTransactionBaseline(transactions, { server: serverName, group, path, liveSha256: sha256Text(liveText) });
  if (!latest) return null;
  return { text: liveText, source: { id: latest.value.id, kind: 'transaction-baseline', createdAt: latest.createdAt,
    sha256: latest.expectedSha, transaction: latest.value.status } };
}
async function readVerifiedBackupConfig(server, group, path, binding, liveText = null) {
  if (liveText != null) {
    const transaction = transactionConfigBaseline(server.name, group, path, liveText);
    if (transaction) return transaction;
  }
  const source = resolveVerifiedConfigBackup({ plansDir: PLANS_DIR, backupsDir: BACKUPS_DIR, serverName: server.name, group, binding });
  if (!source) throw new Error('нема verified T0 backup або підтвердженої config-транзакції для цього сервера й групи');
  const cacheKey = source.archive + '\n' + path;
  let text = configSourceCache.get(cacheKey);
  if (text === undefined) {
    text = await extractBackupConfigText(source.archive, path);
    // Secret-файли не тримаємо у довгоживучому process cache.
    if (configFormat(path) !== 'env') {
      if (configSourceCache.size >= 24) configSourceCache.delete(configSourceCache.keys().next().value);
      configSourceCache.set(cacheKey, text);
    }
  }
  return { text, source: { ...source, kind: 'full-backup' } };
}
async function readLiveConfig(server, installRoot, path) {
  const result = await sshRun(server.ssh, resolveSshSettings(server).sshKey, [`cat ${shellQuote(installRoot + '/' + path)}`], { timeout: 30000 });
  if (result.status !== 0) throw new Error((result.stderr || 'exit ' + result.status).slice(0, 300));
  return result.stdout;
}
async function readLiveConfigSha(server, installRoot, path) {
  const result = await sshRun(server.ssh, resolveSshSettings(server).sshKey, [`sha256sum -- ${shellQuote(installRoot + '/' + path)}`], { timeout: 30000 });
  if (result.status !== 0) throw new Error((result.stderr || 'exit ' + result.status).slice(0, 300));
  const match = /^([0-9a-f]{64})\b/i.exec(String(result.stdout || '').trim());
  if (!match) throw new Error('сервер не повернув SHA-256 файла');
  return match[1].toLowerCase();
}
function sshOptions(server) {
  const key = resolveSshSettings(server).sshKey;
  const options = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'StrictHostKeyChecking=accept-new'];
  if (key) options.push('-o', 'IdentitiesOnly=yes', '-i', key);
  return options;
}
async function sshStreamArtifact(server, remoteCommand, destination, { gzip = false, timeout = 30 * 60 * 1000, onProgress = null, progressFromStderr = false } = {}) {
  const temporary = destination + '.part';
  try { if (existsSync(temporary)) unlinkSync(temporary); } catch {}
  const child = spawn('ssh', [...sshOptions(server), server.ssh, remoteCommand], { windowsHide: true });
  let stderr = '', progressTail = '', rawBytes = 0, storedBytes = 0, prefix = Buffer.alloc(0), timedOut = false;
  child.stderr.on('data', value => {
    const text = value.toString(); if (stderr.length < 12000) stderr += text;
    if (progressFromStderr && onProgress) {
      progressTail = (progressTail + text).slice(-1000);
      const matches = [...progressTail.matchAll(/(\d+)\s+bytes/g)];
      if (matches.length) onProgress(Number(matches[matches.length - 1][1]));
    }
  });
  const rawTap = new Transform({ transform(chunk, encoding, callback) {
    rawBytes += chunk.length;
    if (prefix.length < 2048) prefix = Buffer.concat([prefix, chunk]).subarray(0, 2048);
    if (!progressFromStderr && onProgress) onProgress(rawBytes);
    callback(null, chunk);
  } });
  const hash = createHash('sha256');
  const tap = new Transform({ transform(chunk, encoding, callback) { storedBytes += chunk.length; hash.update(chunk); callback(null, chunk); } });
  const timer = setTimeout(() => { timedOut = true; try { child.kill(); } catch {} }, timeout);
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error((stderr || `ssh exit ${code}`) + (timedOut ? ' (timeout)' : ''))));
  });
  try {
    const streams = [child.stdout, rawTap]; if (gzip) streams.push(createGzip({ level: 6 }));
    streams.push(tap, createWriteStream(temporary, { flags: 'wx' }));
    await Promise.all([pipeline(...streams), closed]);
    if (rawBytes < 16 || storedBytes < 16) throw new Error('отримано порожній backup artifact');
    renameSync(temporary, destination);
    return { file: destination, bytes: storedBytes, rawBytes, sha256: hash.digest('hex'), prefix: prefix.toString('utf8') };
  } catch (error) {
    try { if (existsSync(temporary)) unlinkSync(temporary); } catch {}
    throw error;
  } finally { clearTimeout(timer); }
}
// Надійна передача великого артефакту: збирає gz у ТИМЧАСОВИЙ файл на сервері,
// рахує sha256 на сервері, стягує через scp (бінарно-безпечно, як Termius), звіряє sha
// локально, прибирає серверний temp. Уникає корупції живого Node-стріму на мультигіг обсягах.
async function sshCopyArtifact(server, producerCommand, destination, { timeout = 60 * 60 * 1000, peekDecompressed = false, onProgress = null, onPhase = null } = {}) {
  const suffix = createHash('sha256').update(destination + ':' + Date.now()).digest('hex').slice(0, 12);
  const serverTmp = '/tmp/standwatch_stage_' + suffix + '.gz';
  const opts = sshOptions(server), key = resolveSshSettings(server).sshKey;
  try {
    if (onPhase) onPhase('server-build');
    const build = [
      'set -o pipefail',
      `TMP=${serverTmp}`,
      `if ! { ${producerCommand} ; } > "$TMP"; then rm -f "$TMP"; echo "producer failed" >&2; exit 1; fi`,
      `sha256sum "$TMP" | cut -d' ' -f1`,
      `stat -c %s "$TMP"`,
      peekDecompressed ? `zcat "$TMP" 2>/dev/null | head -c 2048 | base64 | tr -d '\\n'; echo` : `echo`,
    ].join('\n');
    const r = await sshRun(server.ssh, key, [build], { timeout });
    if (r.status !== 0) throw new Error((r.stderr || ('server build exit ' + r.status)).slice(0, 4000));
    const lines = String(r.stdout || '').trim().split(/\r?\n/);
    const sha = (lines[0] || '').trim(), size = Number((lines[1] || '').trim()) || 0;
    const prefix = peekDecompressed && lines[2] ? Buffer.from(lines[2].trim(), 'base64').toString('utf8') : '';
    if (!/^[0-9a-f]{64}$/.test(sha) || size < 16) throw new Error('сервер не повернув коректні sha256/size артефакту');
    const temporary = destination + '.part';
    try { if (existsSync(temporary)) unlinkSync(temporary); } catch {}
    if (onPhase) onPhase('transfer', size);
    await new Promise((resolve, reject) => {
      const scp = spawn('scp', [...opts, '-p', `${server.ssh}:${serverTmp}`, temporary], { windowsHide: true });
      let err = '', done = false;
      const finish = error => { if (done) return; done = true; clearTimeout(t); clearInterval(progressTimer); error ? reject(error) : resolve(); };
      scp.stderr.on('data', d => { if (err.length < 8000) err += d.toString(); });
      const progressTimer = setInterval(() => { if (!onProgress) return; try { if (existsSync(temporary)) onProgress(Math.min(statSync(temporary).size, size)); } catch {} }, 500);
      const t = setTimeout(() => { try { scp.kill(); } catch {} finish(new Error('scp timeout')); }, timeout);
      scp.on('error', e => finish(e));
      scp.on('close', code => finish(code === 0 ? null : new Error('scp exit ' + code + ': ' + err.slice(0, 2000))));
    });
    if (onProgress) onProgress(size);
    if (onPhase) onPhase('verify', size);
    const localSha = await sha256File(temporary);
    if (localSha !== sha) { try { unlinkSync(temporary); } catch {} throw new Error('sha256 після scp не збігся (сервер ' + sha.slice(0, 12) + ' ≠ локально ' + localSha.slice(0, 12) + ')'); }
    renameSync(temporary, destination);
    return { file: destination, bytes: size, rawBytes: size, sha256: sha, prefix };
  } finally {
    try { await sshRun(server.ssh, key, [`rm -f ${serverTmp}`], { timeout: 60000 }); } catch {}
  }
}
async function verifyGzipArtifact(path) {
  let bytes = 0;
  await pipeline(createReadStream(path), createGunzip(), new Writable({ write(chunk, encoding, callback) { bytes += chunk.length; callback(); } }));
  if (bytes < 16) throw new Error('gzip artifact порожній після перевірки');
  return bytes;
}
async function sha256File(path) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => { const stream = createReadStream(path); stream.on('data', chunk => hash.update(chunk)); stream.once('end', resolve); stream.once('error', reject); });
  return hash.digest('hex');
}
async function sshPipeGzipArtifact(server, source, remoteCommand, { timeout = 2 * 60 * 60 * 1000 } = {}) {
  const child = spawn('ssh', [...sshOptions(server), server.ssh, remoteCommand], { windowsHide: true });
  let stdout = '', stderr = '', timedOut = false;
  child.stdout.on('data', value => { if (stdout.length < 200000) stdout += value.toString(); });
  child.stderr.on('data', value => { if (stderr.length < 200000) stderr += value.toString(); });
  const timer = setTimeout(() => { timedOut = true; try { child.kill(); } catch {} }, timeout);
  const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error((stderr || `ssh exit ${code}`) + (timedOut ? ' (timeout)' : '')))); });
  try { await Promise.all([pipeline(createReadStream(source), createGunzip(), child.stdin), closed]); return { stdout, stderr }; }
  finally { clearTimeout(timer); }
}
function parseDbStructure(text) {
  const value = { roles: [], databases: [], extensions: {}, tables: {} };
  for (const line of String(text || '').split(/\r?\n/)) { const [kind, database, item] = line.split('\t');
    if (kind === 'ROLE' && database) value.roles.push(database);
    else if (kind === 'DB' && database) value.databases.push(database);
    else if (kind === 'EXT' && database && item) (value.extensions[database] ||= []).push(item);
    else if (kind === 'TABLE' && database && item) (value.tables[database] ||= []).push(item);
  }
  value.roles.sort(); value.databases.sort(); for (const group of [value.extensions, value.tables]) for (const items of Object.values(group)) items.sort();
  return value;
}
async function databaseStructure(server, container) {
  if (!/^[A-Za-z0-9_.-]+$/.test(container)) throw new Error('некоректна назва DB-контейнера');
  const script = `u="${'$'}{POSTGRES_USER:-postgres}"; psql -U "${'$'}u" -d postgres -Atqc "SELECT rolname FROM pg_roles WHERE rolname !~ '^pg_' AND rolname <> 'standwatch_admin' ORDER BY 1" | sed 's/^/ROLE\\t/'; psql -U "${'$'}u" -d postgres -Atqc "SELECT datname FROM pg_database WHERE datallowconn ORDER BY 1" | while IFS= read -r d; do printf 'DB\\t%s\\n' "${'$'}d"; psql -U "${'$'}u" -d "${'$'}d" -Atqc "SELECT extname FROM pg_extension ORDER BY 1" | while IFS= read -r x; do printf 'EXT\\t%s\\t%s\\n' "${'$'}d" "${'$'}x"; done; psql -U "${'$'}u" -d "${'$'}d" -Atqc "SELECT schemaname||'.'||tablename FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema') ORDER BY 1" | while IFS= read -r x; do printf 'TABLE\\t%s\\t%s\\n' "${'$'}d" "${'$'}x"; done; done`;
  const result = await sshRun(server.ssh, resolveSshSettings(server).sshKey, [`docker exec ${shellQuote(container)} sh -lc ${shellQuote(script)}`], { timeout: 10 * 60 * 1000 });
  if (result.status !== 0) throw new Error('DB structure ' + container + ': ' + (result.stderr || `exit ${result.status}`));
  return parseDbStructure(result.stdout);
}
const stableJson = value => JSON.stringify(value);
async function testInstallerRestore({ serverName, group, planId }) {
  const server = findServer(serverName); if (!server) throw new Error('сервер не знайдено');
  const latest = latestInstallerPlan(serverName, group); if (!latest?.plan || latest.id !== planId) throw new Error('план уже не є поточним');
  const plan = latest.plan, backup = plan.backup || {}; if (backup.status !== 'verified' || !backup.directory) throw new Error('спочатку потрібен verified backup');
  const running = restoreTestJobs.get(planId); if (running?.status === 'running') throw new Error('restore-test уже виконується');
  const job = { planId, status: 'running', phase: 'checksums', startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }; restoreTestJobs.set(planId, job);
  const logPath = join(backup.directory, 'restore-test.jsonl'), report = (phase, detail = {}) => { Object.assign(job, { phase, updatedAt: new Date().toISOString(), ...detail }); restoreTestJobs.set(planId, job); writeFileSync(logPath, JSON.stringify({ at: job.updatedAt, phase, ...detail }) + '\n', { flag: 'a' }); };
  const suffix = createHash('sha256').update(planId).digest('hex').slice(0, 12), tempContainer = 'standwatch_restore_' + suffix, tempVolume = 'standwatch_restore_' + suffix;
  try {
    for (const artifact of backup.artifacts || []) { const file = join(backup.directory, artifact.name); if (!existsSync(file)) throw new Error('відсутній artifact: ' + artifact.name); if ((await sha256File(file)) !== artifact.sha256) throw new Error('checksum не збігається: ' + artifact.name); }
    const dumps = (backup.artifacts || []).filter(x => x.kind === 'postgresql-dump'); if (dumps.length !== 1) throw new Error('restore-test зараз підтримує рівно один PostgreSQL dump');
    const candidate = (plan.backupPreflight?.databaseCandidates || []).find(x => x.name === dumps[0].container); if (!candidate) throw new Error('не знайдено metadata DB-контейнера у плані');
    const image = String(candidate.image || ''); if (!/^[A-Za-z0-9./:_-]+$/.test(image) || !/postgres/i.test(image)) throw new Error('небезпечний або непідтримуваний PostgreSQL image');
    report('live-structure', { container: candidate.name }); const live = await databaseStructure(server, candidate.name);
    report('temporary-database', { image });
    const create = await sshRun(server.ssh, resolveSshSettings(server).sshKey, [`set -eu; docker inspect ${shellQuote(tempContainer)} >/dev/null 2>&1 && exit 61 || true; docker volume inspect ${shellQuote(tempVolume)} >/dev/null 2>&1 && exit 62 || true; docker run -d --name ${shellQuote(tempContainer)} --label standwatch.restore-test=${shellQuote(planId)} -e POSTGRES_USER=standwatch_admin -e POSTGRES_PASSWORD=standwatch_local_test -e POSTGRES_DB=postgres -v ${shellQuote(tempVolume)}:/var/lib/postgresql/data ${shellQuote(image)} >/dev/null; i=0; until docker exec ${shellQuote(tempContainer)} pg_isready -U standwatch_admin -d postgres >/dev/null 2>&1; do i=$((i+1)); [ "$i" -lt 90 ] || exit 63; sleep 2; done`], { timeout: 5 * 60 * 1000 });
    if (create.status !== 0) throw new Error('тимчасовий PostgreSQL не стартував: ' + (create.stderr || `exit ${create.status}`));
    report('database-restore'); await sshPipeGzipArtifact(server, join(backup.directory, dumps[0].name), `docker exec -i ${shellQuote(tempContainer)} psql -X -v ON_ERROR_STOP=1 -U standwatch_admin -d postgres`);
    report('restored-structure'); const restored = await databaseStructure(server, tempContainer), structureMatches = stableJson(live) === stableJson(restored);
    if (!structureMatches) throw new Error('структура відновленої БД відрізняється від живої; дивись restore-test-result.json');
    let inspected = null; try { inspected = JSON.parse(readFileSync(join(backup.directory, 'containers.json'), 'utf8')); } catch {}
    const unprotectedVolumes = unprotectedDockerVolumes(plan, inspected);
    const result = { status: 'restore-tested', testedAt: new Date().toISOString(), server: serverName, group, image, live, restored, checks: { artifactChecksums: true, sqlRestore: true, rolesDatabasesExtensionsTables: true }, unprotectedVolumes, log: logPath };
    writeJsonArtifact(join(backup.directory, 'restore-test-result.json'), result); plan.restore = result; plan.deploy = { status: unprotectedVolumes.length ? 'blocked-unprotected-volumes' : 'ready-for-approved-drill' }; persistInstallerPlan(planId, plan);
    const manifestPath = join(backup.directory, 'restore-point.json'); if (existsSync(manifestPath)) { const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); manifest.restore = result; writeJsonArtifact(manifestPath, manifest); }
    Object.assign(job, { status: 'restore-tested', phase: 'done', finishedAt: result.testedAt, result }); report('done', { status: 'restore-tested' }); return { ok: true, planId, result };
  } catch (error) { const failedAt = new Date().toISOString(); plan.restore = { status: 'restore-failed', failedAt, phase: job.phase, error: String(error.message || error), log: logPath }; plan.deploy = { status: 'blocked-restore-test-failed' }; persistInstallerPlan(planId, plan); Object.assign(job, { status: 'restore-failed', error: plan.restore.error, failedAt }); report('failed', { status: 'restore-failed', error: plan.restore.error }); throw error; }
  finally {
    try { const logs = await sshRun(server.ssh, resolveSshSettings(server).sshKey, [`docker logs --timestamps ${shellQuote(tempContainer)} 2>&1 || true`], { timeout: 120000 }); writeFileSync(join(backup.directory, 'restore-test-container.log'), String(logs.stdout || '') + String(logs.stderr || '')); } catch {}
    await sshRun(server.ssh, resolveSshSettings(server).sshKey, [`docker rm -f ${shellQuote(tempContainer)} >/dev/null 2>&1 || true; docker volume rm ${shellQuote(tempVolume)} >/dev/null 2>&1 || true`], { timeout: 120000 }).catch(() => {});
  }
}
function writeJsonArtifact(path, value) {
  const content = Buffer.from(JSON.stringify(value, null, 2));
  writeFileSync(path, content);
  return { file: path, bytes: content.length, rawBytes: content.length, sha256: createHash('sha256').update(content).digest('hex') };
}
function unprotectedDockerVolumes(plan, inspected = null) {
  const databaseNames = new Set((plan.backupPreflight?.databaseCandidates || []).map(x => String(x.name || ''))), values = [];
  const source = Array.isArray(inspected) ? inspected.map(value => ({ name: String(value.Name || '').replace(/^\//, ''), mounts: value.Mounts || [] }))
    : (plan.backupPreflight?.containers || []).map(value => ({ name: value.name, mounts: value.mounts || [] }));
  for (const container of source) if (!databaseNames.has(container.name)) for (const mount of container.mounts || []) {
    const type = String(mount.Type || mount.type || '').toLowerCase(); if (type !== 'volume') continue;
    values.push({ container: container.name, name: mount.Name || mount.name || null, destination: mount.Destination || mount.destination || null });
  }
  return values.filter((value, index, all) => all.findIndex(x => x.name === value.name && x.destination === value.destination) === index);
}
async function createInstallerBackup({ serverName, group, planId }) {
  const server = findServer(serverName); if (!server) throw new Error('сервер не знайдено');
  const latest = latestInstallerPlan(serverName, group);
  if (!latest?.plan || latest.id !== planId) throw new Error('план уже не є поточним — сформуй його повторно');
  if (!latest.serverUnchanged) throw new Error('стан сервера змінився після формування плану — спочатку перескануй і сформуй новий план');
  const plan = latest.plan;
  if (plan.backup?.status === 'verified' && plan.backup.directory && existsSync(plan.backup.directory)) return { reused: true, planId, backup: plan.backup };
  const running = backupJobs.get(planId); if (running?.status === 'running') throw new Error('backup цього плану вже виконується');
  const job = { planId, status: 'running', phase: 'preflight', processedBytes: 0, totalBytes: 0, storedBytes: 0,
    speedBytesPerSecond: 0, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  let lastProgressAt = Date.now(), lastProgressBytes = 0;
  const report = (phase, processedBytes, totalBytes = job.totalBytes) => {
    const now = Date.now(), elapsed = Math.max(0.25, (now - lastProgressAt) / 1000), delta = Math.max(0, processedBytes - lastProgressBytes);
    if (delta > 0) { job.speedBytesPerSecond = Math.round(delta / elapsed); lastProgressAt = now; lastProgressBytes = processedBytes; }
    Object.assign(job, { phase, processedBytes, totalBytes, updatedAt: new Date().toISOString() }); backupJobs.set(planId, job);
  };
  backupJobs.set(planId, job);
  mkdirSync(BACKUPS_DIR, { recursive: true });
  const preferredDir = join(BACKUPS_DIR, planId);
  const failedDir = plan.backup?.status === 'failed' && plan.backup.directory && existsSync(plan.backup.directory) ? plan.backup.directory : null;
  const backupDir = failedDir || (existsSync(preferredDir) ? join(BACKUPS_DIR, planId + '_' + new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 17)) : preferredDir);
  if (failedDir) {
    for (const name of ['stand-files.tar.gz', 'stand-files.tar.gz.part']) { const file = join(failedDir, name); try { if (existsSync(file)) unlinkSync(file); } catch {} }
    const databaseDir = join(failedDir, 'database');
    if (existsSync(databaseDir)) for (const name of readdirSync(databaseDir)) if (/\.(?:sql\.gz|part)$/.test(name)) { try { unlinkSync(join(databaseDir, name)); } catch {} }
  }
  mkdirSync(backupDir, { recursive: true }); mkdirSync(join(backupDir, 'database'), { recursive: true });
  plan.backup = { status: 'creating', startedAt: new Date().toISOString(), directory: backupDir, artifacts: [] };
  persistInstallerPlan(planId, plan);
  const manifestPath = join(backupDir, 'restore-point.json');
  try {
    const candidates = Array.isArray(plan.backupPreflight?.databaseCandidates) ? plan.backupPreflight.databaseCandidates : [];
    const unsupported = candidates.filter(x => !/postgres/i.test((x.name || '') + ' ' + (x.image || '')));
    if (unsupported.length) throw new Error('для DB-контейнерів ще немає безпечної стратегії dump: ' + unsupported.map(x => x.name).join(', '));
    const databaseProbes = [];
    report('db-preflight', 0, 0);
    for (const candidate of candidates) {
      const container = String(candidate.name || '');
      if (!/^[A-Za-z0-9_.-]+$/.test(container)) throw new Error('некоректна назва DB-контейнера');
      const probe = await sshRun(server.ssh, resolveSshSettings(server).sshKey,
        [`docker exec ${shellQuote(container)} sh -lc 'command -v pg_dumpall >/dev/null || exit 51; command -v psql >/dev/null || exit 52; u="${'$'}{POSTGRES_USER:-postgres}"; d="${'$'}{POSTGRES_DB:-postgres}"; psql -U "${'$'}u" -d "${'$'}d" -Atqc "SELECT coalesce(sum(pg_database_size(datname)),0) FROM pg_database WHERE datallowconn"'`],
        { timeout: 120000 });
      if (probe.status !== 0) throw new Error(`DB preflight ${container}: ` + (probe.stderr || `exit ${probe.status}`));
      const sizeLine = String(probe.stdout || '').trim().split(/\r?\n/).reverse().find(x => /^\d+$/.test(x.trim()));
      if (!sizeLine) throw new Error(`DB preflight ${container}: не вдалося визначити розмір баз`);
      databaseProbes.push({ container, engine: 'postgresql', strategy: 'pg_dumpall', estimatedBytes: Number(sizeLine) });
    }
    const directoryBytes = (plan.backupPreflight?.directories || []).reduce((sum, item) => sum + (Number(item.sizeKb) || 0) * 1024, 0);
    const databaseBytes = databaseProbes.reduce((sum, item) => sum + (Number(item.estimatedBytes) || 0), 0);
    report('inventory', 0, directoryBytes + databaseBytes);
    const disk = statfsSync(BACKUPS_DIR), localFreeBytes = Number(disk.bavail) * Number(disk.bsize);
    const requiredBytes = directoryBytes + databaseBytes + 512 * 1024 * 1024;
    if (localFreeBytes < requiredBytes) throw new Error(`недостатньо місця локально: вільно ${Math.round(localFreeBytes / 1073741824)} GiB, потрібно щонайменше ${Math.ceil(requiredBytes / 1073741824)} GiB`);
    const groupName = String(group || '');
    if (!/^[A-Za-z0-9_.-]+$/.test(groupName)) throw new Error('некоректна Docker-група');
    const inventoryNames = (plan.backupPreflight?.containers || []).map(value => String(value.name || ''));
    if (!inventoryNames.length || inventoryNames.some(value => !/^[A-Za-z0-9_.-]+$/.test(value))) throw new Error('некоректний або порожній container inventory');
    const inspect = await sshRun(server.ssh, resolveSshSettings(server).sshKey,
      [`docker inspect ${inventoryNames.map(shellQuote).join(' ')}`], { timeout: 120000 });
    if (inspect.status !== 0) throw new Error('docker inspect: ' + (inspect.stderr || `exit ${inspect.status}`));
    let inspectValue; try { inspectValue = JSON.parse(inspect.stdout || '[]'); } catch { throw new Error('docker inspect повернув некоректний JSON'); }
    const artifacts = [];
    const inspectArtifact = writeJsonArtifact(join(backupDir, 'containers.json'), inspectValue);
    artifacts.push({ kind: 'container-state', name: 'containers.json', bytes: inspectArtifact.bytes, sha256: inspectArtifact.sha256, verified: true });
    const root = String(plan.installRoot || '');
    if (!/^\/[A-Za-z0-9._/-]+$/.test(root) || root.includes('..')) throw new Error('некоректний installation root у плані');
    const databaseDataPaths = [...new Set(candidates.flatMap(candidate => candidate.mounts || []).map(mount => String(mount.source || ''))
      .filter(source => source.startsWith(root + '/')).map(source => source.slice(root.length + 1))
      .filter(relative => /^(?:home|scripts|volumes)(?:\/[A-Za-z0-9._-]+)*$/.test(relative)))];
    const backupExcludes = [...new Set([...databaseDataPaths, 'volumes/logs', 'volumes/*/pgdata'])];
    const tarExcludes = backupExcludes.map(relative => '--exclude=' + shellQuote(relative)).join(' ');
    report('stand-files', 0, directoryBytes + databaseBytes);
    const files = await sshCopyArtifact(server,
      `root=${shellQuote(root)}; cd "$root" || exit 41; set --; for d in home scripts volumes; do [ -e "$d" ] && set -- "$@" "$d"; done; [ "$#" -gt 0 ] || exit 42; if command -v pigz >/dev/null 2>&1; then tar -cf - ${tarExcludes} -- "$@" | pigz -1; else tar -cf - ${tarExcludes} -- "$@" | gzip -1; fi`,
      join(backupDir, 'stand-files.tar.gz'), {
        onProgress: bytes => report('stand-files-transfer', Math.min(bytes, directoryBytes), directoryBytes + databaseBytes),
        onPhase: phase => report(phase === 'server-build' ? 'stand-files-archive' : phase === 'verify' ? 'stand-files-verify' : 'stand-files-transfer', job.processedBytes, directoryBytes + databaseBytes),
      });
    report('stand-files-verify', Math.min(files.bytes, directoryBytes), directoryBytes + databaseBytes);
    const filesExpanded = await verifyGzipArtifact(files.file);
    artifacts.push({ kind: 'stand-files', name: 'stand-files.tar.gz', includes: ['home', 'scripts', 'volumes'], excludes: backupExcludes, bytes: files.bytes,
      expandedBytes: filesExpanded, sha256: files.sha256, verified: true });
    const dumped = [];
    let completedDatabaseBytes = 0;
    for (const candidate of candidates) {
      const container = String(candidate.name || '');
      if (!/^[A-Za-z0-9_.-]+$/.test(container)) throw new Error('некоректна назва DB-контейнера');
      const target = join(backupDir, 'database', catalogSlug(container) + '.sql.gz');
      const dump = await sshCopyArtifact(server,
        `docker exec ${shellQuote(container)} sh -lc 'command -v pg_dumpall >/dev/null || exit 51; u="${'$'}{POSTGRES_USER:-postgres}"; exec pg_dumpall -U "${'$'}u"' | { command -v pigz >/dev/null 2>&1 && pigz -1 || gzip -1; }`,
        target, { peekDecompressed: true, timeout: 60 * 60 * 1000,
          onProgress: bytes => report('database-transfer', directoryBytes + completedDatabaseBytes + Math.min(bytes, Number(databaseProbes.find(x => x.container === container)?.estimatedBytes) || bytes), directoryBytes + databaseBytes),
          onPhase: phase => report(phase === 'server-build' ? 'database-dump' : phase === 'verify' ? 'database-verify' : 'database-transfer', directoryBytes + completedDatabaseBytes, directoryBytes + databaseBytes) });
      if (!/PostgreSQL database cluster dump|^--|SET /m.test(dump.prefix)) throw new Error(`dump ${container} не схожий на PostgreSQL SQL dump`);
      const expandedBytes = await verifyGzipArtifact(target);
      const relative = 'database/' + catalogSlug(container) + '.sql.gz';
      artifacts.push({ kind: 'postgresql-dump', container, name: relative, bytes: dump.bytes, expandedBytes,
        sha256: dump.sha256, verified: true, strategy: 'pg_dumpall' });
      dumped.push(container);
      completedDatabaseBytes += dump.rawBytes;
    }
    report('finalizing', directoryBytes + databaseBytes, directoryBytes + databaseBytes);
    const completedAt = new Date().toISOString();
    const unprotectedVolumes = unprotectedDockerVolumes(plan, inspectValue);
    const restorePoint = { version: 1, status: 'verified', planId, server: plan.server, group: plan.group, installRoot: plan.installRoot,
      target: plan.target, createdAt: completedAt, artifacts, database: { detected: candidates.map(x => x.name), dumped, complete: dumped.length === candidates.length },
      preflight: { databaseProbes, directoryBytes, databaseBytes, localFreeBytesAtStart: localFreeBytes, containerInventory: inventoryNames, unprotectedVolumes },
      restore: { automated: false, note: 'Артефакти перевірено checksum/gzip. Процедура автоматичного restore ще не реалізована.' } };
    writeJsonArtifact(manifestPath, restorePoint);
    plan.backup = { status: 'verified', createdAt: completedAt, directory: backupDir, manifest: manifestPath, artifacts,
      database: restorePoint.database, unprotectedVolumes, checksumsVerified: true };
    plan.deploy = { status: 'blocked-until-restore-workflow' };
    persistInstallerPlan(planId, plan);
    Object.assign(job, { status: 'verified', phase: 'done', processedBytes: job.totalBytes, finishedAt: completedAt, updatedAt: completedAt }); backupJobs.set(planId, job);
    return { ok: true, planId, backup: plan.backup };
  } catch (error) {
    plan.backup = { ...(plan.backup || {}), status: 'failed', failedAt: new Date().toISOString(), error: String(error.message || error), directory: backupDir };
    plan.deploy = { status: 'blocked-backup-failed' };
    persistInstallerPlan(planId, plan);
    Object.assign(job, { status: 'failed', phase: 'failed', error: plan.backup.error, finishedAt: plan.backup.failedAt, updatedAt: plan.backup.failedAt }); backupJobs.set(planId, job);
    try { writeJsonArtifact(manifestPath, { version: 1, status: 'failed', planId, server: plan.server, group: plan.group, error: plan.backup.error, failedAt: plan.backup.failedAt }); } catch {}
    throw error;
  }
}
function findServer(name) {
  const { servers } = loadServers();
  return servers.find(s => s.name === name) || null;
}
function resolveSshSettings(server = null) {
  const defaults = loadServers().defaults || {};
  const sshKey = server?.sshKey || defaults.sshKey || CFG.sshKey || '';
  const bootstrapKey = server?.bootstrapKey || defaults.bootstrapKey || CFG.bootstrapKey || '';
  const sshUser = server?.sshUser || defaults.sshUser || CFG.sshDefaultUser || 'akirpichnikov';
  return { sshKey, bootstrapKey, sshUser };
}
function configStatus() {
  const status = tokenStatus();
  const suggestedSshKey = join(homedir(), '.ssh', 'standwatch_monitoring').replace(/\\/g, '/');
  return { ...status, suggestedSshKey,
    sshKeyExists: !!status.sshKey && existsSync(status.sshKey),
    sshPublicKeyExists: !!status.sshKey && existsSync(status.sshKey + '.pub') };
}
const installerGitlabConfig = () => ({ baseUrl: CFG.gitlabUrl, token: CFG.token });
function cmdQuote(path) {
  return `"${String(path || '').replace(/^\/(\w)\//, '$1:/').replace(/\//g, '\\').replace(/"/g, '""')}"`;
}
// команда встановлення спільного ключа на новий хост (виконує користувач)
function keyInstallCommand(ssh, sshKey, bootstrapKey) {
  return `type ${cmdQuote(sshKey + '.pub')} | ssh -i ${cmdQuote(bootstrapKey || sshKey)} ${ssh} "umask 077; mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"`;
}

// Проєкти, для яких деплой налаштований (обгортка deploy-svc.sh):
//  rscore/retail/x5 — inline-версія в home/*.yml; rcc — версія в test/.env.
const YML_PROJECTS = new Set(['rscore', 'retail', 'x5', 'rcc']);
// Вшита обгортка деплою (щоб панель/exe генерували команду встановлення на новий сервер)
const DEPLOY_SVC_B64 = "IyEvYmluL2Jhc2gKIyBkZXBsb3ktc3ZjLnNoIDxwcm9qZWN0PiA8aW1hZ2U+IDx0YWc+CiMg0J/QtdGA0LXQvNC40LrQsNGUINCy0LXRgNGB0ZbRjiDQntCU0J3QntCT0J4g0YHQtdGA0LLRltGB0LAg0LIg0ZbQvdGB0YLQsNC70Y/RgtC+0YDRliAvdXNyL2xvY2FsLzxwcm9qZWN0PiDRlgojINC/0LXRgNC10YPRgdGC0LDQvdC+0LLQu9GO0ZQg0L/RgNC+0ZTQutGCINGH0LXRgNC10Lcgc2NyaXB0cy91cGRhdGUuc2guCiMKIyDQodGC0LDQstC40YLRjNGB0Y8g0L3QsCDQodCi0JXQndCUINGP0Logcm9vdDoKIyAgIHN1ZG8gY3AgZGVwbG95LXN2Yy5zaCAvdXNyL2xvY2FsL2Jpbi9kZXBsb3ktc3ZjLnNoCiMgICBzdWRvIGNob3duIHJvb3Q6cm9vdCAvdXNyL2xvY2FsL2Jpbi9kZXBsb3ktc3ZjLnNoCiMgICBzdWRvIGNobW9kIDc1NSAvdXNyL2xvY2FsL2Jpbi9kZXBsb3ktc3ZjLnNoCiMg0IYg0LTQvtC30LLRltC7INC90LAgcGFzc3dvcmRsZXNzIHN1ZG8g0YHQsNC80LUg0L3QsCDQvdGM0L7Qs9C+ICh2aXN1ZG8pOgojICAgYWtpcnBpY2huaWtvdiBBTEw9KHJvb3QpIE5PUEFTU1dEOiAvdXNyL2xvY2FsL2Jpbi9kZXBsb3ktc3ZjLnNoCiMKIyBEUlk9MSDigJQg0LvQuNGI0LUg0L/QvtC60LDQt9Cw0YLQuCwg0YnQviDQt9C80ZbQvdC40LvQvtGB0Y8g0LEsINCx0LXQtyBzZWQg0ZYg0LHQtdC3IHVwZGF0ZS5zaC4Kc2V0IC1ldW8gcGlwZWZhaWwKCiMg0JvQvtCz0ZbQvSDRgyBkb2NrZXIt0YDQtdGU0YHRgtGAINC60YDQtdC00LDQvNC4INC3IDxob21lPi8uZW52IChET0NLRVJfTE9HSU4vRE9DS0VSX1BBU1NXT1JEKSwKIyDQsdC+IHRlc3QvdXBkYXRlLnNoINGB0LDQvCDQvdC1INC70L7Qs9GW0L3QuNGC0YzRgdGPIOKGkiDRltC90LDQutGI0LUg0L/Rg9C7INC90L7QstC40YUg0YLQtdCz0ZbQsiA9IGFjY2VzcyBmb3JiaWRkZW4uCnJlZ2lzdHJ5X2xvZ2luKCkgewogIGxvY2FsIGVudmY9IiQxIgogIFsgLWYgIiRlbnZmIiBdIHx8IHJldHVybiAwCiAgbG9jYWwgTCBQIFIKICBMPSIkKGdyZXAgLUUgJ15ET0NLRVJfTE9HSU49JyAgICAiJGVudmYiIHwgdGFpbCAtMSB8IGN1dCAtZD0gLWYyLSkiCiAgUD0iJChncmVwIC1FICdeRE9DS0VSX1BBU1NXT1JEPScgIiRlbnZmIiB8IHRhaWwgLTEgfCBjdXQgLWQ9IC1mMi0pIgogIFI9IiQoZ3JlcCAtRSAnXkRPQ0tFUl9SRUdJU1RSWT0nICIkZW52ZiIgfCB0YWlsIC0xIHwgY3V0IC1kPSAtZjItKSI7IFI9IiR7UiUlLyp9IgogIEw9IiR7TCVcIn0iOyBMPSIke0wjXCJ9IjsgUD0iJHtQJVwifSI7IFA9IiR7UCNcIn0iOyBSPSIke1IlXCJ9IjsgUj0iJHtSI1wifSIKICBbIC1uICIkTCIgXSAmJiBbIC1uICIkUCIgXSAmJiBbIC1uICIkUiIgXSB8fCB7IGVjaG8gIiAgKNC90LXQvNCwIERPQ0tFUl8qINGDICRlbnZmIOKAlCDQv9GA0L7Qv9GD0YHQutCw0Y4gbG9naW4pIjsgcmV0dXJuIDA7IH0KICBwcmludGYgJyVzJyAiJFAiIHwgZG9ja2VyIGxvZ2luICIkUiIgLXUgIiRMIiAtLXBhc3N3b3JkLXN0ZGluID4vZGV2L251bGwgMj4mMSBcCiAgICAmJiBlY2hvICIgIGRvY2tlciBsb2dpbiDihpIgJFIg4pyTIiB8fCBlY2hvICIgIOKaoCBkb2NrZXIgbG9naW4g4oaSICRSINC90LUg0LLQtNCw0LLRgdGPIgp9CgpQUk9KPSIkezE6LX0iOyBJTUc9IiR7MjotfSI7IFRBRz0iJHszOi19IgpbIC1uICIkUFJPSiIgXSAmJiBbIC1uICIkSU1HIiBdICYmIFsgLW4gIiRUQUciIF0gfHwgeyBlY2hvICJ1c2FnZTogZGVwbG95LXN2Yy5zaCA8cHJvamVjdD4gPGltYWdlPiA8dGFnPiI7IGV4aXQgMjsgfQoKIyB3aGl0ZWxpc3Qg0L/RgNC+0ZTQutGC0ZbQsiAo0YDQvtC30YjQuNGA0Y7QuSDQt9CwINC/0L7RgtGA0LXQsdC4KQpjYXNlICIkUFJPSiIgaW4gcnNjb3JlfHJldGFpbHx4NXxyY2MpIDs7ICopIGVjaG8gInVua25vd24gcHJvamVjdDogJFBST0oiID4mMjsgZXhpdCAyOzsgZXNhYwojINGB0YPQstC+0YDQsCDQstCw0LvRltC00LDRhtGW0Y8gKNC30LDRhdC40YHRgiDQstGW0LQg0ZbQvSfRlNC60YbRltGXINGDIHNlZC/RiNC70Y/RhSkKW1sgIiRJTUciID1+IF5bQS1aYS16MC05Ll8tXSskIF1dIHx8IHsgZWNobyAiYmFkIGltYWdlIG5hbWUiID4mMjsgZXhpdCAyOyB9CltbICIkVEFHIiA9fiBeW0EtWmEtejAtOS5fKy1dKyQgXV0gfHwgeyBlY2hvICJiYWQgdGFnIiA+JjI7IGV4aXQgMjsgfQoKIyDilIDilIAgUkNDICguNTEpOiDQstC10YDRgdGW0Y8g0LIgdGVzdC8uZW52IChSQ0NfKl9JTUFHRSk7INC30LDRgdGC0L7RgdC+0LLRg9GU0LzQviDQvtGE0ZbRhtGW0LnQvdC40LwgdGVzdC91cGRhdGUuc2gg4pSA4pSACmlmIFsgIiRQUk9KIiA9ICJyY2MiIF07IHRoZW4KICBURD0iL3Vzci9sb2NhbC9yY2MvdGVzdCI7IFRFU1RFTlY9IiRURC8uZW52IjsgVVBEQVRFPSIkVEQvdXBkYXRlLnNoIgogIFsgLWYgIiRURVNURU5WIiBdIHx8IHsgZWNobyAibm8gJFRFU1RFTlYiID4mMjsgZXhpdCAyOyB9CiAgWyAtZiAiJFVQREFURSIgXSAgfHwgeyBlY2hvICJubyAkVVBEQVRFIiA+JjI7IGV4aXQgMjsgfQogIGdyZXAgLXFFICJeW14jXSovJElNRzpbQS1aYS16MC05Ll8rLV0rIiAiJFRFU1RFTlYiIHx8IHsgZWNobyAiaW1hZ2UgJyRJTUcnIG5vdCBpbiAkVEVTVEVOViIgPiYyOyBleGl0IDM7IH0KICBlY2hvICI9PSByY2M6ICRJTUcgLT4gJFRBRyAo0YMgdGVzdC8uZW52KSA9PSIKICBncmVwIC1uRSAiXlteI10qLyRJTUc6W0EtWmEtejAtOS5fKy1dKyIgIiRURVNURU5WIiB8IHNlZCAncy9eLyAg0LHRg9C70L46IC8nCiAgaWYgWyAiJHtEUlk6LTB9IiA9ICIxIiBdOyB0aGVuIGVjaG8gIkRSWT0xIOKAlCDQvdC1INC30LDRgdGC0L7RgdC+0LLQsNC90L4iOyBleGl0IDA7IGZpCiAgdHM9IiQoZGF0ZSArJVklbSVkLSVIJU0lUykiOyBiZGlyPSIvdXNyL2xvY2FsL3JjYy8uZGVwbG95LWJhY2t1cHMvJHRzIjsgbWtkaXIgLXAgIiRiZGlyIjsgY3AgIiRURVNURU5WIiAiJGJkaXIiLzsgZWNobyAiICDQsdC10LrQsNC/OiAkYmRpciIKICBzZWQgLWkgLUUgIi9eIy8hIHMjLyRJTUc6W0EtWmEtejAtOS5fKy1dKyMvJElNRzokVEFHI2ciICIkVEVTVEVOViIKICByZWdpc3RyeV9sb2dpbiAvdXNyL2xvY2FsL3JjYy9ob21lLy5lbnYgICAjIHRlc3QvdXBkYXRlLnNoINGB0LDQvCDQvdC1INC70L7Qs9GW0L3QuNGC0YzRgdGPCiAgZWNobyAiICDQt9Cw0YHRgtC+0YHQvtCy0YPRjiDQvtGE0ZbRhtGW0LnQvdC40LwgdGVzdC91cGRhdGUuc2jigKYiCiAgY2QgIiRURCIgJiYgYmFzaCB1cGRhdGUuc2ggICAgICMgY29tbW9uLnNoINGB0LDQvCDQstC40YHRgtCw0LLQu9GP0ZQgVEVTVF9ESVIsIFRFU1RfUkNDXypfSU1BR0UsINC80LXRgNC10LbRgyDRgtC+0YnQvgogIGVjaG8gIj09INCz0L7RgtC+0LLQvjogJElNRyDRgtC10L/QtdGAICRUQUcg0YMgcmNjID09IgogIGV4aXQgMApmaQoKSE9NRV9ESVI9Ii91c3IvbG9jYWwvJFBST0ovaG9tZSIKVVBEQVRFPSIvdXNyL2xvY2FsLyRQUk9KL3NjcmlwdHMvdXBkYXRlLnNoIgpbIC1kICIkSE9NRV9ESVIiIF0gfHwgeyBlY2hvICJubyBkaXI6ICRIT01FX0RJUiIgPiYyOyBleGl0IDI7IH0KWyAtZiAiJFVQREFURSIgXSB8fCB7IGVjaG8gIm5vIHVwZGF0ZS5zaDogJFVQREFURSIgPiYyOyBleGl0IDI7IH0gICMg0LfQsNC/0YPRgdC60LDRlNC80L4g0YfQtdGA0LXQtyBiYXNoICjRhNCw0LnQuyDQsdC10LcgK3gpCgojINC30L3QsNC50YLQuCDRhNCw0LnQu9C4LCDQtNC1INC30LPQsNC00YPRlNGC0YzRgdGPINGG0LXQuSDQvtCx0YDQsNC3IChsZWFkaW5nIHNsYXNoIOKAlCDRidC+0LEgZGV2aWNlLXNlcnZpY2UgIT0gdXNlci1kZXZpY2Utc2VydmljZSkKbWFwZmlsZSAtdCBmaWxlcyA8IDwoZ3JlcCAtbEUgIi8kSU1HOltBLVphLXowLTkuXystXSsiICIkSE9NRV9ESVIiLyoueW1sIDI+L2Rldi9udWxsIHx8IHRydWUpClsgIiR7I2ZpbGVzW0BdfSIgLWd0IDAgXSB8fCB7IGVjaG8gImltYWdlICckSU1HJyBub3QgZm91bmQgaW4gJEhPTUVfRElSLyoueW1sIiA+JjI7IGV4aXQgMzsgfQoKZWNobyAiPT0gJFBST0o6ICRJTUcgLT4gJFRBRyA9PSIKZm9yIGYgaW4gIiR7ZmlsZXNbQF19IjsgZG8KICBlY2hvICIgICRmOiI7IGdyZXAgLW5FICIvJElNRzpbQS1aYS16MC05Ll8rLV0rIiAiJGYiIHwgc2VkICdzL14vICAgINCx0YPQu9C+OiAvJwpkb25lCgppZiBbICIke0RSWTotMH0iID0gIjEiIF07IHRoZW4gZWNobyAiRFJZPTEg4oCUINC30LzRltC90Lgg0L3QtSDQt9Cw0YHRgtC+0YHQvtCy0LDQvdC+LCB1cGRhdGUuc2gg0L3QtSDQt9Cw0L/Rg9GB0LrQsNCy0YHRjyI7IGV4aXQgMDsgZmkKCiMg0LHQtdC60LDQvyB5bWwg0L/QtdGA0LXQtCDQt9C80ZbQvdC+0Y4KdHM9IiQoZGF0ZSArJVklbSVkLSVIJU0lUykiOyBiZGlyPSIvdXNyL2xvY2FsLyRQUk9KLy5kZXBsb3ktYmFja3Vwcy8kdHMiCm1rZGlyIC1wICIkYmRpciI7IGNwICIkSE9NRV9ESVIiLyoueW1sICIkYmRpciIvOyBlY2hvICIgINCx0LXQutCw0L86ICRiZGlyIgoKZm9yIGYgaW4gIiR7ZmlsZXNbQF19IjsgZG8KICBzZWQgLWkgLUUgInMjLyRJTUc6W0EtWmEtejAtOS5fKy1dKyMvJElNRzokVEFHI2ciICIkZiIKZG9uZQpyZWdpc3RyeV9sb2dpbiAiJEhPTUVfRElSLy5lbnYiCmVjaG8gIiAg0LfQvNGW0L3QtdC90L4sINC30LDQv9GD0YHQutCw0Y4gdXBkYXRlLnNo4oCmIgpjZCAiL3Vzci9sb2NhbC8kUFJPSiIgJiYgYmFzaCAiJFVQREFURSIKZWNobyAiPT0g0LPQvtGC0L7QstC+OiAkSU1HINGC0LXQv9C10YAgJFRBRyDRgyAkUFJPSiA9PSIK";
const TAG_RE = /^[A-Za-z0-9._+-]+$/;
const IMG_RE = /^[A-Za-z0-9._-]+$/;

// Команда перемикання версії сервіса (для показу/копіювання).
function deployCommand(project, image, tag) {
  if (!project || !IMG_RE.test(image) || !TAG_RE.test(tag)) return `# некоректні параметри`;
  if (project === 'rcc') {
    return [
      `# RCC (.51): версія в test/.env. Виконати від root:`,
      `sudo /usr/local/bin/deploy-svc.sh rcc ${image} ${tag}`,
      `# (править RCC_*_IMAGE у /usr/local/rcc/test/.env і піднімає ${image})`,
    ].join('\n');
  }
  if (YML_PROJECTS.has(project)) {
    return [
      `# на стенді від root (одноразово: встанови tools/deploy-svc.sh — див. README):`,
      `sudo /usr/local/bin/deploy-svc.sh ${project} ${image} ${tag}`,
      `#`,
      `# або вручну те саме:`,
      `cd /usr/local/${project} \\`,
      `  && sudo sed -i -E 's#/${image}:[A-Za-z0-9._+-]+#/${image}:${tag}#g' home/*.yml \\`,
      `  && sudo ./scripts/update.sh`,
    ].join('\n');
  }
  return `# для проєкту «${project}» деплой ще не налаштований (інша схема інсталятора)`;
}

// Виконати команду по SSH (async, не блокує). Повертає {code,out,err}.
async function sshExec(server, remoteCmd) {
  const res = await sshRun(server.ssh, resolveSshSettings(server).sshKey, [remoteCmd], { timeout: 180000 });
  const clean = (s) => (s || '').split('\n').filter(l => !/post-quantum|store now|may need to be upgraded|openssh\.com\/pq/i.test(l)).join('\n');
  return { code: res.status, out: clean(res.stdout), err: clean(res.stderr) };
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function inspectRemoteContainers(server) {
  const result = await sshRun(server.ssh, resolveSshSettings(server).sshKey,
    [`ids=$(docker ps -aq); if [ -z "$ids" ]; then printf '[]'; else docker inspect $ids; fi`], { timeout: 120000 });
  if (result.status !== 0) throw new Error('docker inspect: ' + (result.stderr || `exit ${result.status}`));
  try { return JSON.parse(result.stdout || '[]'); }
  catch { throw new Error('docker inspect повернув некоректний JSON'); }
}
async function remoteApplyPrerequisites(server, absolutePath, format = 'json') {
  const command = `set -eu
target=${shellQuote(absolutePath)}
dir=$(dirname -- "$target")
format=${shellQuote(format)}
command -v sha256sum >/dev/null
command -v base64 >/dev/null
case "$format" in
  json) if command -v jq >/dev/null 2>&1; then validator=jq; elif command -v python3 >/dev/null 2>&1; then validator=python3; else exit 72; fi ;;
  yaml) validator=js-yaml+sha256 ;;
  shell) command -v bash >/dev/null 2>&1 || exit 72; validator=bash-n ;;
  *) exit 72 ;;
esac
if helper_out=$(sudo -n ${shellQuote(REMOTE_CONFIG_HELPER)} check "$target" 2>/dev/null); then mode=helper; helper_fields=$(printf '%s' "$helper_out" | awk -F: '{print NF}'); if [ "$helper_fields" -ge 4 ]; then helper_version=$(printf '%s' "$helper_out" | awk -F: '{print $2}'); else helper_version=legacy; fi; validator=$(printf '%s' "$helper_out" | awk -F: '{print $NF}')
elif [ -w "$target" ] && [ -w "$dir" ] && [ "$(stat -c %u "$target")" = "$(id -u)" ]; then mode=user
elif sudo -n true >/dev/null 2>&1; then mode=sudo
else echo 'файл/директорія не writable для SSH-користувача, а sudo без пароля недоступний' >&2; exit 73
fi
printf '%s:%s:%s' "$mode" "$validator" "\${helper_version:-none}"`;
  const result = await sshRun(server.ssh, resolveSshSettings(server).sshKey, [command], { timeout: 30000 });
  const [writeMode, validator, helperVersion] = result.status === 0 ? String(result.stdout || '').trim().split(':') : [];
  const valid = format === 'json' ? ['jq', 'python3'] : format === 'yaml' ? ['js-yaml+sha256'] : ['bash-n'];
  const helperCurrent = writeMode !== 'helper' || helperVersion === REMOTE_CONFIG_HELPER_VERSION;
  return { ok: result.status === 0 && ['helper', 'user', 'sudo'].includes(writeMode) && valid.includes(validator) && helperCurrent,
    writeMode: writeMode || null, validator: validator || null, helperVersion: helperVersion || null,
    helperOutdated: writeMode === 'helper' && !helperCurrent,
    error: result.status === 0 ? null : String(result.stderr || `exit ${result.status}`).trim().slice(0, 500) };
}
function transactionFile(id) {
  assertTransactionId(id);
  return join(CONFIG_TRANSACTIONS_DIR, id + '.json');
}
function saveConfigTransaction(value) {
  mkdirSync(CONFIG_TRANSACTIONS_DIR, { recursive: true });
  const target = transactionFile(value.id), temporary = target + '.part';
  writeFileSync(temporary, JSON.stringify(value, null, 2));
  renameSync(temporary, target);
}
function loadConfigTransaction(id) {
  const path = transactionFile(id);
  if (!existsSync(path)) throw new Error('транзакцію не знайдено');
  return JSON.parse(readFileSync(path, 'utf8'));
}
async function waitContainerHealth(server, names, { timeout = 45000 } = {}) {
  const deadline = Date.now() + timeout;
  let last = { ok: false, rows: [] }, stable = 0, signature = '';
  while (Date.now() < deadline) {
    last = containerHealth(await inspectRemoteContainers(server), names);
    const nextSignature = last.rows.map(row => `${row.name}:${row.state}:${row.health || '-'}:${row.restartCount}`).join('|');
    if (last.ok && nextSignature === signature) stable++; else stable = last.ok ? 1 : 0;
    signature = nextSignature;
    if (stable >= 2) return last;
    await delay(2000);
  }
  throw new Error('health-check timeout: ' + last.rows.map(row => `${row.name}=${row.state || 'missing'}/${row.health || 'no-health'}`).join(', '));
}
async function restartContainers(server, names) {
  if (!names.length) throw new Error('нема контейнерів для restart');
  const result = await sshRun(server.ssh, resolveSshSettings(server).sshKey,
    [`docker restart --time 20 ${names.map(shellQuote).join(' ')}`], { timeout: 180000 });
  if (result.status !== 0) throw new Error('docker restart: ' + (result.stderr || `exit ${result.status}`));
  return waitContainerHealth(server, names);
}
async function remoteAtomicConfigWrite(server, paths, transactionId, targetText, targetSha256, beforeSha256, writeMode, format = 'json') {
  if (writeMode === 'helper') {
    const command = `sudo -n ${shellQuote(REMOTE_CONFIG_HELPER)} apply ${shellQuote(paths.target)} ${shellQuote(transactionId)} ${shellQuote(beforeSha256)} ${shellQuote(targetSha256)}`;
    const result = await sshRun(server.ssh, resolveSshSettings(server).sshKey, [command], { input: targetText, timeout: 120000 });
    if (result.status !== 0) throw new Error('root helper atomic write: ' + (result.stderr || `exit ${result.status}`));
    return result.stdout;
  }
  const encoded = Buffer.from(targetText, 'utf8').toString('base64');
  const script = `set -eu
target=${shellQuote(paths.target)}
tmp=${shellQuote(paths.temporary)}
snap=${shellQuote(paths.snapshot)}
mode=${shellQuote(writeMode)}
format=${shellQuote(format)}
run(){ if [ "$mode" = sudo ]; then sudo -n "$@"; else "$@"; fi; }
cleanup(){ run rm -f -- "$tmp" >/dev/null 2>&1 || true; }
trap cleanup EXIT
test -f "$target"
command -v sha256sum >/dev/null
command -v base64 >/dev/null
[ "$mode" = user ] || sudo -n true
before=$(run sha256sum "$target" | awk '{print $1}')
test "$before" = ${shellQuote(beforeSha256)}
run cp --preserve=all -- "$target" "$snap"
snapshot_sha=$(run sha256sum "$snap" | awk '{print $1}')
test "$snapshot_sha" = ${shellQuote(beforeSha256)}
run cp --preserve=all -- "$target" "$tmp"
printf '%s' ${shellQuote(encoded)} | base64 -d | run tee "$tmp" >/dev/null
actual=$(run sha256sum "$tmp" | awk '{print $1}')
test "$actual" = ${shellQuote(targetSha256)}
if [ ${shellQuote(targetSha256)} != ${shellQuote(beforeSha256)} ]; then
  case "$format" in
    json) if command -v jq >/dev/null 2>&1; then run jq empty "$tmp" >/dev/null; elif command -v python3 >/dev/null 2>&1; then run python3 -m json.tool "$tmp" >/dev/null; else echo 'remote JSON validator not found' >&2; exit 72; fi ;;
    yaml) : ;; # exact bytes already parsed by bundled js-yaml; SHA checked above
    shell) command -v bash >/dev/null 2>&1 && run bash -n "$tmp" ;;
    *) exit 72 ;;
  esac
fi
run mv -f -- "$tmp" "$target"
trap - EXIT
printf 'SNAPSHOT=%s\\nSHA256=%s\\n' "$snap" "$actual"`;
  const result = await sshRun(server.ssh, resolveSshSettings(server).sshKey, ['bash -s'], { input: script, timeout: 120000 });
  if (result.status !== 0) throw new Error('atomic write: ' + (result.stderr || `exit ${result.status}`));
  return result.stdout;
}
async function remoteRollbackConfig(server, transaction) {
  const p = transaction.remote;
  if (transaction.writeMode === 'helper') {
    const command = `sudo -n ${shellQuote(REMOTE_CONFIG_HELPER)} rollback ${shellQuote(p.target)} ${shellQuote(transaction.id)} ${shellQuote(transaction.hashes.before)}`;
    const result = await sshRun(server.ssh, resolveSshSettings(server).sshKey, [command], { timeout: 120000 });
    if (result.status !== 0) throw new Error('root helper rollback: ' + (result.stderr || `exit ${result.status}`));
    const live = await readLiveConfig(server, transaction.installRoot, transaction.path);
    if (sha256Text(live) !== transaction.hashes.before) throw new Error('rollback SHA не збігається з T2');
    return { ok: true, rows: [], fileOnly: true };
  }
  const script = `set -eu
target=${shellQuote(p.target)}
snap=${shellQuote(p.snapshot)}
tmp=${shellQuote(p.temporary + '.rollback')}
mode=${shellQuote(transaction.writeMode)}
run(){ if [ "$mode" = sudo ]; then sudo -n "$@"; else "$@"; fi; }
cleanup(){ run rm -f -- "$tmp" >/dev/null 2>&1 || true; }
trap cleanup EXIT
test -f "$snap"
actual=$(run sha256sum "$snap" | awk '{print $1}')
test "$actual" = ${shellQuote(transaction.hashes.before)}
run cp --preserve=all -- "$snap" "$tmp"
run mv -f -- "$tmp" "$target"
trap - EXIT
printf 'RESTORED_SHA256=%s\\n' "$actual"`;
  const result = await sshRun(server.ssh, resolveSshSettings(server).sshKey, ['bash -s'], { input: script, timeout: 120000 });
  if (result.status !== 0) throw new Error('rollback: ' + (result.stderr || `exit ${result.status}`));
  const live = await readLiveConfig(server, transaction.installRoot, transaction.path);
  if (sha256Text(live) !== transaction.hashes.before) throw new Error('rollback SHA не збігається з T2');
  return { ok: true, rows: [], fileOnly: true };
}
async function recoverFailedConfigApply(context, transaction) {
  // An atomic writer may reject staged bytes before mv. If live still has the
  // verified pre-apply SHA, rollback is unnecessary and must not hide that fact.
  try {
    const liveSha = await readLiveConfigSha(context.targetServer, context.binding.installRoot, context.path);
    transaction.verifiedLiveSha = liveSha;
    transaction.verifiedAt = new Date().toISOString();
    if (liveSha === transaction.hashes.before) {
      transaction.status = 'apply-rejected-live-unchanged';
      transaction.verifiedUnchangedAfterError = true;
      return;
    }
  } catch (verifyError) {
    transaction.postErrorVerificationError = String(verifyError.message || verifyError).slice(0, 1000);
  }
  try {
    transaction.rollbackHealth = await remoteRollbackConfig(context.targetServer, transaction);
    transaction.status = 'rolled-back-automatically';
    transaction.rolledBackAt = new Date().toISOString();
  } catch (rollbackError) {
    transaction.status = 'rollback-failed';
    transaction.rollbackError = String(rollbackError.message || rollbackError).slice(0, 1000);
  }
}
async function prepareConfigContext(body) {
  const targetServer = findServer(body.server);
  if (!targetServer) throw new Error('сервер не знайденено');
  const group = String(body.group || 'rscore'), path = String(body.path || ''), fmt = configFormat(path);
  if (!/^[A-Za-z0-9._][A-Za-z0-9._/-]*$/.test(path) || path.includes('..') || fmt !== 'json') {
    throw new Error('apply MVP підтримує лише коректний .json шлях');
  }
  const binding = resolveConfigBinding(targetServer, group);
  if (!binding) throw new Error('нема зафіксованого installer binding');
  let backupText, liveText, installerText, backupSource;
  try { liveText = await readLiveConfig(targetServer, binding.installRoot, path); }
  catch (e) { throw new Error('SSH live-файл: ' + e.message); }
  try { const loaded = await readVerifiedBackupConfig(targetServer, group, path, binding, liveText); backupText = loaded.text; backupSource = loaded.source; }
  catch (e) { throw new Error('verified baseline: ' + e.message); }
  try { installerText = await installerFileText(installerGitlabConfig(), binding.project, path, binding.ref); }
  catch (e) { throw new Error('installer-файл: ' + e.message); }
  let backupObj, installerObj;
  try { backupObj = parseConfig(path, backupText); installerObj = parseConfig(path, installerText); }
  catch (e) { throw new Error('parse: ' + e.message); }
  const result = reconcileConfig(backupObj, installerObj, {});
  const conflictRows = new Map(result.rows.filter(row => !row.auto).map(row => [row.key, row]));
  const decisions = {};
  for (const [key, value] of Object.entries(body.decisions || {})) {
    const row = conflictRows.get(key); if (!row) continue;
    if (value && typeof value === 'object' && 'value' in value) {
      try { decisions[key] = { value: coerceManualValue(value.value, row, fmt) }; }
      catch (e) { const error = new Error(e.message); error.invalid = { key, message: e.message }; throw error; }
    } else decisions[key] = value === 'installer' ? 'installer' : 'backup';
  }
  const built = buildTargetConfig(result, decisions);
  if (built.unresolved.length) { const error = new Error('не всі конфлікти вирішено'); error.unresolved = built.unresolved; throw error; }
  const targetText = materializeConfig(path, built.flat);
  try { parseConfig(path, targetText); } catch (e) { throw new Error('target parse: ' + e.message); }
  const absolutePath = binding.installRoot.replace(/\/+$/, '') + '/' + path;
  const affected = [];
  const prerequisites = await remoteApplyPrerequisites(targetServer, absolutePath, 'json');
  const backupSha256 = sha256Text(backupText), liveSha256 = sha256Text(liveText);
  const comments = { backup: hasJsonComments(backupText), installer: hasJsonComments(installerText) };
  const gates = {
    verifiedBackup: true,
    liveMatchesBackup: backupSha256 === liveSha256,
    noJsoncComments: !comments.backup && !comments.installer,
    targetParses: true,
    remoteToolsReady: prerequisites.ok,
    targetDiffers: liveSha256 !== sha256Text(targetText),
  };
  return { targetServer, group, path, fmt, binding, backupSource, backupText, liveText, installerText,
    targetText, decisions, absolutePath, affected, comments, gates, prerequisites,
    hashes: { backup: backupSha256, live: liveSha256, installer: sha256Text(installerText), target: sha256Text(targetText) } };
}

async function prepareMergedFileContext(body) {
  const targetServer = findServer(body.server);
  if (!targetServer) throw new Error('сервер не знайдено');
  const group = String(body.group || 'rscore'), path = String(body.path || '');
  const format = /\.json$/i.test(path) ? 'json' : /\.ya?ml$/i.test(path) ? 'yaml' : /^scripts\/[A-Za-z0-9._/-]+\.sh$/i.test(path) ? 'shell' : null;
  const allowedYaml = /^(?:home|volumes\/config)\/[A-Za-z0-9._/-]+\.ya?ml$/i.test(path);
  const allowedJson = /^volumes\/config\/[A-Za-z0-9._/-]+\.json$/i.test(path);
  if (!/^[A-Za-z0-9._][A-Za-z0-9._/-]*$/.test(path) || path.includes('..') || !format || (format === 'yaml' && !allowedYaml) || (format === 'json' && !allowedJson)) {
    throw new Error('дозволено лише volumes/config/*.json|yaml, home/*.yml або scripts/*.sh');
  }
  const binding = resolveConfigBinding(targetServer, group);
  if (!binding) throw new Error('нема зафіксованого installer binding');
  let baselineText, liveText, installerText, baselineSource;
  try { liveText = await readLiveConfig(targetServer, binding.installRoot, path); }
  catch (e) { throw new Error('SSH live-файл: ' + e.message); }
  try { const loaded = await readVerifiedBackupConfig(targetServer, group, path, binding, liveText); baselineText = loaded.text; baselineSource = loaded.source; }
  catch (e) { throw new Error('verified baseline: ' + e.message); }
  try { installerText = await installerFileText(installerGitlabConfig(), binding.project, path, binding.ref); }
  catch (e) { throw new Error('installer-файл: ' + e.message); }
  const merged = mergeTextHunks(baselineText, installerText, body.decisions || {});
  if (merged.unresolved.length) { const error = new Error('не всі блоки змін мають рішення'); error.unresolved = merged.unresolved; throw error; }
  if (Buffer.byteLength(merged.targetText, 'utf8') > 2 * 1024 * 1024) throw new Error('цільовий файл перевищує безпечний ліміт 2 MiB');
  if (merged.targetText.includes('\0')) throw new Error('цільовий файл містить NUL');
  if (format === 'yaml') {
    try { parseYaml(merged.targetText); } catch (e) { throw new Error('target YAML: ' + e.message); }
  } else if (format === 'json') {
    try { parseConfig(path, merged.targetText); } catch (e) { throw new Error('target JSON: ' + e.message); }
  }
  const absolutePath = binding.installRoot.replace(/\/+$/, '') + '/' + path;
  const prerequisites = await remoteApplyPrerequisites(targetServer, absolutePath, format);
  const baselineSha256 = sha256Text(baselineText), liveSha256 = sha256Text(liveText), targetSha256 = sha256Text(merged.targetText);
  const gates = { verifiedBackup: true, liveMatchesBackup: baselineSha256 === liveSha256,
    targetParses: true, remoteToolsReady: prerequisites.ok, targetDiffers: liveSha256 !== targetSha256 };
  return { targetServer, group, path, format, binding, baselineSource, baselineText, liveText, installerText,
    targetText: merged.targetText, decisions: body.decisions || {}, absolutePath, prerequisites, gates,
    hashes: { baseline: baselineSha256, live: liveSha256, installer: sha256Text(installerText), target: targetSha256 },
    hunkCount: merged.hunkCount };
}

async function prepareMergedFileBatch(body) {
  const files = Array.isArray(body.files) ? body.files : [];
  if (!files.length || files.length > 50) throw new Error('пакет має містити від 1 до 50 файлів');
  const seen = new Set(), contexts = [];
  for (const file of files) {
    const path = String(file?.path || '');
    if (seen.has(path)) throw new Error('файл дублюється у пакеті: ' + path);
    seen.add(path);
    contexts.push(await prepareMergedFileContext({ server: body.server, group: body.group, path, decisions: file?.decisions || {} }));
  }
  return contexts;
}

const mergedContextReady = context => context.gates.verifiedBackup && context.gates.liveMatchesBackup &&
  context.gates.targetParses && (!context.gates.targetDiffers || context.gates.remoteToolsReady);

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve) => {
    let s = ''; req.on('data', d => s += d);
    req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch { resolve({}); } });
  });
}

let pageHits = 0; // скільки разів браузер реально завантажив сторінку (для детекту, чи вікно відкрилось)
let windowCloseTimer = null;
const launchedBrowserPids = new Set();
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  try {
    if (url.pathname === '/') {
      pageHits++;
      if (windowCloseTimer) { clearTimeout(windowCloseTimer); windowCloseTimer = null; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(PAGE);
    }
    if (url.pathname === '/api/ping') {
      // маркер «це наш інстанс» — за ним новий запуск відрізняє живу копію ЦІЄЇ теки від чужого сервера
      return json(res, 200, { app: 'standwatch', pid: process.pid, dataDir: DATA_DIR });
    }
    if (url.pathname === '/api/open-window' && req.method === 'POST') {
      stampWindow();
      openAppWindow();
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/servers') {
      return json(res, 200, loadServers());
    }
    if (url.pathname === '/api/quit' && req.method === 'POST') {
      json(res, 200, { ok: true });
      console.log('Зупинка за запитом з UI.');
      setTimeout(shutdownApp, 200);
      return;
    }
    if (url.pathname === '/api/window-closed' && req.method === 'POST') {
      json(res, 200, { ok: true });
      clearWindowStamp();
      const hitsAtClose = pageHits;
      if (windowCloseTimer) clearTimeout(windowCloseTimer);
      // pagehide також спрацьовує при refresh. Новий GET / скасує цей таймер.
      windowCloseTimer = setTimeout(() => {
        windowCloseTimer = null;
        if (pageHits === hitsAtClose) shutdownApp();
      }, 1500);
      return;
    }
    if (url.pathname === '/api/config' && req.method !== 'POST') {
      return json(res, 200, configStatus());
    }
    if (url.pathname === '/api/config' && req.method === 'POST') {
      const b = await readBody(req);
      setTokens({ gitlabToken: b.gitlabToken, gitlabUser: b.gitlabUser, teamcityToken: b.teamcityToken,
        sshKey: b.sshKey, bootstrapKey: b.bootstrapKey, sshDefaultUser: b.sshDefaultUser });
      const kv = {};
      if (b.gitlabToken) kv.GITLAB_TOKEN = b.gitlabToken;
      if (b.gitlabUser) kv.GITLAB_USER = b.gitlabUser;
      if (b.teamcityToken) kv.TEAMCITY_TOKEN = b.teamcityToken;
      if (b.sshKey != null && b.sshKey !== '') kv.SSH_KEY = b.sshKey;
      if (b.bootstrapKey != null && b.bootstrapKey !== '') kv.SSH_BOOTSTRAP_KEY = b.bootstrapKey;
      if (b.sshDefaultUser != null && b.sshDefaultUser !== '') kv.SSH_DEFAULT_USER = b.sshDefaultUser;
      try { saveEnv(kv); } catch (e) { return json(res, 200, { ok: false, error: 'збережено в пам\'ять, але файл не записався: ' + e.message, ...configStatus() }); }
      return json(res, 200, { ok: true, ...configStatus() });
    }
    if (url.pathname === '/api/create-ssh-key' && req.method === 'POST') {
      const b = await readBody(req);
      const keyPath = String(b.path || configStatus().suggestedSshKey).trim();
      if (!keyPath) return json(res, 400, { ok: false, error: 'Не задано шлях до ключа.' });
      const privateExists = existsSync(keyPath), publicExists = existsSync(keyPath + '.pub');
      if (privateExists && publicExists) {
        setTokens({ sshKey: keyPath });
        saveEnv({ SSH_KEY: keyPath });
        return json(res, 200, { ok: true, existed: true, path: keyPath, ...configStatus() });
      }
      if (privateExists || publicExists) return json(res, 409, { ok: false,
        error: `За цим шляхом уже є лише частина пари ключів. Перевір файли ${keyPath} та ${keyPath}.pub вручну.` });
      try { mkdirSync(dirname(keyPath), { recursive: true }); }
      catch (e) { return json(res, 400, { ok: false, error: 'Не вдалося створити каталог: ' + e.message }); }
      const made = spawnSync('ssh-keygen', ['-t', 'ed25519', '-f', keyPath, '-N', '', '-C', `standwatch-monitoring@${process.env.COMPUTERNAME || 'windows'}`],
        { encoding: 'utf8', windowsHide: true, timeout: 15000 });
      if (made.status !== 0 || !existsSync(keyPath) || !existsSync(keyPath + '.pub')) {
        return json(res, 500, { ok: false, error: 'Не вдалося створити ключ через ssh-keygen: ' + (made.stderr || made.error?.message || `код ${made.status}`) });
      }
      setTokens({ sshKey: keyPath });
      try { saveEnv({ SSH_KEY: keyPath }); }
      catch (e) { return json(res, 500, { ok: false, error: 'Ключ створено, але шлях не збережено: ' + e.message, path: keyPath }); }
      return json(res, 200, { ok: true, created: true, path: keyPath, ...configStatus() });
    }
    if (url.pathname === '/api/cached') {
      return json(res, 200, loadCache(url.searchParams.get('server')) || { savedAt: null, data: null });
    }
    if (url.pathname === '/api/installer/catalog' && req.method !== 'POST') {
      return json(res, 200, loadInstallerCatalog());
    }
    if (url.pathname === '/api/installer/catalog' && req.method === 'POST') {
      const body = await readBody(req);
      try { return json(res, 200, { ok: true, catalog: saveInstallerCatalog(body.catalog || body) }); }
      catch (error) { return json(res, 400, { ok: false, error: error.message }); }
    }
    if (url.pathname === '/api/installer/detect-roots') {
      const targetServer = findServer(url.searchParams.get('server'));
      if (!targetServer) return json(res, 404, { error: 'сервер не знайдено' });
      const manifestRoot = String(url.searchParams.get('manifestRoot') || '').replace(/^\/+|\/+$/g, '');
      const remote = `ids=$(docker ps -q); [ -z "$ids" ] || docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}\t{{index .Config.Labels "com.docker.compose.project.working_dir"}}\t{{index .Config.Labels "com.docker.compose.project.config_files"}}\t{{.Name}}' $ids`;
      const result = await sshRun(targetServer.ssh, resolveSshSettings(targetServer).sshKey, [remote], { timeout: 60000 });
      const found = new Map();
      for (const line of String(result.stdout || '').split(/\r?\n/)) {
        const [group, workingDir, configFiles, container] = line.split('\t');
        if (!group || group === '<no value>') continue;
        if (!found.has(group)) found.set(group, { group, workingDirs: new Set(), configFiles: new Set(), containers: [] });
        const item = found.get(group); if (workingDir && workingDir !== '<no value>') item.workingDirs.add(workingDir);
        if (configFiles && configFiles !== '<no value>') for (const file of configFiles.split(',')) if (file.trim()) item.configFiles.add(file.trim());
        if (container) item.containers.push(container.replace(/^\//, ''));
      }
      const cached = loadCache(targetServer.name), cachedGroups = new Set(((cached?.data?.rows) || []).map(row => row.deployed?.project).filter(Boolean));
      const groups = [...new Set([...found.keys(), ...cachedGroups])].sort().map(group => {
        const item = found.get(group), workingDirs = item ? [...item.workingDirs] : [];
        const candidates = [...new Set(workingDirs.map(path => manifestRoot && path.endsWith('/' + manifestRoot) ? path.slice(0, -(manifestRoot.length + 1)) || '/' : path))];
        return { group, root: candidates.length === 1 ? candidates[0] : null, candidates, workingDirs,
          configFiles: item ? [...item.configFiles] : [], containers: item ? item.containers.length : 0,
          confidence: candidates.length === 1 ? 'docker-label' : candidates.length > 1 ? 'ambiguous' : 'suggested',
          suggestedRoot: '/usr/local/' + group };
      });
      return json(res, 200, { server: targetServer.name, groups, sshError: result.status && !result.stdout ? result.stderr : null });
    }
    if (url.pathname === '/api/installer/projects') {
      if (!CFG.token) return json(res, 400, { error: 'GitLab token не налаштований' });
      return json(res, 200, await searchInstallerProjects(installerGitlabConfig(), url.searchParams.get('search') || 'installer'));
    }
    if (url.pathname === '/api/installer/refs') {
      const project = url.searchParams.get('project');
      if (!project) return json(res, 400, { error: 'project обов’язковий' });
      return json(res, 200, await installerRefs(installerGitlabConfig(), project));
    }
    if (url.pathname === '/api/installer/commits') {
      const project = url.searchParams.get('project'), branch = url.searchParams.get('branch');
      if (!project || !branch) return json(res, 400, { error: 'project і branch обов’язкові' });
      return json(res, 200, await installerCommits(installerGitlabConfig(), project, branch, 30));
    }
    if (url.pathname === '/api/installer/snapshot') {
      const project = url.searchParams.get('project'), ref = url.searchParams.get('ref');
      if (!project || !ref) return json(res, 400, { error: 'project і ref обов’язкові' });
      return json(res, 200, await installerSnapshot(installerGitlabConfig(), {
        project, ref, manifestRoot: url.searchParams.get('root') || 'home',
      }));
    }
    if (url.pathname === '/api/reconcile/yaml') {
      // YAML/Envoy preview; apply is a separate explicit file-only transaction.
      const targetServer = findServer(url.searchParams.get('server'));
      if (!targetServer) return json(res, 404, { error: 'сервер не знайдено' });
      const group = String(url.searchParams.get('group') || 'rscore');
      const path = String(url.searchParams.get('path') || '');
      if (!/^[A-Za-z0-9._][A-Za-z0-9._/-]*\.ya?ml$/i.test(path) || path.includes('..'))
        return json(res, 400, { error: 'потрібен коректний шлях до .yaml/.yml' });
      const binding = resolveConfigBinding(targetServer, group);
      if (!binding) return json(res, 400, { error: 'для цієї групи не зафіксовано installer' });
      const sourceMeta = resolveVerifiedConfigBackup({ plansDir: PLANS_DIR, backupsDir: BACKUPS_DIR, serverName: targetServer.name, group, binding });
      if (!sourceMeta) return json(res, 200, { error: 'нема verified full backup для YAML baseline' });
      const cacheParts = ['yaml', targetServer.name, group, path, binding.project, binding.ref, binding.installRoot, sourceMeta.id];
      let quickLiveSha;
      try { quickLiveSha = await readLiveConfigSha(targetServer, binding.installRoot, path); }
      catch (e) { return json(res, 200, { error: 'SSH live SHA: ' + e.message }); }
      if (url.searchParams.get('refresh') !== '1') {
        const saved = loadConfigPreviewCache(cacheParts);
        if (saved?.payload?.liveSha256 === quickLiveSha) return json(res, 200, { ...saved.payload, cached: true, cacheKind: 'persistent-sha' });
      }
      let liveText, baselineText, baselineSource, installerText;
      try { liveText = await readLiveConfig(targetServer, binding.installRoot, path); }
      catch (e) { return json(res, 200, { error: 'SSH live-файл: ' + e.message }); }
      try { const loaded = await readVerifiedBackupConfig(targetServer, group, path, binding, liveText); baselineText = loaded.text; baselineSource = loaded.source; }
      catch (e) { return json(res, 200, { error: 'verified baseline: ' + e.message }); }
      try { installerText = await installerFileText(installerGitlabConfig(), binding.project, path, binding.ref); }
      catch (e) { return json(res, 200, { error: 'installer-файл недоступний: ' + e.message }); }
      let result;
      try { result = reconcileYaml(baselineText, installerText); }
      catch (e) { return json(res, 200, { error: 'YAML parse: ' + e.message }); }
      const baselineSha256 = sha256Text(baselineText), liveSha256 = sha256Text(liveText);
      const payload = { server: targetServer.name, group, path, format: 'yaml', fileApply: true, restartDeferred: true,
        project: binding.project, ref: binding.ref, installRoot: binding.installRoot,
        baselineKind: baselineSource.kind, baselineId: baselineSource.id,
        baselineSha256, liveSha256, serverMatchesBaseline: baselineSha256 === liveSha256,
        ...result, textDiff: yamlLineDiff(baselineText, installerText) };
      saveConfigPreviewCache(cacheParts, payload);
      return json(res, 200, payload);
    }
    if (url.pathname === '/api/reconcile/text') {
      const targetServer = findServer(url.searchParams.get('server'));
      if (!targetServer) return json(res, 404, { error: 'сервер не знайдено' });
      const group = String(url.searchParams.get('group') || 'rscore'), path = String(url.searchParams.get('path') || '');
      if (!/^scripts\/[A-Za-z0-9._/-]+\.sh$/i.test(path) || path.includes('..')) return json(res, 400, { error: 'дозволено лише scripts/*.sh' });
      const binding = resolveConfigBinding(targetServer, group);
      if (!binding) return json(res, 400, { error: 'для цієї групи не зафіксовано installer' });
      const sourceMeta = resolveVerifiedConfigBackup({ plansDir: PLANS_DIR, backupsDir: BACKUPS_DIR, serverName: targetServer.name, group, binding });
      if (!sourceMeta) return json(res, 200, { error: 'нема verified full backup для text baseline' });
      const cacheParts = ['text', targetServer.name, group, path, binding.project, binding.ref, binding.installRoot, sourceMeta.id];
      let quickLiveSha;
      try { quickLiveSha = await readLiveConfigSha(targetServer, binding.installRoot, path); }
      catch (e) { return json(res, 200, { error: 'SSH live SHA: ' + e.message }); }
      if (url.searchParams.get('refresh') !== '1') {
        const saved = loadConfigPreviewCache(cacheParts);
        if (saved?.payload?.liveSha256 === quickLiveSha) return json(res, 200, { ...saved.payload, cached: true, cacheKind: 'persistent-sha' });
      }
      let liveText, baselineText, baselineSource, installerText;
      try { liveText = await readLiveConfig(targetServer, binding.installRoot, path); }
      catch (e) { return json(res, 200, { error: 'SSH live-файл: ' + e.message }); }
      try { const loaded = await readVerifiedBackupConfig(targetServer, group, path, binding, liveText); baselineText = loaded.text; baselineSource = loaded.source; }
      catch (e) { return json(res, 200, { error: 'verified baseline: ' + e.message }); }
      try { installerText = await installerFileText(installerGitlabConfig(), binding.project, path, binding.ref); }
      catch (e) { return json(res, 200, { error: 'installer-файл недоступний: ' + e.message }); }
      const payload = { server: targetServer.name, group, path, format: 'text', fileApply: true, restartDeferred: true,
        project: binding.project, ref: binding.ref, baselineKind: baselineSource.kind, baselineId: baselineSource.id,
        liveSha256: sha256Text(liveText), serverMatchesBaseline: sha256Text(baselineText) === sha256Text(liveText), textDiff: yamlLineDiff(baselineText, installerText) };
      saveConfigPreviewCache(cacheParts, payload);
      return json(res, 200, payload);
    }
    if (url.pathname === '/api/reconcile') {
      // Two-way reconcile ОДНОГО конфіг-файлу: verified T0 backup ↔ installer (за ref). Dry-run.
      const targetServer = findServer(url.searchParams.get('server'));
      if (!targetServer) return json(res, 404, { error: 'сервер не знайдено' });
      const group = String(url.searchParams.get('group') || 'rscore');
      const path = String(url.searchParams.get('path') || '');
      const fmt = configFormat(path);
      if (!/^[A-Za-z0-9._][A-Za-z0-9._/-]*$/.test(path) || path.includes('..') || !fmt)
        return json(res, 400, { error: 'лише .json або .env, коректний шлях (yaml/envoy — окремо)' });
      const binding = resolveConfigBinding(targetServer, group);
      if (!binding) return json(res, 400, { error: 'для цієї групи нема ні зафіксованого installer, ні збереженого плану — сформуй план або зафіксуй installer' });
      const installRoot = binding.installRoot;
      const apiCacheKey = [targetServer.name, group, path, binding.project, binding.ref, installRoot].join('\n');
      if (url.searchParams.get('refresh') !== '1' && reconcileApiCache.has(apiCacheKey)) {
        return json(res, 200, { ...reconcileApiCache.get(apiCacheKey), cached: true });
      }
      let backupText, liveText, backupSource, installerText;
      try { liveText = await readLiveConfig(targetServer, installRoot, path); }
      catch (e) { return json(res, 200, { error: 'SSH live-файл: ' + e.message }); }
      try {
        const loaded = await readVerifiedBackupConfig(targetServer, group, path, binding, liveText);
        backupText = loaded.text; backupSource = loaded.source;
      } catch (e) { return json(res, 200, { error: 'verified baseline: ' + e.message }); }
      try { installerText = await installerFileText(installerGitlabConfig(), binding.project, path, binding.ref); }
      catch (e) { return json(res, 200, { error: 'installer-файл недоступний: ' + e.message }); }
      let backupObj, installerObj;
      try { backupObj = parseConfig(path, backupText); } catch (e) { return json(res, 200, { error: 'T0 backup: не вдалось розібрати ' + fmt.toUpperCase() + ' — ' + e.message }); }
      try { installerObj = parseConfig(path, installerText); } catch (e) { return json(res, 200, { error: 'installer: не вдалось розібрати ' + fmt.toUpperCase() + ' — ' + e.message }); }
      const result = reconcileConfig(backupObj, installerObj, {});
      const backupSha256 = sha256Text(backupText), liveSha256 = sha256Text(liveText);
      const serverMatchesBackup = backupSha256 === liveSha256;
      // Secret-файли (.env): показуємо СТРУКТУРУ (які ключі нові/зникли/змінились),
      // але значення маскуємо. Порожнє лишаємо видимим — це не секрет і корисно (затертий пароль).
      const masked = fmt === 'env';
      if (masked) {
        const mask = v => v === undefined ? undefined : (v === '' ? '(порожнє)' : '••••••');
        result.rows = result.rows.map(r => ({ ...r, backup: mask(r.backup), installer: mask(r.installer), target: mask(r.target), suggest: null }));
      }
      const payload = { server: targetServer.name, group, path, format: fmt, masked, project: binding.project, ref: binding.ref, installRoot,
        source: 'verified-baseline', baselineKind: backupSource.kind, baselineId: backupSource.id,
        backupPlanId: backupSource.id, backupCreatedAt: backupSource.createdAt,
        backupSha256, liveSha256, serverMatchesBackup, serverMatchesBaseline: serverMatchesBackup,
        ...result, textDiff: yamlLineDiff(backupText, installerText) };
      reconcileApiCache.set(apiCacheKey, payload);
      return json(res, 200, payload);
    }
    if (url.pathname === '/api/reconcile/target' && req.method === 'POST') {
      // Зібрати цільовий конфіг із рішень і повернути МАТЕРІАЛІЗОВАНИЙ текст (dry-run).
      // Нічого не застосовуємо й не пишемо на диск. Для secret — прев'ю з маскованими значеннями.
      const body = await readBody(req);
      const targetServer = findServer(body.server);
      if (!targetServer) return json(res, 404, { error: 'сервер не знайдено' });
      const group = String(body.group || 'rscore');
      const path = String(body.path || '');
      const fmt = configFormat(path);
      if (!/^[A-Za-z0-9._][A-Za-z0-9._/-]*$/.test(path) || path.includes('..') || !fmt) return json(res, 400, { error: 'некоректний шлях' });
      const binding = resolveConfigBinding(targetServer, group);
      if (!binding) return json(res, 400, { error: 'для цієї групи нема ні зафіксованого installer, ні збереженого плану' });
      let backupText, liveText, installerText;
      try { liveText = await readLiveConfig(targetServer, binding.installRoot, path); }
      catch (e) { return json(res, 200, { error: 'SSH live-файл: ' + e.message }); }
      try {
        backupText = (await readVerifiedBackupConfig(targetServer, group, path, binding, liveText)).text;
      } catch (e) { return json(res, 200, { error: 'verified baseline: ' + e.message }); }
      if (sha256Text(backupText) !== sha256Text(liveText)) {
        return json(res, 409, { error: 'live-файл змінився відносно T0 backup — target заблоковано; створи новий backup або окремо розбери drift' });
      }
      try { installerText = await installerFileText(installerGitlabConfig(), binding.project, path, binding.ref); }
      catch (e) { return json(res, 200, { error: 'installer-файл недоступний: ' + e.message }); }
      let backupObj, installerObj;
      try { backupObj = parseConfig(path, backupText); installerObj = parseConfig(path, installerText); }
      catch (e) { return json(res, 200, { error: 'parse: ' + e.message }); }
      const result = reconcileConfig(backupObj, installerObj, {});
      // Санітизація рішень: лише конфліктні ключі; значення 'server'|'installer'|{value}.
      const conflictKeys = new Set(result.rows.filter(r => !r.auto).map(r => r.key));
      const decisions = {};
      for (const [k, v] of Object.entries(body.decisions || {})) {
        if (!conflictKeys.has(k)) continue;
        if (v && typeof v === 'object' && 'value' in v) {
          const row = result.rows.find(item => item.key === k);
          try { decisions[k] = { value: coerceManualValue(v.value, row, fmt) }; }
          catch (e) { return json(res, 200, { ok: false, invalid: { key: k, message: e.message } }); }
        }
        else if (v === 'installer') decisions[k] = 'installer';
        else decisions[k] = 'backup';
      }
      const bt = buildTargetConfig(result, decisions);
      if (bt.unresolved.length) return json(res, 200, { ok: false, unresolved: bt.unresolved });
      const masked = fmt === 'env';
      let flat = bt.flat;
      if (masked) { const m = {}; for (const k of Object.keys(flat)) m[k] = (flat[k] === '' || flat[k] === undefined) ? '(порожнє)' : '••••••'; flat = m; }
      let text; try { text = materializeConfig(path, flat); } catch (e) { return json(res, 200, { error: 'materialize: ' + e.message }); }
      return json(res, 200, { ok: true, server: targetServer.name, group, path, format: fmt, masked, target: text, bytes: Buffer.byteLength(text, 'utf8') });
    }
    if (url.pathname === '/api/reconcile/prepare' && req.method === 'POST') {
      try {
        const context = await prepareConfigContext(await readBody(req));
        return json(res, 200, {
          ok: true, readOnly: true, prepareReady: Object.values(context.gates).every(Boolean), gates: context.gates,
          applyImplemented: true, server: context.targetServer.name, group: context.group, path: context.path,
          absolutePath: context.absolutePath, format: context.fmt, baselineKind: context.backupSource.kind,
          baselineId: context.backupSource.id, backupPlanId: context.backupSource.id,
          installer: { project: context.binding.project, ref: context.binding.ref }, hashes: context.hashes,
          bytes: Buffer.byteLength(context.targetText, 'utf8'), comments: context.comments,
          affectedContainers: [], fileOnly: true, restartDeferred: true, prerequisites: context.prerequisites,
        });
      } catch (e) {
        return json(res, 200, { ok: false, error: e.message, invalid: e.invalid, unresolved: e.unresolved });
      }
    }
    if (url.pathname === '/api/reconcile/file/batch/prepare' && req.method === 'POST') {
      try {
        const body = await readBody(req), debugForceWrite = body.debugForceWrite === true;
        const contexts = await prepareMergedFileBatch(body);
        const files = contexts.map(context => ({ path: context.path, format: context.format,
          ready: mergedContextReady(context) && (!debugForceWrite || context.gates.remoteToolsReady),
          changesFile: context.gates.targetDiffers, gates: context.gates, hashes: context.hashes,
          bytes: Buffer.byteLength(context.targetText, 'utf8'), prerequisites: context.prerequisites }));
        return json(res, 200, { ok: true, prepareReady: files.every(file => file.ready), fileOnly: true,
          restartDeferred: true, debugForceWrite, files, changeCount: files.filter(file => file.changesFile).length,
          unchangedCount: files.filter(file => !file.changesFile).length, writeCount: debugForceWrite ? files.length : files.filter(file => file.changesFile).length });
      } catch (e) { return json(res, 200, { ok: false, error: e.message, unresolved: e.unresolved }); }
    }
    if (url.pathname === '/api/reconcile/file/batch/latest' && req.method === 'GET') {
      const targetServer = findServer(url.searchParams.get('server'));
      if (!targetServer) return json(res, 404, { ok: false, error: 'сервер не знайдено' });
      const group = String(url.searchParams.get('group') || 'rscore'), batches = [];
      if (existsSync(CONFIG_TRANSACTIONS_DIR)) {
        for (const file of readdirSync(CONFIG_TRANSACTIONS_DIR).filter(name => name.endsWith('.json'))) {
          try {
            const value = JSON.parse(readFileSync(join(CONFIG_TRANSACTIONS_DIR, file), 'utf8'));
            if (['config-file-batch', 'config-file-debug-batch'].includes(value.kind) && value.server === targetServer.name && value.group === group && value.status === 'applied') batches.push(value);
          } catch { /* ignore damaged journal */ }
        }
      }
      batches.sort((a, b) => String(b.completedAt || b.createdAt || '').localeCompare(String(a.completedAt || a.createdAt || '')));
      for (const batch of batches) {
        const files = [];
        for (const row of batch.files || []) {
          try {
            const transaction = loadConfigTransaction(row.transactionId);
            if (isConfigApplyTransactionKind(transaction.kind) && ['applied', 'rollback-failed'].includes(transaction.status)) files.push({ path: transaction.path, transactionId: transaction.id, status: transaction.status });
          } catch { /* incomplete row is not rollbackable */ }
        }
        if (files.length) return json(res, 200, { ok: true, available: true, batchId: batch.id, debug: batch.kind === 'config-file-debug-batch', completedAt: batch.completedAt, files });
      }
      return json(res, 200, { ok: true, available: false });
    }
    if (url.pathname === '/api/reconcile/file/batch/apply' && req.method === 'POST') {
      const body = await readBody(req);
      const debugForceWrite = body.debugForceWrite === true;
      if (debugForceWrite && body.debugConfirmation !== 'REWRITE_ALL_MANAGED_FILES') {
        return json(res, 400, { ok: false, error: 'debug force-write потребує явного підтвердження' });
      }
      let contexts;
      try { contexts = await prepareMergedFileBatch(body); }
      catch (e) { return json(res, 200, { ok: false, error: e.message, unresolved: e.unresolved }); }
      const blocked = contexts.filter(context => !mergedContextReady(context) || (debugForceWrite && !context.gates.remoteToolsReady));
      if (blocked.length) return json(res, 409, { ok: false, error: 'пакет заблоковано preflight-перевірками',
        files: blocked.map(context => ({ path: context.path, gates: context.gates, prerequisites: context.prerequisites })) });
      const targets = debugForceWrite ? contexts : contexts.filter(context => context.gates.targetDiffers);
      if (!targets.length) return json(res, 200, { ok: true, status: 'no-changes', fileOnly: true, restartDeferred: true, applied: [], skipped: contexts.map(context => context.path) });
      const batchId = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 17) + '_batch_' + createHash('sha256').update(String(Date.now()) + Math.random()).digest('hex').slice(0, 8);
      const batch = { version: 1, id: batchId, kind: debugForceWrite ? 'config-file-debug-batch' : 'config-file-batch', debugForceWrite, status: 'applying', createdAt: new Date().toISOString(),
        server: targets[0].targetServer.name, group: targets[0].group, fileOnly: true, restartDeferred: true,
        files: targets.map(context => ({ path: context.path, status: 'pending' })) };
      saveConfigTransaction(batch);
      const applied = [];
      for (let index = 0; index < targets.length; index++) {
        const context = targets[index], id = batchId + '-' + String(index + 1), remote = transactionPaths(context.absolutePath, id);
        const transaction = { version: 2, id, batchId, kind: debugForceWrite ? 'config-file-debug-apply' : 'config-file-apply', debugForceWrite, forcedUnchanged: debugForceWrite && !context.gates.targetDiffers, format: context.format, status: 'applying', createdAt: new Date().toISOString(),
          server: context.targetServer.name, ssh: context.targetServer.ssh, group: context.group, path: context.path,
          installRoot: context.binding.installRoot, backupPlanId: context.baselineSource.id,
          installer: { project: context.binding.project, ref: context.binding.ref }, hashes: { before: context.hashes.live, target: context.hashes.target },
          remote, containers: [], writeMode: context.prerequisites.writeMode, decisions: redactMergeDecisions(context.decisions), restartDeferred: true };
        saveConfigTransaction(transaction);
        try {
          await remoteAtomicConfigWrite(context.targetServer, remote, id, context.targetText, context.hashes.target, context.hashes.live, context.prerequisites.writeMode, context.format);
          transaction.writtenAt = new Date().toISOString(); transaction.health = { ok: true, rows: [], fileOnly: true };
          transaction.status = 'applied'; transaction.completedAt = new Date().toISOString(); saveConfigTransaction(transaction);
          applied.push({ context, transaction }); batch.files[index].status = 'applied'; batch.files[index].transactionId = id; saveConfigTransaction(batch);
        } catch (applyError) {
          transaction.applyError = String(applyError.message || applyError).slice(0, 1000);
          await recoverFailedConfigApply(context, transaction);
          saveConfigTransaction(transaction); batch.files[index].status = transaction.status; batch.files[index].error = transaction.applyError;
          for (const item of [...applied].reverse()) {
            try { item.transaction.rollbackHealth = await remoteRollbackConfig(item.context.targetServer, item.transaction); item.transaction.status = 'rolled-back-automatically'; item.transaction.rolledBackAt = new Date().toISOString(); }
            catch (rollbackError) { item.transaction.status = 'rollback-failed'; item.transaction.rollbackError = String(rollbackError.message || rollbackError).slice(0, 1000); }
            saveConfigTransaction(item.transaction); const row = batch.files.find(file => file.transactionId === item.transaction.id); if (row) row.status = item.transaction.status;
          }
          batch.status = batch.files.some(file => file.status === 'rollback-failed') ? 'rollback-failed' : 'rolled-back-automatically';
          batch.error = transaction.applyError; batch.completedAt = new Date().toISOString(); saveConfigTransaction(batch); reconcileApiCache.clear();
          return json(res, 500, { ok: false, error: transaction.applyError, batchId, status: batch.status, files: batch.files });
        }
      }
      batch.status = 'applied'; batch.completedAt = new Date().toISOString(); saveConfigTransaction(batch); reconcileApiCache.clear();
      return json(res, 200, { ok: true, batchId, status: batch.status, fileOnly: true, restartDeferred: true,
        debugForceWrite,
        applied: applied.map(item => ({ path: item.context.path, transactionId: item.transaction.id, hashes: item.transaction.hashes })),
        skipped: debugForceWrite ? [] : contexts.filter(context => !context.gates.targetDiffers).map(context => context.path),
        forcedUnchangedCount: debugForceWrite ? contexts.filter(context => !context.gates.targetDiffers).length : 0 });
    }
    if (url.pathname === '/api/reconcile/file/prepare' && req.method === 'POST') {
      try {
        const context = await prepareMergedFileContext(await readBody(req));
        return json(res, 200, { ok: true, prepareReady: Object.values(context.gates).every(Boolean),
          gates: context.gates, server: context.targetServer.name, group: context.group, path: context.path,
          absolutePath: context.absolutePath, format: context.format, baselineKind: context.baselineSource.kind,
          baselineId: context.baselineSource.id, installer: { project: context.binding.project, ref: context.binding.ref },
          hashes: context.hashes, bytes: Buffer.byteLength(context.targetText, 'utf8'), hunkCount: context.hunkCount,
          fileOnly: true, restartDeferred: true, prerequisites: context.prerequisites });
      } catch (e) { return json(res, 200, { ok: false, error: e.message, unresolved: e.unresolved }); }
    }
    if (url.pathname === '/api/reconcile/file/apply' && req.method === 'POST') {
      const body = await readBody(req);
      let context;
      try { context = await prepareMergedFileContext(body); }
      catch (e) { return json(res, 200, { ok: false, error: e.message, unresolved: e.unresolved }); }
      if (!Object.values(context.gates).every(Boolean)) return json(res, 409, { ok: false, error: 'apply заблоковано preflight-перевірками', gates: context.gates });
      const id = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 17) + '_' + createHash('sha256').update(String(Date.now()) + Math.random()).digest('hex').slice(0, 8);
      const remote = transactionPaths(context.absolutePath, id);
      const transaction = { version: 2, id, kind: 'config-file-apply', format: context.format, status: 'applying', createdAt: new Date().toISOString(),
        server: context.targetServer.name, ssh: context.targetServer.ssh, group: context.group, path: context.path,
        installRoot: context.binding.installRoot, backupPlanId: context.baselineSource.id,
        installer: { project: context.binding.project, ref: context.binding.ref }, hashes: { before: context.hashes.live, target: context.hashes.target },
        remote, containers: [], writeMode: context.prerequisites.writeMode, decisions: redactMergeDecisions(context.decisions), restartDeferred: true };
      saveConfigTransaction(transaction);
      try {
        await remoteAtomicConfigWrite(context.targetServer, remote, id, context.targetText, context.hashes.target, context.hashes.live, context.prerequisites.writeMode, context.format);
        transaction.writtenAt = new Date().toISOString(); transaction.health = { ok: true, rows: [], fileOnly: true };
        transaction.status = 'applied'; transaction.completedAt = new Date().toISOString(); saveConfigTransaction(transaction); reconcileApiCache.clear();
        return json(res, 200, { ok: true, transactionId: id, status: transaction.status, hashes: transaction.hashes,
          fileOnly: true, restartDeferred: true, rollbackAvailable: true });
      } catch (applyError) {
        transaction.applyError = String(applyError.message || applyError).slice(0, 1000);
        await recoverFailedConfigApply(context, transaction);
        saveConfigTransaction(transaction); reconcileApiCache.clear();
        return json(res, 500, { ok: false, error: transaction.applyError, transactionId: id, status: transaction.status, rollbackError: transaction.rollbackError || null });
      }
    }
    if (url.pathname === '/api/reconcile/helper/status' && req.method === 'GET') {
      const targetServer = findServer(url.searchParams.get('server'));
      if (!targetServer) return json(res, 404, { ok: false, error: 'сервер не знайдено' });
      try {
        const group = String(url.searchParams.get('group') || 'rscore'), path = String(url.searchParams.get('path') || ''), binding = resolveConfigBinding(targetServer, group);
        if (!binding) throw new Error('нема зафіксованого installer binding');
        const absolutePath = transactionPaths(binding.installRoot.replace(/\/+$/, '') + '/' + path, 'permission-check').target;
        const result = await sshRun(targetServer.ssh, resolveSshSettings(targetServer).sshKey,
          [`sudo -n ${shellQuote(REMOTE_CONFIG_HELPER)} check ${shellQuote(absolutePath)}`], { timeout: 30000 });
        const helperOutput = String(result.stdout || '').trim(), helperParts = helperOutput.split(':'),
          helperVersion = helperParts.length >= 4 ? helperParts[1] : result.status === 0 ? 'legacy' : '';
        const ready = result.status === 0 && helperVersion === REMOTE_CONFIG_HELPER_VERSION;
        return json(res, 200, { ok: true, ready, server: targetServer.name, ssh: targetServer.ssh,
          validator: ready ? helperOutput : '', helperVersion, requiredVersion: REMOTE_CONFIG_HELPER_VERSION,
          outdated: result.status === 0 && !ready,
          reason: ready ? '' : result.status === 0 ? `helper застарів (${helperVersion || 'без версії'} → ${REMOTE_CONFIG_HELPER_VERSION})` : String(result.stderr || `exit ${result.status}`).trim().slice(0, 300) });
      } catch (e) { return json(res, 200, { ok: true, ready: false, reason: e.message }); }
    }
    if (url.pathname === '/api/reconcile/helper/stage' && req.method === 'POST') {
      const body = await readBody(req), targetServer = findServer(body.server);
      if (!targetServer) return json(res, 404, { ok: false, error: 'сервер не знайдено' });
      try {
        const staged = await stageRemoteConfigHelper(targetServer);
        return json(res, 200, { ok: true, server: targetServer.name, staged: staged.staged, command: staged.command,
          note: 'Helper підготовлено. Встановлення потребує одноразового sudo-пароля.' });
      } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
    }
    if (url.pathname === '/api/reconcile/helper/install' && req.method === 'POST') {
      const body = await readBody(req), targetServer = findServer(body.server);
      if (!targetServer) return json(res, 404, { ok: false, error: 'сервер не знайдено' });
      try {
        const group = String(body.group || 'rscore'), path = String(body.path || ''), binding = resolveConfigBinding(targetServer, group);
        if (!binding) throw new Error('нема зафіксованого installer binding');
        const absolutePath = transactionPaths(binding.installRoot.replace(/\/+$/, '') + '/' + path, 'permission-check').target;
        const password = body.password; body.password = '';
        const installed = await installRemoteConfigHelper(targetServer, password, absolutePath);
        return json(res, 200, { ok: true, server: targetServer.name, persistent: true, validator: installed.validator,
          note: 'Постійні вузькі права StandWatch встановлено й перевірено.' });
      } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
    }
    if (url.pathname === '/api/reconcile/apply' && req.method === 'POST') {
      const body = await readBody(req);
      let context;
      try { context = await prepareConfigContext(body); }
      catch (e) { return json(res, 200, { ok: false, error: e.message, invalid: e.invalid, unresolved: e.unresolved }); }
      if (!Object.values(context.gates).every(Boolean)) {
        return json(res, 409, { ok: false, error: 'apply заблоковано preflight-перевірками', gates: context.gates });
      }
      const id = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 17) + '_' + createHash('sha256').update(String(Date.now()) + Math.random()).digest('hex').slice(0, 8);
      const remote = transactionPaths(context.absolutePath, id);
      const containerNames = [];
      const transaction = {
        version: 2, id, kind: 'config-file-apply', format: 'json', status: 'applying', createdAt: new Date().toISOString(),
        server: context.targetServer.name, ssh: context.targetServer.ssh, group: context.group,
        path: context.path, installRoot: context.binding.installRoot, backupPlanId: context.backupSource.id,
        installer: { project: context.binding.project, ref: context.binding.ref },
        hashes: { before: context.hashes.live, target: context.hashes.target }, remote,
        containers: containerNames, writeMode: context.prerequisites.writeMode, decisions: redactDecisions(context.decisions),
      };
      saveConfigTransaction(transaction);
      try {
        await remoteAtomicConfigWrite(context.targetServer, remote, id, context.targetText, context.hashes.target, context.hashes.live, context.prerequisites.writeMode, 'json');
        transaction.writtenAt = new Date().toISOString();
        transaction.health = { ok: true, rows: [], fileOnly: true };
        transaction.status = 'applied'; transaction.completedAt = new Date().toISOString();
        saveConfigTransaction(transaction); reconcileApiCache.clear();
        return json(res, 200, { ok: true, transactionId: id, status: transaction.status, hashes: transaction.hashes,
          containers: [], fileOnly: true, restartDeferred: true, rollbackAvailable: true });
      } catch (applyError) {
        transaction.applyError = String(applyError.message || applyError).slice(0, 1000);
        await recoverFailedConfigApply(context, transaction);
        saveConfigTransaction(transaction); reconcileApiCache.clear();
        return json(res, 500, { ok: false, error: transaction.applyError, transactionId: id,
          status: transaction.status, rollbackError: transaction.rollbackError || null });
      }
    }
    if (url.pathname === '/api/reconcile/rollback' && req.method === 'POST') {
      const body = await readBody(req);
      let transaction;
      try { transaction = loadConfigTransaction(body.transactionId); }
      catch (e) { return json(res, 404, { ok: false, error: e.message }); }
      if (!isConfigApplyTransactionKind(transaction.kind) || !['applied', 'rollback-failed'].includes(transaction.status)) {
        return json(res, 409, { ok: false, error: 'ця транзакція не доступна для ручного rollback', status: transaction.status });
      }
      const targetServer = findServer(transaction.server);
      if (!targetServer || targetServer.ssh !== transaction.ssh) return json(res, 409, { ok: false, error: 'сервер транзакції змінився або видалений' });
      try {
        transaction.rollbackHealth = await remoteRollbackConfig(targetServer, transaction);
        transaction.status = 'rolled-back'; transaction.rolledBackAt = new Date().toISOString();
        saveConfigTransaction(transaction); reconcileApiCache.clear();
        return json(res, 200, { ok: true, transactionId: transaction.id, status: transaction.status,
          hash: transaction.hashes.before, containers: transaction.rollbackHealth.rows });
      } catch (e) {
        transaction.status = 'rollback-failed'; transaction.rollbackError = String(e.message || e).slice(0, 1000);
        saveConfigTransaction(transaction);
        return json(res, 500, { ok: false, error: transaction.rollbackError, transactionId: transaction.id, status: transaction.status });
      }
    }
    if (url.pathname === '/api/reveal') {
      // Reveal on-demand ОДНОГО ключа (для маскованих secret-значень). Значення не логуємо, не кешуємо.
      const targetServer = findServer(url.searchParams.get('server'));
      if (!targetServer) return json(res, 404, { error: 'сервер не знайдено' });
      const group = String(url.searchParams.get('group') || 'rscore');
      const path = String(url.searchParams.get('path') || '');
      const key = String(url.searchParams.get('key') || '');
      const side = url.searchParams.get('side') === 'installer' ? 'installer' : 'backup';
      const fmt = configFormat(path);
      if (!/^[A-Za-z0-9._][A-Za-z0-9._/-]*$/.test(path) || path.includes('..') || !fmt) return json(res, 400, { error: 'некоректний шлях' });
      if (!key) return json(res, 400, { error: 'потрібен key' });
      const binding = resolveConfigBinding(targetServer, group);
      if (!binding) return json(res, 400, { error: 'для цієї групи нема ні зафіксованого installer, ні збереженого плану' });
      const installRoot = binding.installRoot;
      let text;
      try {
        if (side === 'installer') text = await installerFileText(installerGitlabConfig(), binding.project, path, binding.ref);
        else { const liveText = await readLiveConfig(targetServer, installRoot, path); text = (await readVerifiedBackupConfig(targetServer, group, path, binding, liveText)).text; }
      } catch (e) { return json(res, 200, { error: (side === 'installer' ? 'installer: ' : 'T0 backup: ') + e.message }); }
      let flat;
      try { flat = flattenConfig(parseConfig(path, text)); } catch (e) { return json(res, 200, { error: 'parse: ' + e.message }); }
      const exists = Object.prototype.hasOwnProperty.call(flat, key);
      const value = exists ? flat[key] : undefined;
      console.log(`reveal ${side} ${targetServer.name} ${path} :: ${key} (значення не логуємо)`);
      return json(res, 200, { key, side, exists, value: exists ? (typeof value === 'string' ? value : JSON.stringify(value)) : null });
    }
    if (url.pathname === '/api/installer/compare-files' && req.method === 'POST') {
      const body = await readBody(req), targetServer = findServer(body.server);
      if (!targetServer) return json(res, 404, { error: 'сервер не знайдено' });
      const project = String(body.project || ''), ref = String(body.ref || '');
      const installRoot = String(body.installRoot || ('/usr/local/' + (body.group || ''))).replace(/\/+$/, '');
      if (!/^\/[A-Za-z0-9._/-]+$/.test(installRoot)) return json(res, 400, { error: 'некоректний installation root' });
      const snapshot = await installerSnapshot(installerGitlabConfig(), { project, ref, manifestRoot: body.manifestRoot || 'home' });
      const policyPrefix = targetServer.name + '|' + String(body.group || '') + '|' + project + '|';
      const policies = loadInstallerCatalog().filePolicies || {};
      const ignoredPaths = new Set(snapshot.managedFiles.map(value => value.path).filter(path => policies[policyPrefix + path] === 'ignored'));
      const expected = await installerComparableFileHashes(installerGitlabConfig(), {
        project, ref: snapshot.commit.id, paths: snapshot.managedFiles.map(value => value.path).filter(path => !ignoredPaths.has(path)),
      });
      const quoted = expected.map(value => `'${value.path.replace(/'/g, `'\\''`)}'`).join(' ');
      const remote = `cd '${installRoot}' 2>/dev/null && sha256sum -- ${quoted} 2>/dev/null || true`;
      const result = await sshRun(targetServer.ssh, resolveSshSettings(targetServer).sshKey, [remote], { timeout: 120000 });
      const actual = new Map();
      for (const line of String(result.stdout || '').split(/\r?\n/)) {
        const match = /^([0-9a-f]{64})\s+(.+)$/.exec(line.trim());
        if (match) actual.set(match[2].replace(/^\.\//, ''), match[1]);
      }
      const files = expected.map(value => ({ ...value, policy: policies[policyPrefix + value.path] || 'managed', actual: actual.get(value.path) || null,
        status: !actual.has(value.path) ? 'missing' : actual.get(value.path) === value.sha256 ? 'same' : 'different' }));
      for (const path of ignoredPaths) files.push({ path, policy: 'ignored', status: 'ignored', actual: null, sha256: null, size: null });
      files.sort((a, b) => a.path.localeCompare(b.path));
      return json(res, 200, {
        server: targetServer.name, project, ref: snapshot.commit.id, installRoot,
        counts: { compared: files.length, same: files.filter(x => x.status === 'same').length,
          different: files.filter(x => x.status === 'different').length, missing: files.filter(x => x.status === 'missing').length,
          ignored: snapshot.managedFiles.length - expected.length },
        files, ignoredNote: 'Ignored-файли не впливають на план; certificates, keys and binary assets are not byte-compared.',
        sshError: result.status && !result.stdout ? result.stderr : null,
      });
    }
    if (url.pathname === '/api/installer/preflight' && req.method === 'POST') {
      const body = await readBody(req), targetServer = findServer(body.server);
      if (!targetServer) return json(res, 404, { error: 'сервер не знайдено' });
      const group = String(body.group || '').trim();
      const installRoot = String(body.installRoot || ('/usr/local/' + group)).replace(/\/+$/, '');
      if (!/^[A-Za-z0-9_.-]+$/.test(group) || !/^\/[A-Za-z0-9._/-]+$/.test(installRoot) || installRoot.includes('..'))
        return json(res, 400, { error: 'некоректна група або installation root' });
      const remote = `root='${installRoot}'; group='${group}'; ` +
        `df -Pk "$root" 2>/dev/null | awk 'NR==2 {print "DISK\\t"$2"\\t"$3"\\t"$4"\\t"$6}'; ` +
        `for rel in home scripts volumes; do p="$root/$rel"; if [ -e "$p" ]; then kb=$(du -sk "$p" 2>/dev/null | awk '{print $1}'); printf 'DIR\\t%s\\t%s\\n' "$rel" "${'$'}{kb:-}"; else printf 'DIR\\t%s\\t\\n' "$rel"; fi; done; ` +
        `ids=$(docker ps -aq); [ -z "$ids" ] || docker inspect --format '{{.Name}}\t{{.Config.Image}}\t{{index .Config.Labels "com.docker.compose.project"}}\t{{index .Config.Labels "com.docker.compose.project.working_dir"}}\t{{json .Mounts}}' $ids`;
      const result = await sshRun(targetServer.ssh, resolveSshSettings(targetServer).sshKey, [remote], { timeout: 120000 });
      let disk = null; const directories = [], containers = [];
      for (const line of String(result.stdout || '').split(/\r?\n/)) {
        const parts = line.split('\t');
        if (parts[0] === 'DISK') disk = { totalKb: Number(parts[1]) || null, usedKb: Number(parts[2]) || null,
          freeKb: Number(parts[3]) || null, mount: parts[4] || null };
        else if (parts[0] === 'DIR') directories.push({ name: parts[1], exists: parts[2] !== '', sizeKb: Number(parts[2]) || null });
        else if (parts.length >= 5) {
          const composeGroup = parts[2] === '<no value>' ? null : parts[2], workingDir = parts[3] === '<no value>' ? null : parts[3];
          if (composeGroup !== group && workingDir !== installRoot && !workingDir?.startsWith(installRoot + '/')) continue;
          let mounts = []; try { mounts = JSON.parse(parts.slice(4).join('\t')) || []; } catch { /* keep empty */ }
          const name = parts[0].replace(/^\//, ''), image = parts[1];
          containers.push({ name, image, composeGroup, workingDir, databaseCandidate: /(?:postgres|mysql|mariadb|mongo(?:db)?|mssql|oracle)/i.test(name + ' ' + image),
            mounts: mounts.map(m => ({ type: m.Type, name: m.Name || null, source: m.Source || null, destination: m.Destination || null, rw: !!m.RW })) });
        }
      }
      const mounts = containers.flatMap(c => c.mounts.map(m => ({ container: c.name, ...m })))
        .filter((m, index, all) => all.findIndex(x => x.type === m.type && x.name === m.name && x.source === m.source && x.destination === m.destination) === index);
      return json(res, 200, { server: targetServer.name, group, installRoot, disk, directories, containers,
        databaseCandidates: containers.filter(c => c.databaseCandidate).map(c => ({ name: c.name, image: c.image, mounts: c.mounts })), mounts,
        readOnly: true, sshError: result.status && !result.stdout ? result.stderr : null });
    }
    if (url.pathname === '/api/installer/plan' && req.method !== 'POST') {
      const server = url.searchParams.get('server'), group = url.searchParams.get('group') || 'default';
      if (!findServer(server)) return json(res, 404, { error: 'сервер не знайдено' });
      return json(res, 200, latestInstallerPlan(server, group) || { id: null, plan: null, serverUnchanged: false, changedServices: [] });
    }
    if (url.pathname === '/api/installer/plan' && req.method === 'POST') {
      try {
        const saved = saveInstallerPlan(await readBody(req));
        return json(res, 200, { ok: true, id: saved.id, status: saved.plan.status, file: saved.file });
      } catch (error) { return json(res, 400, { ok: false, error: error.message }); }
    }
    if (url.pathname === '/api/installer/backup-status' && req.method !== 'POST') {
      const planId = String(url.searchParams.get('planId') || '');
      if (!/^[A-Za-z0-9_.-]+$/.test(planId)) return json(res, 400, { error: 'некоректний plan id' });
      const job = backupJobs.get(planId);
      if (job) return json(res, 200, job);
      try { const plan = JSON.parse(readFileSync(planFileById(planId), 'utf8')); return json(res, 200, { planId, status: plan.backup?.status || 'not-created', phase: 'idle', processedBytes: 0, totalBytes: 0, error: plan.backup?.error || null }); }
      catch { return json(res, 404, { error: 'план не знайдено' }); }
    }
    if (url.pathname === '/api/installer/backup' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const serverName = String(body.server || ''), group = String(body.group || ''), planId = String(body.planId || '');
        return json(res, 200, await createInstallerBackup({ serverName, group, planId }));
      } catch (error) { return json(res, 400, { ok: false, error: error.message }); }
    }
    if (url.pathname === '/api/installer/restore-test-status' && req.method !== 'POST') {
      const planId = String(url.searchParams.get('planId') || '');
      if (!/^[A-Za-z0-9_.-]+$/.test(planId)) return json(res, 400, { error: 'некоректний plan id' });
      const job = restoreTestJobs.get(planId); if (job) return json(res, 200, job);
      try { const plan = JSON.parse(readFileSync(planFileById(planId), 'utf8')); return json(res, 200, { planId, status: plan.restore?.status || 'not-tested', phase: 'idle', error: plan.restore?.error || null, result: plan.restore || null }); }
      catch { return json(res, 404, { error: 'план не знайдено' }); }
    }
    if (url.pathname === '/api/installer/restore-test' && req.method === 'POST') {
      try { const body = await readBody(req); return json(res, 200, await testInstallerRestore({ serverName: String(body.server || ''), group: String(body.group || ''), planId: String(body.planId || '') })); }
      catch (error) { return json(res, 400, { ok: false, error: error.message }); }
    }
    if (url.pathname === '/api/installer/binding' && req.method !== 'POST') {
      const server = findServer(url.searchParams.get('server'));
      if (!server) return json(res, 404, { error: 'сервер не знайдено' });
      const group = url.searchParams.get('group') || 'default';
      return json(res, 200, { server: server.name, group, binding: server.installerGroups?.[group] || { mode: 'manual' } });
    }
    if (url.pathname === '/api/installer/binding' && req.method === 'POST') {
      const body = await readBody(req);
      const cfg = loadServers();
      const server = cfg.servers.find(value => value.name === body.server);
      if (!server) return json(res, 404, { error: 'сервер не знайдено' });
      const group = String(body.group || 'default').trim(), mode = body.mode === 'installer' ? 'installer' : 'manual';
      server.installerGroups ||= {};
      if (mode === 'manual') {
        server.installerGroups[group] = { mode: 'manual', updatedAt: new Date().toISOString() };
      } else {
        const project = String(body.project || '').trim(), ref = String(body.ref || '').trim();
        if (!project || !ref) return json(res, 400, { error: 'installer project і ref обов’язкові' });
        const installRoot = String(body.installRoot || ('/usr/local/' + group)).replace(/\/+$/, '');
        if (!/^\/[A-Za-z0-9._/-]+$/.test(installRoot) || installRoot.includes('..')) return json(res, 400, { error: 'некоректна директорія installer на сервері' });
        const snapshot = await installerSnapshot(installerGitlabConfig(), {
          project, ref, manifestRoot: body.manifestRoot || 'home',
        });
        const scopeFiles = (Array.isArray(body.scopeFiles) ? body.scopeFiles : [])
          .map(value => String(value || '')).filter(value => snapshot.composeFiles.includes(value)).slice(0, 200);
        if (!scopeFiles.length) return json(res, 400, { error: 'обери хоча б один compose-файл для цієї Docker-групи' });
        server.installerGroups[group] = {
          mode, project, manifestRoot: body.manifestRoot || 'home', installRoot, sourceKind: body.sourceKind === 'branch' ? 'branch' : 'tag',
          sourceName: body.sourceName || ref, ref: snapshot.commit.id, commit: snapshot.commit,
          checksum: snapshot.checksum, serviceCount: snapshot.services.filter(value => scopeFiles.includes(value.sourceFile)).length,
          scopeFiles, fileGroups: snapshot.fileGroups,
          updatedAt: new Date().toISOString(),
        };
      }
      saveServers(cfg);
      return json(res, 200, { ok: true, binding: server.installerGroups[group] });
    }
    if (url.pathname === '/api/rename-server' && req.method === 'POST') {
      const b = await readBody(req);
      const oldN = (b.oldName || '').trim(), newN = (b.newName || '').trim();
      if (!oldN || !newN) return json(res, 400, { error: 'потрібні обидві назви' });
      const cfg = loadServers();
      const s = cfg.servers.find(x => x.name === oldN);
      if (!s) return json(res, 400, { error: 'сервер не знайдено' });
      if (cfg.servers.some(x => x.name === newN)) return json(res, 400, { error: 'така назва вже є' });
      const catalog = loadInstallerCatalog();
      s.name = newN;
      if (cfg.default === oldN) cfg.default = newN;
      saveServers(cfg);
      if (catalog.serverProjects[oldN]) { catalog.serverProjects[newN] = catalog.serverProjects[oldN]; delete catalog.serverProjects[oldN]; }
      for (const key of Object.keys(catalog.installRoots)) if (key.startsWith(oldN + '|')) { catalog.installRoots[newN + key.slice(oldN.length)] = catalog.installRoots[key]; delete catalog.installRoots[key]; }
      saveInstallerCatalog(catalog);
      try { const o = cacheFile(oldN), n = cacheFile(newN); if (existsSync(o)) renameSync(o, n); } catch { /* кеш не критичний */ }
      return json(res, 200, { ok: true, name: newN });
    }
    if (url.pathname === '/api/edit-server' && req.method === 'POST') {
      const b = await readBody(req);
      const cur = (b.name || '').trim();
      const host = (b.host || '').trim();
      const cfg = loadServers();
      const s = cfg.servers.find(x => x.name === cur);
      if (!s) return json(res, 400, { error: 'сервер не знайдено' });
      if (!host) return json(res, 400, { error: 'потрібен хост (IP)' });
      const settings = resolveSshSettings(s);
      const user = (b.user || settings.sshUser).trim();
      if (!user) return json(res, 400, { error: 'потрібен SSH-юзер' });
      const ssh = `${user}@${host}`;
      const sshKey = settings.sshKey;
      if (!sshKey || !existsSync(sshKey)) return json(res, 200, { ok: false, error: `Не знайдено ключ StandWatch: ${sshKey || '(не задано)'}. Вкажи в налаштуваннях ⚙.` });
      // Без успішного SSH новим адресом нічого не зберігаємо (не робимо «мертвий» сервер).
      const test = await sshInspect(ssh, sshKey);
      if (test.error) return json(res, 200, { ok: false, error: test.error });
      // Опційне перейменування — спершу, з міграцією кеш-ключів і каталогу (як у rename-server).
      const newN = (b.newName || '').trim();
      if (newN && newN !== cur) {
        if (cfg.servers.some(x => x.name === newN)) return json(res, 400, { error: 'така назва вже є' });
        const catalog = loadInstallerCatalog();
        s.name = newN;
        if (cfg.default === cur) cfg.default = newN;
        if (catalog.serverProjects[cur]) { catalog.serverProjects[newN] = catalog.serverProjects[cur]; delete catalog.serverProjects[cur]; }
        for (const key of Object.keys(catalog.installRoots)) if (key.startsWith(cur + '|')) { catalog.installRoots[newN + key.slice(cur.length)] = catalog.installRoots[key]; delete catalog.installRoots[key]; }
        saveInstallerCatalog(catalog);
        try { const o = cacheFile(cur), n = cacheFile(newN); if (existsSync(o)) renameSync(o, n); } catch { /* кеш не критичний */ }
      }
      // Ім'я те саме → ключ кешу не змінюється, старий скан лишається валідним до наступного «Сканувати».
      s.standUrl = `https://${host}`;
      s.ssh = ssh;
      saveServers(cfg);
      return json(res, 200, { ok: true, name: s.name, renamedFrom: (newN && newN !== cur) ? cur : null, containers: test.containers.length });
    }
    if (url.pathname === '/api/delete-server' && req.method === 'POST') {
      const b = await readBody(req);
      const nm = (b.name || '').trim();
      const cfg = loadServers();
      const catalog = loadInstallerCatalog();
      cfg.servers = cfg.servers.filter(x => x.name !== nm);
      if (cfg.default === nm) cfg.default = null;
      saveServers(cfg);
      delete catalog.serverProjects[nm]; for (const key of Object.keys(catalog.installRoots)) if (key.startsWith(nm + '|')) delete catalog.installRoots[key]; saveInstallerCatalog(catalog);
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/overview') {
      const out = loadServers().servers.map(s => {
        const c = loadCache(s.name);
        const rows = (c && c.data && c.data.rows) || [];
        let ok = 0, upd = 0, down = 0, nv = 0, unb = 0;
        for (const r of rows) {
          const dep = r.deployed || {};
          if (dep.state && dep.state !== 'running') down++;
          else if (r.verdict.code >= 10) upd++; else ok++;
          if (r.newerVersion) nv++;
          if (r.unbuilt && !r.unbuilt.error && r.unbuilt.count > 0) unb++;
        }
        return { name: s.name, standUrl: s.standUrl, savedAt: (c && c.savedAt) || null, total: rows.length, ok, upd, down, nv, unb };
      });
      return json(res, 200, out);
    }
    if (url.pathname === '/api/scan') {
      const name = url.searchParams.get('server');
      const server = findServer(name); // null → дефолт з .env
      const resolved = server ? { ...server, sshKey: resolveSshSettings(server).sshKey } : null;
      const data = await collect({ withBranches: url.searchParams.get('branches') !== '0', server: resolved });
      saveCache(name, data);
      return json(res, 200, data);
    }
    if (url.pathname === '/api/bootstrap-command' && req.method === 'POST') {
      const body = await readBody(req);
      const settings = resolveSshSettings();
      const host = (body.host || '').trim();
      const user = (body.user || settings.sshUser).trim();
      const sshKey = (body.sshKey || settings.sshKey || '').trim();
      const bootstrapKey = (body.bootstrapKey || settings.bootstrapKey || '').trim();
      if (!host || !user) return json(res, 400, { ok: false, error: 'Вкажи хост і SSH-юзера.' });
      if (!sshKey) return json(res, 400, { ok: false, error: 'Спочатку вкажи SSH-ключ StandWatch у налаштуваннях ⚙.' });
      if (!existsSync(sshKey)) return json(res, 400, { ok: false, error: `Не знайдено приватний ключ: ${sshKey}` });
      if (!existsSync(sshKey + '.pub')) return json(res, 400, { ok: false, error: `Не знайдено public key: ${sshKey}.pub` });
      if (!bootstrapKey || !existsSync(bootstrapKey)) return json(res, 400, { ok: false, error: `Не знайдено діючий ключ першого входу: ${bootstrapKey || '(не задано)'}` });
      return json(res, 200, { ok: true, sshKey, bootstrapKey,
        command: keyInstallCommand(`${user}@${host}`, sshKey, bootstrapKey) });
    }
    if (url.pathname === '/api/add-server' && req.method === 'POST') {
      const body = await readBody(req);
      const name = (body.name || '').trim();
      const host = (body.host || '').trim();
      const settings = resolveSshSettings();
      const user = (body.user || settings.sshUser).trim();
      if (!name || !host) return json(res, 400, { error: 'потрібні name і host' });
      const ssh = `${user}@${host}`;
      const cfg = loadServers();
      const existing = cfg.servers.find(s => s.name === name);
      if (existing) {
        const sameHost = existing.standUrl === `https://${host}` || existing.ssh === ssh;
        if (sameHost) return json(res, 200, { ok: true, exists: true, added: existing.name, containers: null });
        return json(res, 409, { ok: false, conflict: true,
          error: `Назва «${name}» вже належить іншому серверу (${existing.standUrl || existing.ssh}).` });
      }
      const sshKey = (body.sshKey || settings.sshKey || '').trim();
      const bootstrapKey = (body.bootstrapKey || settings.bootstrapKey || '').trim();
      if (!sshKey) return json(res, 200, { ok: false, error: 'Спочатку вкажи SSH-ключ StandWatch у налаштуваннях ⚙.' });
      if (!existsSync(sshKey)) return json(res, 200, { ok: false, error: `Не знайдено приватний ключ: ${sshKey}` });
      if (!existsSync(sshKey + '.pub')) return json(res, 200, { ok: false, error: `Не знайдено public key: ${sshKey}.pub` });
      if (!bootstrapKey || !existsSync(bootstrapKey)) return json(res, 200, { ok: false, error: `Не знайдено діючий ключ першого входу: ${bootstrapKey || '(не задано)'}` });
      // Спершу перевіряємо цільовий ключ StandWatch. Якщо його ще нема на сервері,
      // повертаємо готову команду з явно обраним діючим bootstrap-ключем.
      const test = await sshInspect(ssh, sshKey);
      if (test.error) {
        return json(res, 200, { ok: false, needKey: true, ssh,
          sshKey, bootstrapKey, command: keyInstallCommand(ssh, sshKey, bootstrapKey), error: test.error });
      }
      const sudoPassword = body.sudoPassword; body.sudoPassword = '';
      if (typeof sudoPassword !== 'string' || !sudoPassword) {
        return json(res, 200, { ok: false, needSudo: true,
          error: `SSH і ${test.containers.length} контейнерів перевірено. Введи sudo-пароль, щоб завершити системне налаштування сервера.` });
      }
      try {
        await installRemoteConfigHelper({ name, ssh, sshKey }, sudoPassword, null);
      } catch (e) {
        return json(res, 200, { ok: false, needSudo: true,
          error: `SSH і ${test.containers.length} контейнерів перевірено, але системне налаштування не завершено: ${e.message}` });
      }
      cfg.defaults = { ...(cfg.defaults || {}), sshUser: user, sshKey: settings.sshKey || sshKey,
        bootstrapKey: settings.bootstrapKey || bootstrapKey };
      cfg.servers.push({ name, standUrl: `https://${host}`, ssh,
        ...(sshKey !== cfg.defaults.sshKey ? { sshKey } : {}) });
      saveServers(cfg);
      return json(res, 200, { ok: true, added: name, containers: test.containers.length, systemReady: true });
    }
    if (url.pathname === '/api/branches') {
      const image = url.searchParams.get('image');
      return json(res, 200, await listBranches(image));
    }
    if (url.pathname === '/api/deploy-command') {
      const image = url.searchParams.get('image'), tag = url.searchParams.get('tag'), project = url.searchParams.get('project') || '';
      if (!IMG_RE.test(image || '') || !TAG_RE.test(tag || '')) return json(res, 400, { error: 'bad image/tag' });
      return json(res, 200, { image, tag, project, canExecute: YML_PROJECTS.has(project), command: deployCommand(project, image, tag) });
    }
    if (url.pathname === '/api/deploy-wrapper') {
      const user = (url.searchParams.get('user') || 'akirpichnikov').replace(/[^\w.@-]/g, '') || 'akirpichnikov';
      const block = [
        "base64 -d > /usr/local/bin/deploy-svc.sh <<'B64'",
        DEPLOY_SVC_B64,
        'B64',
        'chmod 755 /usr/local/bin/deploy-svc.sh && chown root:root /usr/local/bin/deploy-svc.sh',
        `echo '${user} ALL=(root) NOPASSWD: /usr/local/bin/deploy-svc.sh' > /etc/sudoers.d/deploy-svc && chmod 440 /etc/sudoers.d/deploy-svc`,
      ].join('\n');
      return json(res, 200, { user, command: block });
    }
    if (url.pathname === '/api/deploy' && req.method === 'POST') {
      const b = await readBody(req);
      const server = findServer(b.server);
      const project = (b.project || '').trim(), image = (b.image || '').trim(), tag = (b.tag || '').trim();
      if (!server) return json(res, 400, { error: 'невідомий сервер' });
      if (!YML_PROJECTS.has(project)) return json(res, 400, { error: `деплой для «${project}» не налаштований` });
      if (!IMG_RE.test(image) || !TAG_RE.test(tag)) return json(res, 400, { error: 'некоректні image/tag' });
      const r = await sshExec(server, `sudo -n /usr/local/bin/deploy-svc.sh ${project} ${image} ${tag}`);
      const okDeploy = r.code === 0;
      const needSetup = /sudo:|a password is required|command not found|no such file/i.test(r.err);
      return json(res, 200, { ok: okDeploy, code: r.code, out: r.out, err: r.err, needSetup });
    }
    res.writeHead(404); res.end('not found');
  } catch (e) {
    json(res, 500, { error: String(e.message || e) });
  }
});

// ── Автоскан: у фоні тихо оновлює кеш усіх серверів ──────────────────────────
// Період — AUTOSCAN_MINUTES (env), дефолт 15. 0 = вимкнено.
const AUTOSCAN_MIN = process.env.AUTOSCAN_MINUTES != null ? +process.env.AUTOSCAN_MINUTES : 15;
let autoscanBusy = false;
async function autoscanAll() {
  if (autoscanBusy) return;
  autoscanBusy = true;
  try {
    for (const s of loadServers().servers) {
      try {
        const data = await collect({ withBranches: true, server: s });
        saveCache(s.name, data);
        const bad = data.rows.filter(r => r.verdict.code >= 10 || (r.deployed?.state && r.deployed.state !== 'running')).length;
        console.log(`  [autoscan ${new Date().toLocaleTimeString()}] ${s.name}: ${data.rows.length} сервісів, проблемних ${bad}`);
      } catch (e) { console.log(`  [autoscan] ${s.name}: помилка — ${e.message}`); }
    }
  } finally { autoscanBusy = false; }
}

// Відкрити панель у окремому вікні-застосунку (Edge/Chrome --app), відв'язано.
function openAppWindow() {
  if (process.argv.includes('--no-open') || process.env.NO_OPEN === '1') return;
  const target = `http://${HOST}:${PORT}`;
  try {
    if (process.platform === 'win32') {
      const bins = [
        'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
        'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
        'C:/Program Files/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
      ];
      const bin = bins.find(p => existsSync(p));
      if (bin) {
        const profile = join(DATA_DIR, 'window-profile');
        try { mkdirSync(profile, { recursive: true }); } catch {}
        const launch = () => {
          try {
            const ch = spawn(bin, [
              `--app=${target}`,
              `--user-data-dir=${profile}`,
              '--window-size=1320,880',
              '--no-first-run',
              '--no-default-browser-check',
              '--disable-background-mode',
              '--disable-extensions',
              '--disable-gpu',
              '--disable-features=msEdgeStartupBoost',
            ], { detached: true, stdio: 'ignore', windowsHide: true });
            if (ch.pid) launchedBrowserPids.add(ch.pid);
            ch.unref(); // не тримаємо exe прив'язаним до вікна
          } catch { /* адреса лишається доступною */ }
        };
        const hitsBefore = pageHits;
        launch();
        // Повторити один раз, якщо Edge не завантажив сторінку. Це покриває і свіжий,
        // і пошкоджений/завислий профіль, а не лише перший запуск.
        setTimeout(() => { if (pageHits === hitsBefore) launch(); }, 3000);
      } else spawnSync('cmd', ['/c', 'start', '', target], { stdio: 'ignore', windowsHide: true });
    } else if (process.platform === 'darwin') spawnSync('open', [target], { stdio: 'ignore' });
    else spawnSync('xdg-open', [target], { stdio: 'ignore' });
  } catch { /* адреса лишається доступною */ }
}

server.on('error', async (e) => {
  if (e.code === 'EADDRINUSE') {
    // Порт зайнятий. Якщо це НАША жива копія цієї теки (двічі клікнули по exe) —
    // лише показати її вікно (без дубля) і вийти, а не піднімати другий сервер.
    if (await liveOursAt(PORT)) { focusExisting(PORT); return; }
    // чужий сервер (інша тека/застосунок) → наступний вільний порт, працюємо самостійно.
    if (PORT - BASE_PORT < 20) {
      PORT++;
      setTimeout(() => { try { server.listen(PORT, HOST); } catch {} }, 120);
      return;
    }
    console.error(`Порти ${BASE_PORT}–${PORT} зайняті — не можу стартувати.`); process.exit(1);
  }
  console.error('Помилка сервера:', e.message); process.exit(1);
});
// ── Single-instance замок на теку даних (щоб не плодити зависші інстанси) ─────
const LOCK_PATH = join(DATA_DIR, 'standwatch.lock');
const WINDOW_DEBOUNCE = 750; // захист лише від другого процесу одного double-click
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
// Чи це ЖИВА наша копія саме цієї теки: процес живий + відповідає /api/ping + той самий dataDir.
async function liveOursAt(port) {
  try {
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 1200);
    const r = await fetch(`http://${HOST}:${port}/api/ping`, { signal: ac.signal }).finally(() => clearTimeout(t));
    if (!r.ok) return false;
    const j = await r.json();
    return j && j.app === 'standwatch' && j.dataDir === DATA_DIR;
  } catch { return false; }
}
function writeLock() { try { writeFileSync(LOCK_PATH, JSON.stringify({ pid: process.pid, port: PORT, startedAt: Date.now(), windowAt: Date.now() })); } catch {} }
function stampWindow() { try { const l = JSON.parse(readFileSync(LOCK_PATH, 'utf8')); l.windowAt = Date.now(); writeFileSync(LOCK_PATH, JSON.stringify(l)); } catch {} }
function clearWindowStamp() { try { const l = JSON.parse(readFileSync(LOCK_PATH, 'utf8')); l.windowAt = 0; writeFileSync(LOCK_PATH, JSON.stringify(l)); } catch {} }
// Попросити ЖИВИЙ основний інстанс відкрити вікно. Так Edge належить серверу,
// а не короткоживучому helper-процесу другого запуску.
async function focusExisting(port) {
  PORT = port;
  let recent = false;
  try { const l = JSON.parse(readFileSync(LOCK_PATH, 'utf8')); if (l.windowAt && Date.now() - l.windowAt < WINDOW_DEBOUNCE) recent = true; } catch {}
  if (recent) { console.log(`  Уже запущено на :${port}, вікно щойно відкрито — не дублюю. Виходжу.`); return process.exit(0); }
  console.log(`  Уже запущено для цієї теки на :${port} — відкриваю вікно, виходжу.`);
  try {
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 2500);
    await fetch(`http://${HOST}:${port}/api/open-window`, { method: 'POST', signal: ac.signal }).finally(() => clearTimeout(t));
  } catch {}
  process.exit(0);
}
function clearLock() { try { const l = JSON.parse(readFileSync(LOCK_PATH, 'utf8')); if (l.pid === process.pid) unlinkSync(LOCK_PATH); } catch {} }
function stopLaunchedBrowsers() {
  if (process.platform !== 'win32') return;
  for (const pid of launchedBrowserPids) {
    try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch {}
  }
  launchedBrowserPids.clear();
}
let shuttingDown = false;
function shutdownApp() {
  if (shuttingDown) return;
  shuttingDown = true;
  stopLaunchedBrowsers();
  clearLock();
  process.exit(0);
}
process.on('exit', () => { stopLaunchedBrowsers(); clearLock(); });
process.on('SIGINT', shutdownApp);
process.on('SIGTERM', shutdownApp);
// Захисна сітка: недоступний сервер / збій скану не має валити всю панель (Node виходить на unhandled).
process.on('unhandledRejection', (reason) => { console.error('unhandledRejection:', reason && reason.message || reason); });
process.on('uncaughtException', (err) => { console.error('uncaughtException:', err && err.message || err); });

function onListening() {
  writeLock();
  console.log(`\n  StandWatch — моніторинг версій стендів → http://${HOST}:${PORT}\n`);
  console.log(`  Токени: GitLab ${CFG.token ? '✓' : '✗'}, TeamCity ${process.env.TEAMCITY_TOKEN ? '✓' : '✗'}`);
  console.log(`  Автоскан: ${AUTOSCAN_MIN > 0 ? 'кожні ' + AUTOSCAN_MIN + ' хв' : 'вимкнено'}`);
  console.log('  Зупинити: кнопка «✕ Вийти» в панелі, або Ctrl+C.\n');
  openAppWindow(); // окреме вікно-застосунок (Edge/Chrome --app), відв'язано
  if (AUTOSCAN_MIN > 0) {
    setTimeout(autoscanAll, 3000);                          // перший — невдовзі після старту
    setInterval(autoscanAll, AUTOSCAN_MIN * 60 * 1000);     // далі — за розкладом
  }
}
server.on('listening', onListening);

(async () => {
  // Якщо для ЦІЄЇ теки вже крутиться жива копія — не піднімаємо другий сервер,
  // а лише відкриваємо її вікно й виходимо (так само як подвійний клік «сфокусує»).
  if (existsSync(LOCK_PATH)) {
    let lock = null; try { lock = JSON.parse(readFileSync(LOCK_PATH, 'utf8')); } catch {}
    if (lock && lock.pid && lock.port && pidAlive(lock.pid) && await liveOursAt(lock.port)) {
      return focusExisting(lock.port);        // жива копія цієї теки — показати її вікно й вийти
    }
    try { unlinkSync(LOCK_PATH); } catch {}   // застарілий lock (процес мертвий) — прибрати
  }
  server.listen(PORT, HOST);
})();

// ── Дашборд (усе inline, залежностей нема) ───────────────────────────────────
const PAGE = /* html */ `<!doctype html><html lang="uk"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>StandWatch · версії стендів</title>
<style>
  :root{--bg:#f6f8fb;--fg:#0f172a;--mut:#64748b;--bd:#e2e8f0;--card:#fff;--ok:#16a34a;--warn:#d97706;--bad:#dc2626;--acc:#2563eb}
  @media(prefers-color-scheme:dark){:root{--bg:#0b1120;--fg:#e2e8f0;--mut:#94a3b8;--bd:#1e293b;--card:#111a2e;--ok:#22c55e;--warn:#f59e0b;--bad:#ef4444;--acc:#3b82f6}}
  *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,Segoe UI,sans-serif}
  header{position:sticky;top:0;background:var(--card);border-bottom:1px solid var(--bd);padding:12px 20px;display:flex;gap:14px;align-items:center;flex-wrap:wrap;z-index:5}
  header h1{font-size:16px;margin:0;font-weight:600} .grow{flex:1}
  button{font:inherit;padding:7px 14px;border:1px solid var(--bd);background:var(--acc);color:#fff;border-radius:7px;cursor:pointer}
  button.ghost{background:transparent;color:var(--fg)} button:disabled{opacity:.5;cursor:default}
  label.sw{display:flex;gap:6px;align-items:center;color:var(--mut);cursor:pointer} select{font:inherit;padding:6px 8px;border:1px solid var(--bd);border-radius:6px;background:var(--card);color:var(--fg)}
  main{padding:12px;max-width:1600px;margin:0 auto}
  #sum{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 10px;font-size:12px}
  #sum .pill{padding:3px 10px;border-radius:12px;border:1px solid var(--bd);font-weight:600}
  #sum .pill.bad{color:var(--bad)} #sum .pill.warn{color:var(--warn)} #sum .pill.ok{color:var(--ok)} #sum .pill.na{color:var(--mut)}
  #grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:8px;align-items:start}
  #ovgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:10px}
  .ovcard{background:var(--card);border:1px solid var(--bd);border-left-width:4px;border-radius:10px;padding:12px 14px;cursor:pointer}
  .ovcard:hover{border-color:var(--acc)} .ovcard.ok{border-left-color:var(--ok)} .ovcard.warn{border-left-color:var(--warn)} .ovcard.bad{border-left-color:var(--bad)}
  .ovcard h2{margin:0 0 8px;font-size:15px;display:flex;align-items:center;gap:6px} .ovpills{display:flex;gap:6px;flex-wrap:wrap}
  .ovact{margin-left:auto;display:flex;gap:2px} .ovact button{background:transparent;border:0;color:var(--mut);padding:2px 5px;font-size:13px;cursor:pointer;border-radius:4px}
  .ovact button:hover{background:color-mix(in srgb,var(--mut) 20%,transparent);color:var(--fg)}
  .proj-h{grid-column:1/-1;margin:8px 0 0;padding:4px 2px;font-size:13px;font-weight:700;border-bottom:2px solid var(--acc);color:var(--acc)}
  .card{background:var(--card);border:1px solid var(--bd);border-left-width:3px;border-radius:8px;padding:9px 11px}
  .card.ok{border-left-color:var(--ok)} .card.warn{border-left-color:var(--warn)} .card.bad{border-left-color:var(--bad)} .card.na{border-left-color:var(--mut)}
  .card h2{margin:0;font-size:13px;display:flex;gap:6px;align-items:center;flex-wrap:wrap;cursor:pointer}
  .card h2 .mk{font-size:13px} .card h2 .nm{font-weight:600}
  .tag{font-size:10px;font-weight:600;background:color-mix(in srgb,var(--acc) 18%,transparent);color:var(--acc);padding:1px 6px;border-radius:8px}
  .verdict{font-size:11.5px;margin:3px 0 0;color:var(--mut)}
  .verdict.ok{color:var(--ok)} .verdict.warn{color:var(--warn)} .verdict.bad{color:var(--bad)}
  .det{margin-top:7px;border-top:1px solid var(--bd);padding-top:6px}
  table{width:100%;border-collapse:collapse;font-size:11.5px} th{text-align:left;color:var(--mut);font-weight:500;width:120px;vertical-align:top;padding:2px 8px 2px 0;white-space:nowrap}
  td{padding:2px 0} code{background:color-mix(in srgb,var(--mut) 22%,transparent);padding:0 4px;border-radius:3px;font-size:11px}
  .st{font-weight:600} .st.SUCCESS{color:var(--ok)} .st.FAILURE,.st.ERROR{color:var(--bad)} a{color:var(--acc)}
  .switch{margin-top:8px;border-top:1px dashed var(--bd);padding-top:7px;display:flex;gap:6px;align-items:center;flex-wrap:wrap}
  select.pick{max-width:190px}
  pre{background:#0a0f1d;color:#d7e0f5;border-radius:6px;padding:10px;overflow:auto;font-size:11px;margin:8px 0 0;white-space:pre;max-width:100%}
  .muted{color:var(--mut)} .drift{color:var(--warn);font-weight:600}
  .warnh{color:var(--warn)!important}
  .ubbadge{font-size:10px;font-weight:700;background:color-mix(in srgb,var(--warn) 22%,transparent);color:var(--warn);padding:1px 6px;border-radius:8px}
  .cmts{margin-top:3px} .cmt{font-size:11px;color:var(--mut);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .ublinks{margin-top:5px;font-size:12px;font-weight:600}
  #meta{color:var(--mut);font-size:12px} .spin{opacity:.55}
  .card.collapsed .det,.card.collapsed .switch,.card.collapsed .cmd{display:none}
  .srv{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
  .srv select{width:230px;max-width:25vw}.srv button{background:transparent;color:var(--fg);border:1px dashed var(--bd);padding:6px 10px;white-space:nowrap}.srv button:hover{border-color:var(--acc);color:var(--acc)}
  dialog{border:1px solid var(--bd);border-radius:12px;background:var(--card);color:var(--fg);padding:0;max-width:520px;width:92%}
  dialog#reconcileDlg{max-width:min(980px,94vw);width:min(980px,94vw)}
  dialog#yamlDlg{max-width:min(1040px,94vw);width:min(1040px,94vw)}dialog#yamlDiffDlg{max-width:98vw;width:98vw;height:94vh;max-height:94vh}#yamlDiffDlg .dlg{height:100%;display:flex;flex-direction:column;padding:12px 14px}.yaml-row{display:grid;grid-template-columns:minmax(260px,1fr) minmax(120px,.65fr) 24px minmax(120px,.65fr);gap:7px;align-items:start;padding:6px 8px;border-bottom:1px solid var(--bd);font-size:12px}.yaml-row.changed{background:color-mix(in srgb,var(--warn) 7%,transparent)}.yaml-row code{white-space:pre-wrap;overflow-wrap:anywhere}.yaml-important{display:inline-flex;margin-left:6px;padding:1px 6px;border-radius:9px;background:color-mix(in srgb,var(--acc) 18%,transparent);color:var(--acc);font:10px/1.5 system-ui}.yaml-diff{max-height:65vh;overflow:auto;border:1px solid var(--bd);border-radius:7px;background:var(--bg);font:12px/1.55 ui-monospace,monospace}.yaml-line{display:block;padding:0 8px;white-space:pre-wrap;overflow-wrap:anywhere;border-left:3px solid transparent}.yaml-line.add{background:color-mix(in srgb,var(--ok) 14%,transparent);border-left-color:var(--ok)}.yaml-line.remove{background:color-mix(in srgb,var(--bad) 14%,transparent);border-left-color:var(--bad)}.yaml-loading{border:1px solid var(--bd);border-radius:8px;padding:12px;background:var(--card)}.yaml-loading progress{display:block;width:100%;height:14px;margin:9px 0;accent-color:var(--acc)}
  .merge-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px;border:1px solid var(--bd);border-radius:8px 8px 0 0;background:var(--card)}.merge-toolbar button{padding:5px 10px}.merge-toolbar .merge-stat{font-weight:700}.merge-head,.merge-row{display:grid;grid-template-columns:48px minmax(390px,1fr) 164px 48px minmax(390px,1fr);min-width:1070px}.merge-head{background:var(--bg);border:1px solid var(--bd);border-top:0;font-size:12px;font-weight:700}.merge-head>div{padding:6px 8px;border-right:1px solid var(--bd)}.merge-scroll{flex:1;min-height:240px;overflow:auto;border:1px solid var(--bd);border-top:0;background:#0a0f1d;color:#d7e0f5;font:12px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace}.merge-row>div{min-height:20px;padding:1px 7px;border-right:1px solid #253047;border-bottom:1px solid rgba(255,255,255,.025)}.merge-ln{color:#64748b;text-align:right;user-select:none;background:#0d1424}.merge-code{white-space:pre;overflow:hidden}.merge-code.remove{background:rgba(239,68,68,.16);color:#fecaca;border-left:3px solid #ef4444}.merge-code.add{background:rgba(34,197,94,.16);color:#bbf7d0;border-left:3px solid #22c55e}.merge-code.empty{background:rgba(100,116,139,.08)}.merge-choice{background:#0d1424;display:flex;flex-direction:column;gap:3px;justify-content:center}.merge-choice button{font:10px/1.2 system-ui;padding:3px 4px;border-radius:4px;background:transparent;color:#cbd5e1;border:1px solid #334155}.merge-choice button:hover,.merge-choice button.selected{border-color:#60a5fa;background:#1d4ed8;color:#fff}.merge-choice button[data-merge-choice="manual"].selected{border-color:#f59e0b;background:#92400e}.merge-manual{padding:10px 12px;background:#111827;border-left:4px solid #f59e0b;border-bottom:1px solid #334155;min-width:1040px}.merge-manual-head{display:flex;align-items:center;gap:8px;margin-bottom:6px;color:#fbbf24;font:600 12px system-ui}.merge-manual textarea{display:block;width:100%;min-height:120px;max-height:38vh;resize:vertical;box-sizing:border-box;border:1px solid #475569;border-radius:6px;background:#090f1c;color:#f8fafc;padding:9px;font:12px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace}.merge-row.active-hunk.hunk-first>div{box-shadow:inset 0 2px 0 #f59e0b}.merge-row.active-hunk.hunk-last>div{box-shadow:inset 0 -2px 0 #f59e0b}.merge-row.active-hunk.hunk-first.hunk-last>div{box-shadow:inset 0 2px 0 #f59e0b,inset 0 -2px 0 #f59e0b}.merge-row.decision-server .merge-right{opacity:.45}.merge-row.decision-installer .merge-left{opacity:.45}.merge-row.decision-manual .merge-left,.merge-row.decision-manual .merge-right{opacity:.7}.merge-hunk-flash>div{animation:mergeFlash 1.1s ease-out}@keyframes mergeFlash{0%{filter:brightness(1.9)}100%{filter:brightness(1)}}
  dialog::backdrop{background:rgba(0,0,0,.5)} .dlg{padding:18px 20px}
  .dlg h3{margin:0 0 12px} .dlg label{display:block;margin:8px 0 3px;color:var(--mut);font-size:13px}
  .dlg input,.dlg select{width:100%;padding:8px;border:1px solid var(--bd);border-radius:6px;background:var(--bg);color:var(--fg);font:inherit}
  .pathrow{display:flex;gap:6px}.pathrow input{flex:1}.pathrow button{white-space:nowrap}
  #projectDlg{max-width:980px;width:94%} .pm-layout{display:grid;grid-template-columns:250px 1fr;gap:14px;min-height:520px}
  .pm-side,.pm-main{border:1px solid var(--bd);border-radius:9px;padding:12px;min-width:0}.pm-side{background:color-mix(in srgb,var(--mut) 5%,var(--card))}
  .pm-project{width:100%;text-align:left;margin-bottom:6px;background:transparent;color:var(--fg);border-color:var(--bd)}.pm-project.active{border-color:var(--acc);background:color-mix(in srgb,var(--acc) 12%,transparent)}
  .pm-project small{display:block;color:var(--mut);margin-top:2px}.pm-section{margin-top:14px;padding-top:12px;border-top:1px solid var(--bd)}
  .pm-installer{display:grid;grid-template-columns:1fr auto;gap:5px 10px;border:1px solid var(--bd);border-radius:8px;padding:9px;margin:7px 0}.pm-installer code{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .pm-server-picker{position:relative;margin-top:8px}.pm-server-picker summary{list-style:none;border:1px solid var(--bd);border-radius:7px;padding:8px 10px;cursor:pointer;background:var(--bg)}.pm-server-picker summary::-webkit-details-marker{display:none}
  .pm-server-menu{border:1px solid var(--bd);border-radius:8px;margin-top:5px;padding:8px;background:var(--card);box-shadow:0 10px 24px rgba(0,0,0,.13)}.pm-server-list{max-height:210px;overflow:auto;margin-top:6px}
  .pm-server{display:flex!important;align-items:center;gap:7px;padding:5px 2px!important;margin:0!important;color:var(--fg)!important}.pm-server input{width:auto}.pm-server small{margin-left:auto;color:var(--mut)}.pm-empty{color:var(--mut);padding:28px;text-align:center}
  @media(max-width:760px){.pm-layout{grid-template-columns:1fr}.pm-side{max-height:230px;overflow:auto}}
  .sshsetup{margin-top:8px;padding:10px;border:1px solid color-mix(in srgb,var(--acc) 55%,var(--bd));border-radius:8px;background:color-mix(in srgb,var(--acc) 8%,var(--card))}
  .sshsetup button{font-weight:700}.sshsetup.ok{border-color:var(--ok);background:color-mix(in srgb,var(--ok) 8%,var(--card))}
  .dlg .row{display:flex;gap:8px;justify-content:flex-end;margin-top:14px}
  #tagDlg{max-width:900px} #t_branch,#t_tag{width:100%}
  #planResultDlg{max-width:920px;width:92%;max-height:88vh}#planResultDlg .dlg{display:flex;flex-direction:column;max-height:88vh}#plan_result_body{overflow:auto;min-height:180px}.plan-result-head{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px}.plan-result-head .pill{display:inline-flex;align-items:center;border:1px solid var(--bd);border-radius:999px;padding:4px 8px;background:var(--card)}.plan-result-section{border:1px solid var(--bd);border-radius:8px;padding:10px;margin:8px 0}.plan-result-section h4{margin:0 0 7px}.plan-result-table th{width:auto}.plan-result-table th.server-col{color:#38bdf8}.plan-result-table th.installer-col{color:#c084fc}.plan-result-table td.server-cell{background:color-mix(in srgb,#38bdf8 7%,transparent);border-left:2px solid #38bdf8;padding-left:8px}.plan-result-table td.installer-cell{background:color-mix(in srgb,#c084fc 8%,transparent);border-left:2px solid #c084fc;padding-left:8px}.source-legend{display:flex;gap:8px;flex-wrap:wrap;margin:6px 0 9px}.source-key{display:inline-flex;align-items:center;gap:6px;padding:4px 9px;border-radius:999px;border:1px solid var(--bd);font-size:11px;font-weight:700}.source-key.server{color:#38bdf8;border-color:color-mix(in srgb,#38bdf8 60%,var(--bd));background:color-mix(in srgb,#38bdf8 9%,transparent)}.source-key.installer{color:#c084fc;border-color:color-mix(in srgb,#c084fc 60%,var(--bd));background:color-mix(in srgb,#c084fc 9%,transparent)}.config-title{display:flex;align-items:center;gap:7px;flex-wrap:wrap}.config-title .review-count{display:inline-flex;padding:3px 8px;border:1px solid currentColor;border-radius:999px;font-size:10.5px}.config-title .attention{color:var(--warn);background:color-mix(in srgb,var(--warn) 12%,transparent)}.config-title .reviewed{color:var(--ok);background:color-mix(in srgb,var(--ok) 12%,transparent)}.config-table{table-layout:fixed}.config-table th:first-child{width:auto}.config-table th:nth-child(2){width:132px}.config-table th:nth-child(3){width:160px}.file-target{display:flex;align-items:center;gap:7px;min-width:0}.file-target>code{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.file-action{display:inline-flex;align-items:center;gap:5px;flex:none;padding:5px 8px;border:1px solid color-mix(in srgb,var(--acc) 70%,var(--bd));border-radius:7px;background:color-mix(in srgb,var(--acc) 16%,var(--card));color:var(--fg);font-size:10.5px;font-weight:750;white-space:nowrap;box-shadow:0 0 0 1px color-mix(in srgb,var(--acc) 10%,transparent)}.file-action:hover{background:var(--acc);color:#fff;transform:translateY(-1px)}.file-review{display:inline-flex;align-items:center;gap:4px;padding:4px 8px;border:1px solid currentColor;border-radius:999px;font-size:10.5px;font-weight:800;white-space:nowrap}.file-review.pending{color:var(--warn);background:color-mix(in srgb,var(--warn) 15%,transparent)}.file-review.selected,.file-review.viewed{color:var(--ok);background:color-mix(in srgb,var(--ok) 15%,transparent)}.file-review.ignored{color:var(--mut);background:color-mix(in srgb,var(--mut) 12%,transparent)}.file-policy{width:100%;min-width:0;padding:6px 28px 6px 9px;font-size:11px;font-weight:750;border-width:1px;cursor:pointer}.file-policy.policy-managed{color:#93c5fd;border-color:#3b82f6;background-color:color-mix(in srgb,#3b82f6 13%,var(--card))}.file-policy.policy-observe-only{color:#fcd34d;border-color:#d97706;background-color:color-mix(in srgb,#d97706 13%,var(--card))}.file-policy.policy-ignored{color:#cbd5e1;border-color:#64748b;background-color:color-mix(in srgb,#64748b 13%,var(--card))}.plan-result-stale{border-left:3px solid var(--warn);padding:8px 10px;background:color-mix(in srgb,var(--warn) 8%,var(--card));margin-bottom:9px}.backup-state{margin-top:8px;padding:8px 10px;border-radius:7px;border:1px solid var(--bd)}.backup-state.warn{border-color:var(--warn);color:var(--warn);background:color-mix(in srgb,var(--warn) 8%,var(--card))}.backup-state.ok{border-color:var(--ok);color:var(--ok);background:color-mix(in srgb,var(--ok) 8%,var(--card))}.backup-state.bad{border-color:var(--bad);color:var(--bad);background:color-mix(in srgb,var(--bad) 8%,var(--card))}.backup-progress progress{display:block;width:100%;height:14px;margin:7px 0;accent-color:var(--acc)}.backup-progress .line{display:flex;justify-content:space-between;gap:10px;color:var(--fg)}
  .modal-cols{display:flex;gap:16px;margin-top:8px} .mcol{flex:1;min-width:0}
  @media(max-width:640px){.modal-cols{flex-direction:column}}
  .colh{font-size:12px;font-weight:700;color:var(--acc);text-transform:uppercase;letter-spacing:.03em;border-bottom:1px solid var(--bd);padding-bottom:4px;margin-bottom:6px}
  #t_switch{border-top:1px dashed var(--bd);padding-top:10px;margin-top:8px}
  .card.mini{cursor:pointer} .card.mini:hover{border-color:var(--acc)} .card.mini .verdict{margin:2px 0 0}
  .tworow{display:flex;gap:10px} .tworow>div{flex:1;min-width:0}
  .pickline{margin:10px 0 0;font-size:13px} .pick-tag{background:color-mix(in srgb,var(--acc) 22%,transparent);color:var(--acc);font-weight:700;padding:1px 7px}
  #t_exec[disabled]{opacity:.45;cursor:default}
  .taglist{max-height:46vh;overflow:auto;border:1px solid var(--bd);border-radius:8px;margin-top:10px}
  .tagrow{padding:7px 10px;border-bottom:1px solid var(--bd);cursor:pointer;font-size:13px}
  .tagrow:last-child{border-bottom:0} .tagrow:hover{background:color-mix(in srgb,var(--acc) 12%,transparent)}
  .tagrow.sel{background:color-mix(in srgb,var(--acc) 22%,transparent)} .tagrow.cur{background:color-mix(in srgb,var(--ok) 14%,transparent)}
  .tagrow .tg{font-weight:500} .bnum{color:var(--mut);font-size:11px}
  .mk-now{color:var(--ok);font-weight:700;font-size:11px;float:right}
  .mk-up{color:var(--warn);font-weight:700;font-size:11px;float:right}
  .mk-dn{color:var(--mut);font-size:11px;float:right}
  .nowline{font-size:13px;margin-top:4px;color:var(--fg)}
  main{transition:margin-right .2s ease} body.plan-open main{margin-right:min(760px,52vw);max-width:none}
  #planDlg{position:fixed;z-index:6;right:0;top:0;bottom:0;width:min(760px,52vw);background:var(--card);border-left:1px solid var(--bd);box-shadow:-12px 0 28px rgba(0,0,0,.16)}
  #planDlg[hidden]{display:none} #planDlg .dlg{height:100%;min-height:0;overflow:hidden;display:flex;flex-direction:column;padding:16px 18px}.planhead{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px}
  .plansetup{border:1px solid var(--bd);border-radius:9px;margin-bottom:7px;background:color-mix(in srgb,var(--mut) 4%,var(--card));flex:none}.plansetup>summary{list-style:none;cursor:pointer;padding:8px 10px;display:flex;align-items:center;gap:10px;font-size:12px}.plansetup>summary::-webkit-details-marker{display:none}.plansetup>summary:before{content:'▸';color:var(--acc);font-weight:700}.plansetup[open]>summary:before{content:'▾'}.plansetup-title{font-weight:700;white-space:nowrap}.plansetup-summary{color:var(--mut);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-left:auto}.plansetup-body{padding:0 9px 9px}.plansetup .planhint{margin-bottom:8px}
  .planfield{border:1px solid var(--bd);border-radius:8px;padding:9px;background:color-mix(in srgb,var(--mut) 5%,var(--card))}
  .planfield label{margin:0 0 4px}.planfield select{width:100%}.scope-files{display:flex;flex-wrap:wrap;gap:6px;max-height:96px;overflow:auto}.scope-files label{display:inline-flex;align-items:center;gap:5px;padding:4px 7px;border:1px solid var(--bd);border-radius:7px;background:var(--bg);font-size:11px;cursor:pointer}.scope-files input{width:auto;margin:0}.plansteps{display:flex;gap:6px;margin:-3px 0 12px}
  .planstep{font-size:11px;padding:3px 9px;border-radius:12px;border:1px solid var(--bd);color:var(--mut)}
  .planstep.on{border-color:var(--acc);color:var(--acc);background:color-mix(in srgb,var(--acc) 10%,transparent);font-weight:700}
  .planbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:8px 0}.planbar .pill{padding:3px 9px;border:1px solid var(--bd);border-radius:12px;font-size:11px}
  .plantable{border:1px solid var(--bd);border-radius:9px;overflow:auto;flex:1 1 auto;min-height:80px}.plantable table{font-size:12px;min-width:0}
  .plantable th{position:sticky;top:0;background:var(--card);z-index:1;padding:8px;width:auto;border-bottom:1px solid var(--bd)}
  .plantable th.server-col{color:#38bdf8}.plantable th.installer-col{color:#c084fc}.plantable td.server-cell{background:color-mix(in srgb,#38bdf8 6%,transparent);border-left:2px solid #38bdf8}.plantable td.installer-cell{background:color-mix(in srgb,#c084fc 7%,transparent);border-left:2px solid #c084fc}
  .plantable td{padding:7px 8px;border-bottom:1px solid var(--bd);vertical-align:middle}.plantable tr:last-child td{border-bottom:0}
  .plantable tr.plan-unmatched{background:color-mix(in srgb,var(--bad) 6%,transparent)} .plantable tr.plan-change{background:color-mix(in srgb,var(--warn) 5%,transparent)}
  .plansvc{font-weight:650}.plansub{font-size:10.5px;color:var(--mut)}.planarrow{color:var(--mut);padding:0 3px}
  .planstatus{font-size:10.5px;font-weight:700;padding:2px 7px;border-radius:10px;white-space:nowrap}.planstatus.ok{color:var(--ok);background:color-mix(in srgb,var(--ok) 13%,transparent)}
  .planstatus.warn{color:var(--warn);background:color-mix(in srgb,var(--warn) 13%,transparent)}.planstatus.bad{color:var(--bad);background:color-mix(in srgb,var(--bad) 13%,transparent)}
  .planfilter{background:transparent!important;color:var(--fg)!important;padding:4px 9px}.planfilter.active{border-color:var(--acc)!important;color:var(--acc)!important}
  #plan_preview{margin-top:7px;flex:0 1 auto;max-height:120px;overflow:auto}.planhint{padding:8px 10px;border-left:3px solid var(--acc);background:color-mix(in srgb,var(--acc) 7%,transparent);font-size:12px}
  #planDlg .dlg>.row{flex:none;position:relative;z-index:3;margin-top:7px;padding-top:7px;border-top:1px solid var(--bd);background:var(--card);display:flex;flex-wrap:wrap;white-space:normal}
  #planDlg .dlg>.row button{white-space:nowrap;min-width:0}
  #planDlg .dlg>.row button.ghost,#planResultDlg .dlg>.row button.ghost{background:color-mix(in srgb,var(--acc) 11%,var(--card));border-color:color-mix(in srgb,var(--acc) 55%,var(--bd));color:var(--fg);font-weight:600}
  #planDlg .dlg>.row button.ghost:hover,#planResultDlg .dlg>.row button.ghost:hover{background:color-mix(in srgb,var(--acc) 22%,var(--card));border-color:var(--acc)}
  .installer-alert{width:100%;margin:0 0 10px;text-align:left;background:color-mix(in srgb,var(--warn) 10%,var(--card));color:var(--fg);border-color:color-mix(in srgb,var(--warn) 55%,var(--bd));display:flex;align-items:center;gap:10px}
  .installer-alert b{color:var(--warn)}.installer-alert .go{margin-left:auto;color:var(--warn);font-weight:700}
  @media(max-width:900px){body.plan-open main{margin-right:0}#planDlg{width:100%}.planhead{grid-template-columns:1fr 1fr}}
</style></head><body>
<header>
  <h1>StandWatch <span class="muted" style="font-weight:400">· версії стендів</span></h1>
  <button id="ovbtn" class="ghost" title="Огляд усіх серверів">▦ Огляд</button>
  <button id="projectsbtn" class="ghost" title="Проєкти, installer-репозиторії та сервери">▤ Проєкти / installer</button>
  <span class="srv" id="srv"></span>
  <span class="grow"></span>
  <button id="planbtn" class="ghost" hidden>⇄ План оновлення</button>
  <button id="scan">Сканувати</button>
  <label class="sw"><input type="checkbox" id="auto"> авто</label>
  <select id="ival"><option value="10">10 хв</option><option value="20">20 хв</option><option value="30" selected>30 хв</option><option value="60">1 год</option><option value="custom">свій…</option></select>
  <button id="cfgbtn" class="ghost" title="Налаштування токенів">⚙</button>
  <button id="quitbtn" class="ghost" title="Зупинити панель">✕ Вийти</button>
  <span id="meta">—</span>
</header>
<main id="app"><p class="muted">Завантаження…</p></main>
<dialog id="reconcileDlg"><div class="dlg" style="width:100%">
  <h3>⇄ Reconcile конфігу <span id="rc_server" class="muted" style="font-weight:400"></span></h3>
  <div class="muted" style="font-size:12px;margin-bottom:8px">Два-стороння звірка: <b>verified baseline</b> ↔ <b>installer</b> (за зафіксованим ref). Baseline береться з останнього успішного config-apply/rollback або повного backup; live SHA перевіряється перед apply.</div>
  <label>Шлях конфіг-файлу (відносно installRoot)</label>
  <input id="rc_path" value="volumes/config/user-service/appsettings.Production.json">
  <div style="display:flex;gap:8px;align-items:center;margin-top:8px"><button id="rc_go">Звірити</button><span id="rc_meta" class="muted" style="font-size:12px"></span></div>
  <div id="rc_body" style="margin-top:12px"></div>
  <div class="row"><button class="ghost" id="rc_close">Закрити</button></div>
</div></dialog>
<dialog id="yamlDlg"><div class="dlg" style="width:100%">
  <h3><span id="yaml_title">⇄ YAML / Envoy</span> <span id="yaml_server" class="muted" style="font-weight:400"></span></h3>
  <div class="muted" style="font-size:12px;margin-bottom:8px">Read-only звірка verified baseline ↔ installer. Тут нічого не застосовується і сервер не змінюється.</div>
  <div style="display:flex;gap:8px;align-items:center"><code id="yaml_path" style="overflow-wrap:anywhere"></code><button id="yaml_refresh" style="margin-left:auto">Оновити</button></div>
  <div id="yaml_meta" class="muted" style="font-size:12px;margin-top:7px"></div>
  <div id="yaml_body" style="margin-top:10px"></div>
  <div class="row"><button class="ghost" id="yaml_close">Закрити</button></div>
</div></dialog>
<dialog id="yamlDiffDlg"><div class="dlg" style="width:100%">
  <div style="display:flex;align-items:center;gap:8px"><h3 style="margin:0">Файловий merge <span id="yaml_diff_path" class="muted" style="font-weight:400"></span></h3><span class="grow"></span><button class="ghost" id="yaml_diff_close">Закрити</button></div>
  <div class="muted" style="font-size:12px;margin:5px 0 8px">Два повні файли: verified baseline ↔ installer. Стрілки переходять між блоками; можна лишити серверний, installer або вписати свій фрагмент. Це локальна чернетка, apply вимкнено.</div>
  <div class="merge-toolbar"><button id="yaml_diff_prev" class="ghost">↑ Попередня</button><button id="yaml_diff_next">↓ Наступна</button><span id="yaml_diff_position" class="merge-stat"></span><span id="yaml_diff_resolved" class="muted"></span><span class="grow"></span><button id="yaml_diff_all_server" class="ghost">← Усе з сервера</button><button id="yaml_diff_all_installer" class="ghost">Усе з installer →</button><button id="yaml_diff_ignore" class="ghost">⊘ Ігнорувати файл</button><button id="yaml_diff_refresh" class="ghost">Оновити звірку</button><button id="yaml_diff_clear" class="ghost">Очистити</button></div>
  <div class="merge-head"><div>#</div><div style="color:#fca5a5">Сервер / verified baseline</div><div style="text-align:center">Рішення</div><div>#</div><div style="color:#86efac">Installer target</div></div>
  <div id="yaml_diff_body" class="merge-scroll"></div>
  <div id="yaml_diff_apply_status" style="margin-top:8px"></div>
  <div style="display:flex;align-items:center;gap:8px;margin-top:8px"><span class="muted" style="font-size:11px">Apply змінює лише файл. Контейнери не оновлюються і не перезапускаються.</span><span class="grow"></span><button id="yaml_diff_apply" disabled>Застосувати файл…</button></div>
</div></dialog>
<dialog id="permissionsDlg"><div class="dlg" style="width:min(520px,100%)">
  <h3>🔧 Системна підготовка сервера</h3>
  <div class="muted" style="font-size:12px;margin-bottom:10px">SSH і контейнери вже перевірені. Sudo-пароль потрібен одноразово, щоб StandWatch міг безпечно й атомарно працювати з керованими конфігами. Пароль не зберігається й не потрапляє в журнал.</div>
  <label>Sudo-пароль Linux-користувача <code id="permissions_user"></code></label>
  <div class="muted" style="font-size:11px;margin:4px 0 6px">SSH: <code id="permissions_server"></code>. Це не пароль Windows і не пароль SSH-ключа.</div>
  <input id="permissions_password" type="password" autocomplete="off" placeholder="Введи пароль один раз">
  <div id="permissions_status" style="margin-top:8px"></div>
  <div class="row"><button class="ghost" id="permissions_cancel">Скасувати</button><button id="permissions_install">Підготувати сервер</button></div>
</div></dialog>
<dialog id="cfgDlg"><div class="dlg">
  <h3>Налаштування доступу</h3>
  <div id="cfg_status" class="muted" style="font-size:12px;margin-bottom:8px"></div>
  <label>GitLab PAT <span class="muted">(scope read_api + read_registry)</span></label><input id="c_glt" type="password" placeholder="glpat-…  (лишити порожнім — не міняти)">
  <label>GitLab юзер <span class="muted">(для реєстру)</span></label><input id="c_glu" placeholder="напр. anton.kirpichnikov">
  <label>TeamCity token</label><input id="c_tct" type="password" placeholder="лишити порожнім — не міняти">
  <label>SSH-ключ StandWatch <span class="muted">(постійні scan/test/terminal підключення)</span></label><div class="pathrow"><input id="c_ssh" placeholder="C:/Users/ти/.ssh/standwatch_monitoring"><button type="button" class="ghost" id="c_pick_ssh">Вибрати наявний…</button></div>
  <div id="ssh_setup" class="sshsetup"><b>Рекомендовано для першого запуску</b><div id="ssh_setup_text" class="muted" style="font-size:12px;margin:4px 0 8px"></div><button type="button" id="c_create_ssh">＋ Створити ключ для моніторингу</button></div>
  <label>Діючий ключ першого входу <span class="muted">(необов’язково; його можна вибрати під час додавання сервера)</span></label><div class="pathrow"><input id="c_bootstrap" placeholder="C:/Users/ти/.ssh/id_rsa"><button type="button" class="ghost" id="c_pick_bootstrap">Вибрати…</button></div>
  <label>SSH-юзер за замовчуванням</label><input id="c_user" placeholder="akirpichnikov">
  <div id="cfg_msg" class="muted" style="font-size:12px"></div>
  <div class="row"><button class="ghost" id="c_cancel">Закрити</button><button id="c_ok">Зберегти</button></div>
</div></dialog>
<dialog id="projectDlg"><div class="dlg">
  <h3>Проєкти / банки та installer-репозиторії</h3>
  <div class="pm-layout">
    <div class="pm-side">
      <b>Проєкти / банки</b><div id="pm_projects" style="margin-top:9px"></div>
      <div class="pm-section"><label>Новий проєкт або банк</label><input id="pm_new_project" placeholder="Наприклад, Poruch"><button id="pm_add_project" style="width:100%;margin-top:7px">＋ Створити</button></div>
    </div>
    <div class="pm-main"><div id="pm_content" class="pm-empty">Обери або створи проєкт.</div></div>
  </div>
  <div class="row"><button class="ghost" id="pm_close">Закрити</button></div>
</div></dialog>
<dialog id="addDlg"><div class="dlg">
  <h3>Додати сервер</h3>
  <label>Назва</label><input id="f_name" placeholder="напр. 30.166 (prod)">
  <label>Хост (IP)</label><input id="f_host" placeholder="10.0.30.166">
  <label>SSH-юзер</label><input id="f_user" value="akirpichnikov">
  <label>Проєкт / банк</label><select id="f_project" style="width:100%"></select>
  <div id="f_project_new_box" hidden><label>Назва нового проєкту / банку</label><input id="f_project_new" placeholder="Наприклад, New Bank"></div>
  <label>Ключ StandWatch, який встановлюємо</label><input id="f_target" readonly>
  <label>РОБОЧИЙ приватний ключ для <code>ssh -i</code></label><div class="pathrow"><input id="f_bootstrap" placeholder="C:/Users/ти/.ssh/робочий_ключ"><button type="button" class="ghost" id="f_pick_bootstrap">Вказати РОБОЧИЙ КЛЮЧ для -i…</button></div>
  <label>Sudo-пароль Linux-користувача <span class="muted">(одноразово для системного налаштування)</span></label><input id="f_sudo" type="password" autocomplete="off" placeholder="Не зберігається">
  <div id="f_msg" class="muted"></div>
  <div class="row"><button class="ghost" id="f_cancel">Скасувати</button><button class="ghost" id="f_command">Підготувати команду</button><button id="f_ok">Перевірити і додати</button></div>
</div></dialog>
<dialog id="editDlg"><div class="dlg">
  <h3>✎ Редагувати сервер</h3>
  <label>Назва</label><input id="e_name" placeholder="напр. Poruch (QA)">
  <div class="muted" style="font-size:12px;margin:-2px 0 6px">перейменування безпечне — кеш і installer-прив'язки переносяться</div>
  <label>Хост (IP)</label><input id="e_host" placeholder="10.0.31.88">
  <label>SSH-юзер</label><input id="e_user" placeholder="akirpichnikov">
  <div class="muted" style="font-size:12px;margin:2px 0 6px"><code>standUrl</code> і <code>ssh</code> перезбираються з хоста узгоджено</div>
  <label>Ключ StandWatch для <code>ssh -i</code></label><input id="e_key" readonly>
  <div class="muted" style="font-size:12px;margin:-2px 0 0">береться з налаштувань ⚙ — тут лише показ</div>
  <div id="e_msg" class="muted" style="font-size:12px"></div>
  <div class="row"><button class="ghost" id="e_delete" style="color:var(--bad)">🗑 Видалити</button><span style="flex:1"></span><button class="ghost" id="e_cancel">Скасувати</button><button id="e_ok">Перевірити й зберегти</button></div>
</div></dialog>
<dialog id="tagDlg"><div class="dlg">
  <h3 id="t_title"></h3>
  <div class="modal-cols">
    <div class="mcol">
      <div class="colh">Стан образу</div>
      <div id="t_details"></div>
      <div id="t_switch">
        <div class="tworow">
          <div><label>Гілка <span class="muted">(лише фільтр)</span></label><select id="t_branch"></select></div>
          <div><label>Тег — <b>у деплой</b></label><select id="t_tag"></select></div>
        </div>
        <div id="t_pick" class="pickline"></div>
        <div id="t_cmd" class="cmd"></div>
      </div>
    </div>
    <div class="mcol">
      <div class="colh">Git / CI</div>
      <div id="t_git"></div>
    </div>
  </div>
  <div class="row"><button class="ghost" id="t_close">Закрити</button></div>
</div></dialog>
<dialog id="planResultDlg"><div class="dlg">
  <h3>Поточний план <span id="plan_result_id" class="muted"></span></h3>
  <div id="plan_result_body"></div>
  <div id="plan_backup_status"></div>
  <div id="plan_restore_status"></div>
  <div id="plan_config_apply_detail"></div>
  <div class="row"><button class="ghost" id="plan_result_close">Закрити</button><span id="plan_config_apply_status" class="muted" style="font-size:11px"></span><button class="ghost" id="plan_debug_apply_configs">🧪 DEBUG: перезаписати всі файли</button><button id="plan_apply_configs">Застосувати лише зміни…</button><button id="plan_restore_test">Перевірити відновлення БД</button><button id="plan_backup">Створити локальний backup</button></div>
</div></dialog>
<aside id="planDlg" hidden><div class="dlg">
  <h3>Звірка з installer <span id="p_server" class="muted"></span></h3>
  <details id="p_setup" class="plansetup" open><summary><span class="plansetup-title">Налаштувати ціль</span><span id="p_setup_summary" class="plansetup-summary">ще не вибрано</span></summary><div class="plansetup-body">
  <div id="p_mode_hint" class="planhint"></div>
  <div class="planhead">
    <div class="planfield"><label>Група контейнерів</label><select id="p_group"></select></div>
    <div class="planfield"><label>Режим стенду</label><select id="p_mode"><option value="dev">Ручний</option><option value="installer">Installer · контроль цільового стану</option></select></div>
    <div class="planfield" id="p_project_box"><label>Installer-репозиторій проєкту</label><select id="p_project"></select><div id="p_project_catalog_hint" class="plansub"></div></div>
    <div class="planfield" id="p_source_box"><label>Що фіксуємо</label><select id="p_source"><option value="installer_tag">Тег installer</option><option value="installer_branch">Гілку installer на конкретному commit</option></select></div>
    <div class="planfield" id="p_install_box" style="grid-column:1/-1"><label>Директорія цієї Docker-групи на сервері</label><div class="pathrow"><input id="p_install_root" placeholder="/usr/local/rscore"><button type="button" class="ghost" id="p_detect_root">Виявити автоматично</button></div><div id="p_install_root_hint" class="plansub"></div></div>
    <div class="planfield" id="p_scope_box" style="grid-column:1/-1"><label>Compose-файли цієї Docker-групи</label><div id="p_scope_files" class="scope-files"></div><div id="p_scope_hint" class="plansub"></div></div>
    <div class="planfield" id="p_ref_box"><label id="p_ref_label">Тег installer</label><select id="p_baseline"></select></div>
    <div class="planfield" id="p_branch_box" hidden><label id="p_branch_label">Гілка installer</label><select id="p_branch"></select></div>
    <div class="planfield" id="p_pinned_box"><label>Зафіксовано</label><div id="p_pinned" style="padding:6px 0;font-weight:650"></div></div>
  </div>
  <div id="p_commit_preview"></div>
  </div></details>
  <div class="planbar">
    <span id="p_total" class="pill"></span><span id="p_matched" class="pill ok"></span><span id="p_changes" class="pill warn"></span><span id="p_unknown" class="pill bad"></span><span id="p_files" class="pill"></span>
    <span class="grow"></span>
    <button class="planfilter active" data-pf="all">Усі</button><button class="planfilter" data-pf="change">Зміни</button><button class="planfilter" data-pf="problem">Проблеми</button>
  </div>
  <div id="p_table" class="plantable"></div>
  <div id="plan_preview"></div>
  <div class="row"><button class="ghost" id="p_close">Закрити</button><button class="ghost" id="p_view_plan" hidden>Переглянути поточний план</button><button id="p_dry">Зберегти цільовий стан</button><button id="p_execute">Сформувати план</button></div>
</div></aside>
<script>
const app=document.getElementById('app'), meta=document.getElementById('meta');
const short=d=>d?d.replace('sha256:','').slice(0,12):'—';
const esc=s=>String(s??'—').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const escAttr=s=>esc(s).replace(/"/g,'&quot;').replace(/'/g,'&#39;');
function ago(iso){if(!iso)return'—';const s=(Date.now()-new Date(iso))/1000;if(isNaN(s))return iso;if(s<3600)return Math.round(s/60)+' хв тому';if(s<86400)return Math.round(s/3600)+' год тому';return Math.round(s/86400)+' дн тому';}
function tc(t){if(!t)return'—';return '<a href="'+esc(t.url||'#')+'" target="_blank" class="st '+esc(t.status)+'">#'+esc(t.number)+' '+esc(t.status)+'</a>';}
const vcls=c=>c===0?'ok':c===10?'warn':c===20?'bad':'na';
function pickSshKey(target){
  if(window.chrome&&window.chrome.webview) window.chrome.webview.postMessage('pick-ssh-key:'+target);
  else { const v=prompt('Повний шлях до приватного SSH-ключа:'); if(v) document.getElementById(target).value=v; }
}
if(window.chrome&&window.chrome.webview) window.chrome.webview.addEventListener('message',e=>{
  const m=e.data||{}; if(m.type==='ssh-key-picked'&&document.getElementById(m.target)) document.getElementById(m.target).value=m.path||'';
});

const CATALOG_KEY='standwatch.installerCatalog.v1';
const catalogId=prefix=>prefix+'_'+Date.now().toString(36)+Math.random().toString(36).slice(2,7);
function readCatalog(){
  try{const v=JSON.parse(localStorage.getItem(CATALOG_KEY)||'null');if(v&&Array.isArray(v.projects)&&v.serverProjects){v.installRoots=v.installRoots||{};v.filePolicies=v.filePolicies||{};return v;}}catch{}
  const preview=new URLSearchParams(location.search).get('preview')==='plan';
  return {projects:preview?[{id:'project_poruch',name:'Poruch',installers:[{id:'installer_poruch',name:'Poruch installer',gitUrl:'https://gitlab.renome-smart.com/vpo/installer',projectPath:'vpo/installer',manifestRoot:'home'}]}]:[],serverProjects:preview?{'Poruch QA':'project_poruch'}:{},installRoots:preview?{'Poruch QA|rscore|vpo/installer':'/usr/local/rscore'}:{},filePolicies:{}};
}
let installerCatalog=readCatalog(),availableServers=[],serverConnections={},selectedCatalogProject=null;
let catalogSaveTimer=null,catalogSaveRevision=0,catalogSaveChain=Promise.resolve();
function reconcileCatalog(next){
  if(!next||!Array.isArray(next.projects))return;
  const oldProjects=new Map(installerCatalog.projects.map(x=>[x.id,x]));
  const projects=next.projects.map(value=>{const project=oldProjects.get(value.id)||{};const oldInstallers=new Map((project.installers||[]).map(x=>[x.id,x]));const installers=(value.installers||[]).map(item=>Object.assign(oldInstallers.get(item.id)||{},item));return Object.assign(project,value,{installers});});
  Object.assign(installerCatalog,next,{projects});localStorage.setItem(CATALOG_KEY,JSON.stringify(installerCatalog));
}
function saveCatalog(){
  localStorage.setItem(CATALOG_KEY,JSON.stringify(installerCatalog));installerState.projects=null;clearTimeout(catalogSaveTimer);const revision=++catalogSaveRevision;
  catalogSaveTimer=setTimeout(()=>{const payload=JSON.parse(JSON.stringify(installerCatalog));catalogSaveChain=catalogSaveChain.then(async()=>{try{const r=await fetch('/api/installer/catalog',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({catalog:payload})}),j=await r.json();if(!r.ok||!j.ok)throw new Error(j.error||('HTTP '+r.status));if(revision===catalogSaveRevision){reconcileCatalog(j.catalog);if(projectDlg.open)renderProjectManager();}}catch(e){console.error('installer catalog save:',e);}});},120);
}
async function hydrateInstallerCatalog(){
  try{const local=installerCatalog,r=await fetch('/api/installer/catalog'),remote=await r.json();if(!r.ok||remote.error)throw new Error(remote.error||('HTTP '+r.status));if(!remote.projects.length&&local.projects.length){const saved=await (await fetch('/api/installer/catalog',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({catalog:local})})).json();installerCatalog=saved.catalog||local;}else installerCatalog=remote;localStorage.setItem(CATALOG_KEY,JSON.stringify(installerCatalog));}
  catch(e){console.error('installer catalog load:',e);}
}
const catalogProject=id=>installerCatalog.projects.find(x=>x.id===id);
const projectForServer=name=>catalogProject(installerCatalog.serverProjects[name]);
function fillProjectSelect(selectId,allowCreate=false){
  const s=document.getElementById(selectId),old=s.value;s.innerHTML=installerCatalog.projects.map(x=>'<option value="'+esc(x.id)+'">'+esc(x.name)+'</option>').join('');
  if(allowCreate)s.insertAdjacentHTML('beforeend','<option value="__new__">＋ Створити новий проєкт / банк</option>');
  if([...s.options].some(x=>x.value===old))s.value=old;
}
function renderProjectManager(){
  const list=document.getElementById('pm_projects');
  list.innerHTML=installerCatalog.projects.length?installerCatalog.projects.map(p=>'<button class="pm-project '+(p.id===selectedCatalogProject?'active':'')+'" data-project="'+escAttr(p.id)+'"><b>'+esc(p.name)+'</b><small>installer: '+p.installers.length+' · сервери: '+Object.values(installerCatalog.serverProjects).filter(x=>x===p.id).length+'</small></button>').join(''):'<div class="muted">Проєктів ще немає.</div>';
  list.querySelectorAll('[data-project]').forEach(b=>b.onclick=()=>{selectedCatalogProject=b.dataset.project;renderProjectManager();});
  const p=catalogProject(selectedCatalogProject),content=document.getElementById('pm_content');if(!p){content.className='pm-empty';content.innerHTML='Обери або створи проєкт.';return;}
  content.className='';
  const attachedCount=Object.values(installerCatalog.serverProjects).filter(x=>x===p.id).length;
  const serverItems=availableServers.map(s=>{const owner=catalogProject(installerCatalog.serverProjects[s]);return '<label class="pm-server" data-server-row="'+escAttr(s.toLowerCase())+'"><input type="checkbox" data-server="'+escAttr(s)+'" '+(owner&&owner.id===p.id?'checked':'')+'> <span>'+esc(s)+'</span>'+(owner&&owner.id!==p.id?'<small>зараз: '+esc(owner.name)+'</small>':'')+'</label>';}).join('');
  content.innerHTML='<div class="pathrow"><input id="pm_project_name" value="'+escAttr(p.name)+'"><button id="pm_rename" class="ghost">Зберегти назву</button><button id="pm_delete_project" class="ghost">Видалити</button></div>'
    +'<div class="pm-section"><b>Installer-репозиторії</b><div id="pm_installers">'+(p.installers.length?p.installers.map(i=>'<div class="pm-installer"><div><b>'+esc(i.name)+'</b><div><code>'+esc(i.projectPath)+'</code></div><div class="plansub">склад installer: '+esc(i.manifestRoot||'home')+'/*.yml · '+esc(i.gitUrl||'')+'</div></div><button class="ghost" data-remove-installer="'+escAttr(i.id)+'">Видалити</button></div>').join(''):'<p class="muted">Ще не додано жодного installer.</p>')+'</div>'
    +'<div style="display:grid;grid-template-columns:1fr 1fr;gap:7px"><div><label>Назва installer</label><input id="pm_installer_name" placeholder="Core installer"></div><div><label>GitLab URL або group/project</label><input id="pm_installer_url" placeholder="https://gitlab…/group/installer"></div><details style="grid-column:1/-1"><summary class="muted" style="cursor:pointer">Додаткові налаштування</summary><label>Папка зі складом installer</label><input id="pm_manifest_root" value="home"><div class="plansub">Папка з compose-файлами всередині GitLab-репозиторію. Зазвичай визначається автоматично.</div></details></div><button id="pm_add_installer" style="margin-top:8px">＋ Додати installer</button></div>'
    +'<div class="pm-section"><b>Прикріплені сервери</b><details class="pm-server-picker"><summary id="pm_server_summary">'+(attachedCount?'Вибрано серверів: '+attachedCount:'Сервери не вибрані')+' ▾</summary><div class="pm-server-menu"><input id="pm_server_search" placeholder="Пошук сервера…"><div style="display:flex;gap:6px;margin-top:6px"><button type="button" class="ghost" id="pm_servers_all">Вибрати всі</button><button type="button" class="ghost" id="pm_servers_clear">Очистити</button></div><div class="pm-server-list">'+(serverItems||'<p class="muted">Серверів ще немає.</p>')+'</div></div></details></div>';
  document.getElementById('pm_rename').onclick=()=>{const name=document.getElementById('pm_project_name').value.trim();if(name){p.name=name;saveCatalog();renderProjectManager();}};
  document.getElementById('pm_delete_project').onclick=()=>{if(!confirm('Видалити проєкт «'+p.name+'» і його installer-прив’язки?'))return;installerCatalog.projects=installerCatalog.projects.filter(x=>x.id!==p.id);Object.keys(installerCatalog.serverProjects).forEach(s=>{if(installerCatalog.serverProjects[s]===p.id)delete installerCatalog.serverProjects[s];});selectedCatalogProject=null;saveCatalog();renderProjectManager();};
  content.querySelectorAll('[data-remove-installer]').forEach(b=>b.onclick=()=>{p.installers=p.installers.filter(x=>x.id!==b.dataset.removeInstaller);saveCatalog();renderProjectManager();});
  document.getElementById('pm_add_installer').onclick=()=>{const proj=catalogProject(selectedCatalogProject);if(!proj){alert('Проєкт не вибрано.');return;}const name=document.getElementById('pm_installer_name').value.trim(),entered=document.getElementById('pm_installer_url').value.trim(),root=document.getElementById('pm_manifest_root').value.trim()||'home';try{const path=normalizeInstallerProject(entered);if(!name)throw new Error('Вкажи назву installer.');(proj.installers=proj.installers||[]).push({id:catalogId('installer'),name,gitUrl:entered,projectPath:path,manifestRoot:root});saveCatalog();renderProjectManager();}catch(e){alert(e.message);}};
  const refreshServerSummary=()=>{const n=Object.values(installerCatalog.serverProjects).filter(x=>x===p.id).length;document.getElementById('pm_server_summary').textContent=(n?'Вибрано серверів: '+n:'Сервери не вибрані')+' ▾';saveCatalog();};
  content.querySelectorAll('[data-server]').forEach(ch=>ch.onchange=()=>{const previous=catalogProject(installerCatalog.serverProjects[ch.dataset.server]);if(ch.checked&&previous&&previous.id!==p.id&&!confirm('Сервер «'+ch.dataset.server+'» прикріплений до «'+previous.name+'». Перенести до «'+p.name+'»?')){ch.checked=false;return;}if(ch.checked)installerCatalog.serverProjects[ch.dataset.server]=p.id;else if(installerCatalog.serverProjects[ch.dataset.server]===p.id)delete installerCatalog.serverProjects[ch.dataset.server];refreshServerSummary();});
  document.getElementById('pm_server_search').oninput=e=>{const q=e.target.value.trim().toLowerCase();content.querySelectorAll('[data-server-row]').forEach(x=>x.hidden=q&&!x.dataset.serverRow.includes(q));};
  document.getElementById('pm_servers_all').onclick=()=>{content.querySelectorAll('[data-server]').forEach(ch=>{ch.checked=true;installerCatalog.serverProjects[ch.dataset.server]=p.id;});refreshServerSummary();};
  document.getElementById('pm_servers_clear').onclick=()=>{content.querySelectorAll('[data-server]').forEach(ch=>{ch.checked=false;if(installerCatalog.serverProjects[ch.dataset.server]===p.id)delete installerCatalog.serverProjects[ch.dataset.server];});refreshServerSummary();};
}
const projectDlg=document.getElementById('projectDlg');
document.getElementById('projectsbtn').onclick=()=>{selectedCatalogProject=selectedCatalogProject||installerCatalog.projects[0]?.id||null;renderProjectManager();projectDlg.showModal();};
document.getElementById('pm_close').onclick=()=>projectDlg.close();
document.getElementById('pm_add_project').onclick=()=>{const name=document.getElementById('pm_new_project').value.trim();if(!name)return;const p={id:catalogId('project'),name,installers:[]};installerCatalog.projects.push(p);selectedCatalogProject=p.id;document.getElementById('pm_new_project').value='';saveCatalog();renderProjectManager();};
document.querySelectorAll('dialog').forEach(modal=>modal.addEventListener('click',event=>{if(event.target===modal)modal.close();}));

let busy=false, current=null;
async function loadServers(){
  const r=await fetch('/api/servers'); const cfg=await r.json();
  availableServers=cfg.servers.map(s=>s.name);
  serverConnections=Object.fromEntries(cfg.servers.map(s=>[s.name,s.ssh||'']));
  const box=document.getElementById('srv'); box.innerHTML='';
  const pick=document.createElement('select'),placeholder=document.createElement('option');placeholder.value='';placeholder.textContent=cfg.servers.length?'Оберіть сервер · '+cfg.servers.length:'Серверів немає';pick.appendChild(placeholder);
  const buckets=new Map();cfg.servers.forEach(s=>{const p=projectForServer(s.name),label=p?p.name:'Без проєкту';if(!buckets.has(label))buckets.set(label,[]);buckets.get(label).push(s);});
  for(const [label,servers] of buckets){const group=document.createElement('optgroup');group.label=label;servers.sort((a,b)=>a.name.localeCompare(b.name)).forEach(s=>{const o=document.createElement('option');o.value=s.name;o.textContent=s.name;group.appendChild(o);});pick.appendChild(group);}
  if(current&&cfg.servers.some(s=>s.name===current))pick.value=current;
  pick.onchange=()=>{if(!pick.value)return showOverview();current=pick.value;document.getElementById('planbtn').hidden=false;showCached();};box.appendChild(pick);
  const add=document.createElement('button'); add.textContent='＋ сервер'; add.className='add';add.title='Додати сервер';
  add.onclick=openAdd; box.appendChild(add);
}
// Дашборд: усі сервери з короткою інфою (з кешу, миттєво)
async function showOverview(){
  current=null;const pick=document.querySelector('#srv select');if(pick)pick.value='';
  document.getElementById('planbtn').hidden=true;
  meta.textContent='огляд серверів';
  const list=await (await fetch('/api/overview')).json();
  if(!list.length){ app.innerHTML='<p class="muted">Немає серверів. Натисни «+ сервер», щоб додати.</p>'; return; }
  const ago2=t=>t?ago(t):'нема скану';
  app.innerHTML='<div id="ovgrid">'+list.map(s=>{
    const problems=s.down+s.upd; const cl=s.down?'bad':(s.upd||s.nv||s.unb?'warn':'ok');
    return '<div class="ovcard '+cl+'" data-srv="'+esc(s.name)+'">'
      +'<h2><span class="nm">'+esc(s.name)+'</span> <span class="muted">'+esc(s.standUrl||'')+'</span>'
      +'<span class="ovact"><button class="ren" title="Редагувати (host, юзер, назва)">✎</button><button class="del" title="Видалити">🗑</button></span></h2>'
      +'<div class="ovpills">'
      +(s.down?'<span class="pill bad">⛔ лежить: '+s.down+'</span>':'')
      +(s.upd?'<span class="pill warn">🔶 апдейт: '+s.upd+'</span>':'')
      +(s.nv?'<span class="pill warn">↑ версія: '+s.nv+'</span>':'')
      +(s.unb?'<span class="pill warn">гілка: '+s.unb+'</span>':'')
      +'<span class="pill ok">✅ '+s.ok+'</span><span class="pill na">усього: '+s.total+'</span></div>'
      +'<div class="muted" style="font-size:12px;margin-top:6px">'+(s.total?('оновлено '+ago2(s.savedAt)):'ще не скановано — відкрий і натисни «Сканувати»')+'</div>'
      +'</div>';
  }).join('')+'</div>';
  app.querySelectorAll('.ovcard').forEach(c=>c.onclick=()=>{current=c.dataset.srv;document.getElementById('planbtn').hidden=false;loadServers();showCached();});
  app.querySelectorAll('.ovcard .ren').forEach(b=>b.onclick=(e)=>{
    e.stopPropagation(); openEdit(b.closest('.ovcard').dataset.srv);
  });
  app.querySelectorAll('.ovcard .del').forEach(b=>b.onclick=async(e)=>{
    e.stopPropagation(); const nm=b.closest('.ovcard').dataset.srv;
    if(!confirm('Видалити сервер «'+nm+'» зі списку? (стенд не чіпається, лише запис у панелі)'))return;
    await fetch('/api/delete-server',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:nm})});
    delete installerCatalog.serverProjects[nm];saveCatalog();
    if(current===nm)current=null; loadServers().then(showOverview);
  });
}
document.getElementById('ovbtn').onclick=showOverview;
document.getElementById('quitbtn').onclick=async()=>{
  if(!confirm('Зупинити панель? Вкладку можна закрити.'))return;
  try{await fetch('/api/quit',{method:'POST'});}catch{}
  document.body.innerHTML='<p style="padding:40px;font:16px system-ui;color:#64748b">Панель зупинена. Можеш закрити вкладку.</p>';
};
// Показати збережений (кешований) стан миттєво, без сканування.
async function showCached(){
  try{
    const r=await fetch('/api/cached?server='+encodeURIComponent(current||'')); const c=await r.json();
    if(c&&c.data){render(c.data); meta.innerHTML=esc(current)+' · <span class="drift">кеш '+ago(c.savedAt)+'</span> — тисни «Сканувати» для свіжого';}
    else{app.innerHTML='<p class="muted">Немає збереженого стану для «'+esc(current)+'». Натисни «Сканувати».</p>'; meta.textContent=esc(current)+' · нема кешу';}
  }catch(e){app.innerHTML='<p class="card bad">'+esc(e.message)+'</p>';}
}
async function scan(){
  if(busy)return; busy=true;
  document.getElementById('scan').disabled=true; app.classList.add('spin'); meta.textContent='сканую '+current+'…';
  try{
    const r=await fetch('/api/scan?server='+encodeURIComponent(current||'')); const d=await r.json();
    if(d.error){app.innerHTML='<p class="card bad">Помилка: '+esc(d.error)+'</p>';return;}
    render(d); meta.textContent=esc(current)+' · оновлено '+new Date(d.generatedAt).toLocaleTimeString();
  }catch(e){app.innerHTML='<p class="card bad">'+esc(e.message)+'</p>';}
  finally{busy=false;document.getElementById('scan').disabled=false;app.classList.remove('spin');}
}
// ── налаштування токенів (⚙) ──
const cfgDlg=document.getElementById('cfgDlg');
async function openCfg(){
  const s=await (await fetch('/api/config')).json();
  document.getElementById('cfg_status').innerHTML='GitLab: '+(s.gitlab?'<b class="st SUCCESS">є</b>':'<b class="st FAILURE">нема</b>')+' · TeamCity: '+(s.teamcity?'<b class="st SUCCESS">є</b>':'<b class="st FAILURE">нема</b>');
  document.getElementById('c_glu').value=s.gitlabUser&&s.gitlabUser!=='token'?s.gitlabUser:'';
  document.getElementById('c_ssh').value=s.sshKey||'';
  document.getElementById('c_bootstrap').value=s.bootstrapKey||'';
  document.getElementById('c_user').value=s.sshDefaultUser||'';
  document.getElementById('c_glt').value=''; document.getElementById('c_tct').value='';
  document.getElementById('cfg_msg').innerHTML='';
  const setup=document.getElementById('ssh_setup');
  setup.classList.toggle('ok',!!(s.sshKeyExists&&s.sshPublicKeyExists));
  document.getElementById('ssh_setup_text').textContent=s.sshKeyExists&&s.sshPublicKeyExists
    ? '✓ Пара ключів готова: '+s.sshKey
    : 'Буде створено локально: '+s.suggestedSshKey+' та '+s.suggestedSshKey+'.pub';
  document.getElementById('c_create_ssh').textContent=s.sshKeyExists&&s.sshPublicKeyExists?'✓ Ключ уже готовий':'＋ Створити ключ для моніторингу';
  cfgDlg.showModal();
}
document.getElementById('cfgbtn').onclick=openCfg;
document.getElementById('c_pick_ssh').onclick=()=>pickSshKey('c_ssh');
document.getElementById('c_pick_bootstrap').onclick=()=>pickSshKey('c_bootstrap');
document.getElementById('c_create_ssh').onclick=async()=>{
  const btn=document.getElementById('c_create_ssh'), msg=document.getElementById('cfg_msg');
  btn.disabled=true; btn.textContent='створюю…'; msg.textContent='';
  const requested=document.getElementById('c_ssh').value.trim();
  const r=await fetch('/api/create-ssh-key',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:requested})});
  const j=await r.json(); btn.disabled=false;
  if(j.ok){document.getElementById('c_ssh').value=j.path;btn.textContent='✓ Ключ створено й підставлено';document.getElementById('ssh_setup').classList.add('ok');document.getElementById('ssh_setup_text').textContent='✓ Пара ключів готова: '+j.path;msg.innerHTML='<span class="st SUCCESS">Ключ готовий. Приватна частина залишається тільки на цьому комп’ютері.</span>';}
  else{btn.textContent='＋ Створити ключ для моніторингу';msg.innerHTML='<span class="st FAILURE">'+esc(j.error||'помилка')+'</span>';}
};
document.getElementById('c_cancel').onclick=()=>cfgDlg.close();
document.getElementById('c_ok').onclick=async()=>{
  const body={gitlabToken:document.getElementById('c_glt').value.trim(),gitlabUser:document.getElementById('c_glu').value.trim(),teamcityToken:document.getElementById('c_tct').value.trim(),sshKey:document.getElementById('c_ssh').value.trim(),bootstrapKey:document.getElementById('c_bootstrap').value.trim(),sshDefaultUser:document.getElementById('c_user').value.trim()};
  document.getElementById('cfg_msg').textContent='зберігаю…';
  const j=await (await fetch('/api/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).json();
  document.getElementById('cfg_msg').innerHTML=j.ok?'<span class="st SUCCESS">✓ збережено й застосовано</span>':'<span class="st FAILURE">'+esc(j.error||'помилка')+'</span>';
  if(j.ok) setTimeout(()=>{cfgDlg.close(); scan();},700);
};
// ── додавання сервера ──
const dlg=document.getElementById('addDlg');
async function openAdd(){
  document.getElementById('f_msg').innerHTML='';
  const s=await (await fetch('/api/config')).json();
  document.getElementById('f_target').value=s.sshKey||'';
  document.getElementById('f_bootstrap').value=s.bootstrapKey||'';
  document.getElementById('f_user').value=s.sshDefaultUser||'akirpichnikov';
  fillProjectSelect('f_project',true);document.getElementById('f_project_new_box').hidden=document.getElementById('f_project').value!=='__new__';
  dlg.showModal();
}
document.getElementById('f_project').onchange=()=>{document.getElementById('f_project_new_box').hidden=document.getElementById('f_project').value!=='__new__';};
document.getElementById('f_pick_bootstrap').onclick=()=>pickSshKey('f_bootstrap');
document.getElementById('f_cancel').onclick=()=>dlg.close();
function addServerForm(){return {name:document.getElementById('f_name').value,host:document.getElementById('f_host').value,user:document.getElementById('f_user').value,sshKey:document.getElementById('f_target').value.trim(),bootstrapKey:document.getElementById('f_bootstrap').value.trim(),sudoPassword:document.getElementById('f_sudo').value,projectId:document.getElementById('f_project').value,newProjectName:document.getElementById('f_project_new').value.trim()};}
function showBootstrapCommand(msg,j){
    msg.innerHTML='<p>У параметр <code>ssh -i</code> вже підставлено обраний РОБОЧИЙ ключ:</p><pre id="key_cmd">'+esc(j.command)+'</pre>'
    +'<button type="button" id="copy_key_cmd">Копіювати команду</button><p class="muted">Виконай її у своєму терміналі, після цього можна перевірити й додати сервер.</p>';
  document.getElementById('copy_key_cmd').onclick=async()=>{await navigator.clipboard.writeText(j.command);document.getElementById('copy_key_cmd').textContent='✓ Скопійовано';};
}
document.getElementById('f_command').onclick=async()=>{
  const msg=document.getElementById('f_msg'); msg.textContent='готую команду…';
  const b=addServerForm(); const r=await fetch('/api/bootstrap-command',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}); const j=await r.json();
  if(j.ok) showBootstrapCommand(msg,j); else msg.innerHTML='<span class="st FAILURE">'+esc(j.error||'помилка')+'</span>';
};
document.getElementById('f_ok').onclick=async()=>{
  const {name,host,user,sshKey,bootstrapKey,sudoPassword,projectId,newProjectName}=addServerForm();
  const msg=document.getElementById('f_msg'), btn=document.getElementById('f_ok');
  if(projectId==='__new__'&&!newProjectName){msg.innerHTML='<span class="st FAILURE">Вкажи назву нового проєкту / банку.</span>';return;}
  msg.innerHTML='перевіряю SSH…'; btn.disabled=true;
  try{
    const r=await fetch('/api/add-server',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,host,user,sshKey,bootstrapKey,sudoPassword})});
    const j=await r.json();
    if(j.ok){
      current=j.added||name;
      let assignedProject=projectId;if(projectId==='__new__'){const p={id:catalogId('project'),name:newProjectName,installers:[]};installerCatalog.projects.push(p);assignedProject=p.id;}
      if(assignedProject&&assignedProject!=='__new__')installerCatalog.serverProjects[current]=assignedProject;saveCatalog();
      document.getElementById('f_sudo').value='';dlg.close();
      await loadServers();
      await scan();
      return;
    }
    if(j.needKey) showBootstrapCommand(msg,j);
    else{msg.innerHTML='<span class="st FAILURE">'+esc(j.error||'помилка')+'</span>';if(j.needSudo)document.getElementById('f_sudo').focus();}
  }catch(e){msg.innerHTML='<span class="st FAILURE">'+esc(e.message||'помилка мережі')+'</span>';}
  finally{btn.disabled=false;}
};
// ── редагування наявного сервера (host/юзер/назва) ──
const editDlg=document.getElementById('editDlg');
let editingName=null;
async function openEdit(name){
  const [cfg,conf]=await Promise.all([(await fetch('/api/servers')).json(),(await fetch('/api/config')).json()]);
  const s=cfg.servers.find(x=>x.name===name); if(!s){alert('сервер не знайдено');return;}
  editingName=name;
  const host=String(s.ssh||'').split('@')[1]||String(s.standUrl||'').split('//').pop()||'';
  const user=String(s.ssh||'').split('@')[0]||conf.sshDefaultUser||'akirpichnikov';
  document.getElementById('e_name').value=name;
  document.getElementById('e_host').value=host;
  document.getElementById('e_user').value=user;
  document.getElementById('e_key').value=s.sshKey||conf.sshKey||'';
  document.getElementById('e_msg').innerHTML='';
  editDlg.showModal();
}
document.getElementById('e_cancel').onclick=()=>editDlg.close();
document.getElementById('e_delete').onclick=async()=>{
  if(!editingName)return;
  if(!confirm('Видалити сервер «'+editingName+'» зі списку? (стенд не чіпається, лише запис у панелі)'))return;
  await fetch('/api/delete-server',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:editingName})});
  delete installerCatalog.serverProjects[editingName];saveCatalog();
  if(current===editingName)current=null; editDlg.close(); loadServers().then(showOverview);
};
document.getElementById('e_ok').onclick=async()=>{
  const msg=document.getElementById('e_msg'), btn=document.getElementById('e_ok');
  const newName=document.getElementById('e_name').value.trim();
  const host=document.getElementById('e_host').value.trim();
  const user=document.getElementById('e_user').value.trim();
  if(!host){msg.innerHTML='<span class="st FAILURE">Вкажи хост (IP).</span>';return;}
  msg.innerHTML='перевіряю SSH новим адресом…'; btn.disabled=true;
  try{
    const j=await (await fetch('/api/edit-server',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:editingName,newName,host,user})})).json();
    if(j.ok){
      const from=editingName;
      if(j.renamedFrom&&installerCatalog.serverProjects[from]){installerCatalog.serverProjects[j.name]=installerCatalog.serverProjects[from];delete installerCatalog.serverProjects[from];saveCatalog();}
      if(current===from)current=j.name;
      msg.innerHTML='<span class="st SUCCESS">✓ SSH ок · '+(j.containers)+' контейнерів · збережено</span>';
      setTimeout(()=>{editDlg.close(); loadServers().then(()=>current?showCached():showOverview());},650);
      return;
    }
    msg.innerHTML='<span class="st FAILURE">'+esc(j.error||'помилка')+'</span>';
  }catch(e){msg.innerHTML='<span class="st FAILURE">'+esc(e.message||'помилка мережі')+'</span>';}
  finally{btn.disabled=false;}
};
function sev(row){ // 0 — найгостріше зверху
  const dep=row.deployed||{}; if(dep.state&&dep.state!=='running')return 0; // лежить
  if(row.verdict.code===20)return 1; if(row.verdict.code===10)return 2; if(row.verdict.code===0&&row.verdict.mark==='⚪️')return 3; return 4; // ok
}
let lastRows=[],lastData=null;
const planDlg=document.getElementById('planDlg');
let planFilter='all',planView=[],installerState={binding:null,refs:null,commits:[],snapshot:null,projects:null,currentPlan:null,scopeFiles:[]};
const apiJson=async(url,options)=>{const r=await fetch(url,options);const j=await r.json();if(!r.ok||j.error)throw new Error(j.error||('HTTP '+r.status));return j;};
const permissionsDlg=document.getElementById('permissionsDlg');
let permissionsRequest=null;
function openPermissionsSetup({path,onSuccess}){
  const status=document.getElementById('permissions_status'),input=document.getElementById('permissions_password'),button=document.getElementById('permissions_install');
  if(!path){status.innerHTML='<div class="backup-state bad">Нема файла для перевірки прав.</div>';return;}
  permissionsRequest={path,onSuccess};
  const ssh=serverConnections[current]||current,user=String(ssh).split('@')[0]||'невідомий';
  document.getElementById('permissions_user').textContent=user;
  document.getElementById('permissions_server').textContent=ssh;
  input.value='';input.disabled=false;button.disabled=false;status.innerHTML='';
  permissionsDlg.showModal();setTimeout(()=>input.focus(),0);
}
document.getElementById('permissions_cancel').onclick=()=>{const input=document.getElementById('permissions_password');input.value='';input.disabled=false;permissionsRequest=null;permissionsDlg.close();};
document.getElementById('permissions_password').onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();document.getElementById('permissions_install').click();}};
document.getElementById('permissions_install').onclick=async()=>{
  const button=document.getElementById('permissions_install'),input=document.getElementById('permissions_password'),status=document.getElementById('permissions_status'),request=permissionsRequest,password=input.value;
  if(!request)return;
  if(!password){status.innerHTML='<div class="backup-state bad">Введи sudo-пароль.</div>';input.focus();return;}
  button.disabled=true;input.disabled=true;status.innerHTML='<div class="backup-state warn"><b>Готую сервер…</b><br>Використовую налаштований SSH і перевіряю безпечний доступ до керованих конфігів.</div>';
  try{
    const result=await apiJson('/api/reconcile/helper/install',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({server:current,group:currentGroup(),path:request.path,password})});
    input.value='';input.disabled=false;permissionsRequest=null;permissionsDlg.close();
    if(request.onSuccess)request.onSuccess(result);
  }catch(e){input.value='';input.disabled=false;button.disabled=false;status.innerHTML='<div class="backup-state bad"><b>Сервер не підготовлено:</b> '+esc(e.message)+'</div>';input.focus();}
};
const groupOf=row=>(row.deployed&&row.deployed.project)||'default';
const currentGroup=()=>document.getElementById('p_group').value||'default';
const configReviewKey=path=>'standwatch.configReview.v1|'+[current,currentGroup(),installerState.currentPlan&&installerState.currentPlan.id||'',path].map(x=>encodeURIComponent(String(x||''))).join('|');
const fileMergeDraftKey=path=>'standwatch.fileMergeDraft.v1|'+[current,currentGroup(),installerState.currentPlan&&installerState.currentPlan.id||'',path].map(x=>encodeURIComponent(String(x||''))).join('|');
const readFileMergeDraft=path=>{try{const direct=JSON.parse(localStorage.getItem(fileMergeDraftKey(path))||'null');if(direct&&direct.decisions)return direct;
  const prefix='standwatch.yamlMerge.v2|'+[current,currentGroup(),path].map(x=>encodeURIComponent(String(x||''))).join('|')+'|';
  for(let index=localStorage.length-1;index>=0;index--){const key=localStorage.key(index);if(!key||!key.startsWith(prefix))continue;const decisions=JSON.parse(localStorage.getItem(key)||'null');if(decisions&&typeof decisions==='object'&&Object.keys(decisions).length)return{path,decisions,hunkCount:Object.keys(decisions).length,recovered:true};}
  return null;}catch{return null;}};
const completeFileMergeDraft=draft=>{if(!draft||!draft.decisions||!Number.isInteger(draft.hunkCount))return false;const mode=value=>typeof value==='string'?value:value&&value.mode;return Object.keys(draft.decisions).filter(key=>Number(key)<draft.hunkCount&&['server','installer','manual'].includes(mode(draft.decisions[key]))).length===draft.hunkCount;};
const volatileConfigReviews=new Map();
const configReviewState=path=>{const key=configReviewKey(path);if(volatileConfigReviews.has(key))return volatileConfigReviews.get(key);try{return localStorage.getItem(key)||'';}catch{return '';}};
function updateConfigReviewSummary(){const rows=[...document.querySelectorAll('#plan_result_body [data-config-review]')].filter(x=>x.dataset.attention==='1'),total=rows.length,done=rows.filter(x=>['selected','viewed'].includes(x.dataset.reviewState)).length;const a=document.getElementById('config_attention_count'),r=document.getElementById('config_reviewed_count');if(a)a.textContent='потребують уваги: '+total;if(r)r.textContent='опрацьовано: '+done+' / '+total;}
function setConfigReview(path,state,persist=true){const key=configReviewKey(path);try{if(state&&persist)localStorage.setItem(key,state);else localStorage.removeItem(key);}catch{}if(state&&!persist)volatileConfigReviews.set(key,state);else volatileConfigReviews.delete(key);const node=[...document.querySelectorAll('#plan_result_body [data-config-review]')].find(x=>x.dataset.configReview===path);if(node){node.dataset.reviewState=state||'';node.className='file-review '+(state||'pending');node.textContent=state==='selected'?'✓ Рішення вибрано':state==='viewed'?'✓ Переглянуто':'○ До перевірки';}updateConfigReviewSummary();}
// ── YAML / Envoy preview (read-only) ──
const yamlDlg=document.getElementById('yamlDlg'),yamlDiffDlg=document.getElementById('yamlDiffDlg'),yamlPreviewCache=new Map();
let yamlGroup='rscore',yamlPath='',yamlPreviewMode='yaml';
const yamlPreviewKey=()=>current+'\\n'+yamlGroup+'\\n'+yamlPath;
const yamlValue=value=>value===undefined?'—':value===null?'null':typeof value==='string'?value:JSON.stringify(value);
function openYamlLineDiff(j){
  const body=document.getElementById('yaml_diff_body'),lines=j.textDiff&&j.textDiff.lines||[],rows=[],hunks=[];
  const applyButton=document.getElementById('yaml_diff_apply'),applyStatus=document.getElementById('yaml_diff_apply_status');
  applyStatus.innerHTML='';applyButton.textContent='Застосувати файл…';applyButton.disabled=true;
  let leftNo=0,rightNo=0,index=0,hunk=-1;
  while(index<lines.length){
    if(lines[index].type==='same'){
      leftNo++;rightNo++;rows.push({hunk:-1,left:lines[index].text,right:lines[index].text,leftNo,rightNo,first:false});index++;continue;
    }
    const removes=[],adds=[];let redacted=false;hunk++;
    while(index<lines.length&&lines[index].type!=='same'){redacted=redacted||!!lines[index].redacted;if(lines[index].type==='remove')removes.push(lines[index].text);else adds.push(lines[index].text);index++;}
    const start=rows.length,count=Math.max(removes.length,adds.length);
    for(let offset=0;offset<count;offset++){
      const hasLeft=offset<removes.length,hasRight=offset<adds.length;if(hasLeft)leftNo++;if(hasRight)rightNo++;
      rows.push({hunk,left:hasLeft?removes[offset]:null,right:hasRight?adds[offset]:null,leftNo:hasLeft?leftNo:null,rightNo:hasRight?rightNo:null,first:offset===0,last:offset===count-1});
    }
    hunks.push({index:hunk,start,count,serverText:removes.join('\\n'),installerText:adds.join('\\n'),redacted});
  }
  const decisionKey='standwatch.yamlMerge.v2|'+[current,yamlGroup,yamlPath,j.ref||'',j.baselineId||''].map(encodeURIComponent).join('|');
  let decisions={};try{decisions=JSON.parse(localStorage.getItem(decisionKey)||'{}')||{};}catch{}
  const modeOf=value=>typeof value==='string'?value:value&&value.mode;
  for(const item of hunks)if(item.redacted&&modeOf(decisions[item.index])==='manual')delete decisions[item.index];
  const choice=entry=>entry.first?'<div class="merge-choice"><button data-merge-choice="server">← Сервер</button><button data-merge-choice="installer">Installer →</button><button data-merge-choice="manual" '+(hunks[entry.hunk]?.redacted?'disabled title="Ручне редагування заблоковано: блок містить замасковане секретне значення"':'')+'>✎ Вручну</button></div>':'<div class="merge-choice"></div>';
  body.innerHTML=rows.map((entry,rowIndex)=>{const changed=entry.hunk>=0,mode=changed?modeOf(decisions[entry.hunk]):null,classes='merge-row'+(changed?' merge-change decision-'+(mode||'none')+(entry.first?' hunk-first':'')+(entry.last?' hunk-last':''):'');const row='<div class="'+classes+'" data-merge-row="'+rowIndex+'" data-hunk="'+entry.hunk+'" '+(entry.first?'id="merge_hunk_'+entry.hunk+'"':'')+'><div class="merge-ln">'+(entry.leftNo||'')+'</div><div class="merge-code merge-left '+(changed?(entry.left===null?'empty':'remove'):'same')+'">'+(entry.left===null?'':esc(entry.left)||'&nbsp;')+'</div>'+choice(entry)+'<div class="merge-ln">'+(entry.rightNo||'')+'</div><div class="merge-code merge-right '+(changed?(entry.right===null?'empty':'add'):'same')+'">'+(entry.right===null?'':esc(entry.right)||'&nbsp;')+'</div></div>';if(!entry.last)return row;const saved=decisions[entry.hunk],manual=saved&&typeof saved==='object'&&saved.mode==='manual'?saved.text:hunks[entry.hunk].installerText;return row+'<div class="merge-manual" data-merge-editor="'+entry.hunk+'" hidden><div class="merge-manual-head"><span>✎ Ручний цільовий фрагмент</span><span class="muted">зберігається автоматично лише на цьому комп’ютері</span></div><textarea data-merge-manual-input="'+entry.hunk+'" spellcheck="false">'+esc(manual||'')+'</textarea></div>';}).join('');
  let currentHunk=0,scrollTick=false;
  const saveDecisions=()=>{localStorage.setItem(decisionKey,JSON.stringify(decisions));localStorage.setItem(fileMergeDraftKey(yamlPath),JSON.stringify({path:yamlPath,ref:j.ref||'',baselineId:j.baselineId||'',format:j.format||yamlPreviewMode,decisions,hunkCount:hunks.length,updatedAt:new Date().toISOString()}));};
  const refreshState=()=>{
    body.querySelectorAll('[data-hunk]').forEach(row=>{const id=Number(row.dataset.hunk),mode=id>=0?modeOf(decisions[id]):null;row.classList.toggle('active-hunk',id===currentHunk);row.classList.toggle('decision-server',mode==='server');row.classList.toggle('decision-installer',mode==='installer');row.classList.toggle('decision-manual',mode==='manual');row.querySelectorAll('[data-merge-choice]').forEach(button=>button.classList.toggle('selected',button.dataset.mergeChoice===mode));});
    body.querySelectorAll('[data-merge-editor]').forEach(editor=>editor.hidden=modeOf(decisions[Number(editor.dataset.mergeEditor)])!=='manual');
    document.getElementById('yaml_diff_position').textContent=hunks.length?'Зміна '+(currentHunk+1)+' із '+hunks.length:'Змін немає';
    const resolved=Object.keys(decisions).filter(key=>Number(key)<hunks.length&&['server','installer','manual'].includes(modeOf(decisions[key]))).length;
    document.getElementById('yaml_diff_resolved').textContent='вирішено '+resolved+' · лишилось '+Math.max(0,hunks.length-resolved);
    setConfigReview(yamlPath,hunks.length?(resolved===hunks.length?'selected':null):'viewed');
    document.getElementById('yaml_diff_prev').disabled=!hunks.length;document.getElementById('yaml_diff_next').disabled=!hunks.length;
    const allServer=hunks.length&&hunks.every(item=>modeOf(decisions[item.index])==='server');
    applyButton.textContent=allServer?'Без змін — усе з сервера':'Застосувати файл…';
    applyButton.disabled=!hunks.length||resolved!==hunks.length||!j.serverMatchesBaseline||!!j.textDiff?.truncated||allServer;
  };
  const focusHunk=(next,smooth=true)=>{if(!hunks.length)return;currentHunk=(next+hunks.length)%hunks.length;const anchor=document.getElementById('merge_hunk_'+currentHunk);if(anchor){body.scrollTo({top:Math.max(0,anchor.offsetTop-body.clientHeight/2+anchor.offsetHeight/2),behavior:smooth?'smooth':'auto'});anchor.classList.remove('merge-hunk-flash');requestAnimationFrame(()=>anchor.classList.add('merge-hunk-flash'));setTimeout(()=>anchor.classList.remove('merge-hunk-flash'),1200);}refreshState();};
  body.onclick=event=>{const button=event.target.closest('[data-merge-choice]');if(!button)return;const row=button.closest('[data-hunk]'),id=Number(row.dataset.hunk),mode=button.dataset.mergeChoice;if(mode==='manual'){const input=body.querySelector('[data-merge-manual-input="'+id+'"]');decisions[id]={mode:'manual',text:input?input.value:hunks[id].installerText};}else decisions[id]=mode;saveDecisions();currentHunk=id;refreshState();if(mode==='manual'){const editor=body.querySelector('[data-merge-editor="'+id+'"]');if(editor)setTimeout(()=>{editor.scrollIntoView({block:'nearest'});editor.querySelector('textarea').focus();},0);}};
  body.oninput=event=>{const input=event.target.closest('[data-merge-manual-input]');if(!input)return;const id=Number(input.dataset.mergeManualInput);decisions[id]={mode:'manual',text:input.value};saveDecisions();refreshState();};
  body.onscroll=()=>{if(scrollTick||!hunks.length)return;scrollTick=true;requestAnimationFrame(()=>{scrollTick=false;const middle=body.getBoundingClientRect().top+body.clientHeight/2;let best=currentHunk,distance=Infinity;for(const item of hunks){const node=document.getElementById('merge_hunk_'+item.index);if(!node)continue;const d=Math.abs(node.getBoundingClientRect().top-middle);if(d<distance){distance=d;best=item.index;}}if(best!==currentHunk){currentHunk=best;refreshState();}});};
  document.getElementById('yaml_diff_prev').onclick=()=>focusHunk(currentHunk-1);
  document.getElementById('yaml_diff_next').onclick=()=>focusHunk(currentHunk+1);
  document.getElementById('yaml_diff_all_server').onclick=()=>{for(const item of hunks)decisions[item.index]='server';saveDecisions();refreshState();};
  document.getElementById('yaml_diff_all_installer').onclick=()=>{for(const item of hunks)decisions[item.index]='installer';saveDecisions();refreshState();};
  document.getElementById('yaml_diff_ignore').onclick=()=>{if(!confirm('Ігнорувати цей файл у поточному та наступних планах для цієї installer-прив’язки?'))return;const plan=installerState.currentPlan&&installerState.currentPlan.plan;if(!plan)return;installerCatalog.filePolicies=installerCatalog.filePolicies||{};installerCatalog.filePolicies[plan.server+'|'+plan.group+'|'+plan.target.project+'|'+yamlPath]='ignored';saveCatalog();localStorage.removeItem(fileMergeDraftKey(yamlPath));yamlDiffDlg.close();const result=document.getElementById('planResultDlg');if(result.open)result.close();openCurrentPlan();};
  document.getElementById('yaml_diff_refresh').onclick=()=>loadYamlMergeDirect(true);
  document.getElementById('yaml_diff_clear').onclick=()=>{if(!Object.keys(decisions).length||confirm('Очистити всі рішення для цього файла?')){decisions={};localStorage.removeItem(decisionKey);localStorage.removeItem(fileMergeDraftKey(yamlPath));refreshState();}};
  applyButton.onclick=async()=>{const payload={server:current,group:yamlGroup,path:yamlPath,decisions};applyButton.disabled=true;applyStatus.innerHTML='<div class="backup-state warn">Preflight: live SHA → target → право atomic write…</div>';
    try{const pre=await apiJson('/api/reconcile/file/prepare',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
      if(!pre.prepareReady){const failed=Object.entries(pre.gates||{}).filter(([,ok])=>!ok).map(([name])=>name).join(', ');applyButton.disabled=false;if(pre.gates&&!pre.gates.remoteToolsReady){applyStatus.innerHTML='<div class="backup-state warn"><b>Потрібне одноразове системне налаштування сервера.</b> Після підтвердження preflight повториться автоматично.</div>';openPermissionsSetup({path:yamlPath,onSuccess:()=>{applyStatus.innerHTML='<div class="backup-state ok"><b>✓ Сервер підготовлено.</b> Повторюю preflight файла…</div>';setTimeout(()=>applyButton.click(),0);}});return;}applyStatus.innerHTML='<div class="backup-state bad"><b>Apply заблоковано:</b> '+esc(failed||'preflight')+(pre.prerequisites&&pre.prerequisites.error?'<br>'+esc(pre.prerequisites.error):'')+'</div>';return;}
      if(!confirm('Атомарно перезаписати файл на '+current+'?\\n\\n'+pre.absolutePath+'\\nTarget SHA: '+pre.hashes.target.slice(0,12)+'…\\n\\nБуде створено T2 snapshot. Контейнери НЕ оновлюються і НЕ перезапускаються.')){applyStatus.innerHTML='';applyButton.disabled=false;return;}
      applyStatus.innerHTML='<div class="backup-state warn"><b>Файлова транзакція…</b> T2 snapshot → atomic write → SHA verify. Контейнери не чіпаємо.</div>';
      const applied=await apiJson('/api/reconcile/file/apply',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
      applyStatus.innerHTML='<div class="backup-state ok"><b>✓ Файл атомарно оновлено.</b> Контейнери не змінювалися.<br>Транзакція <code>'+esc(applied.transactionId)+'</code> · SHA <code>'+esc(applied.hashes.target.slice(0,12))+'…</code><br><button type="button" id="yaml_file_rollback" class="ghost" style="margin-top:7px">↶ Відкотити файл до T2</button></div>';applyButton.textContent='✓ Файл застосовано';yamlPreviewCache.clear();
      document.getElementById('yaml_file_rollback').onclick=async event=>{const button=event.currentTarget;if(!confirm('Відкотити лише файл до T2 snapshot? Контейнери не перезапускатимуться.'))return;button.disabled=true;try{const rolled=await apiJson('/api/reconcile/rollback',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({transactionId:applied.transactionId})});applyStatus.innerHTML='<div class="backup-state ok"><b>✓ Файл відновлено з T2.</b> SHA <code>'+esc(rolled.hash.slice(0,12))+'…</code>. Контейнери не змінювалися.</div>';applyButton.textContent='Застосувати файл…';applyButton.disabled=false;yamlPreviewCache.clear();}catch(e){applyStatus.innerHTML='<div class="backup-state bad"><b>Rollback не завершено:</b> '+esc(e.message)+'</div>';button.disabled=false;}};
    }catch(e){applyStatus.innerHTML='<div class="backup-state bad"><b>Apply не завершено:</b> '+esc(e.message)+'</div>';applyButton.disabled=false;}};
  document.getElementById('yaml_diff_path').textContent='· '+yamlPath;
  if(!yamlDiffDlg.open)yamlDiffDlg.showModal();
  setTimeout(()=>focusHunk(0,false),60);
}
document.getElementById('yaml_diff_close').onclick=()=>yamlDiffDlg.close();
async function loadYamlMergeDirect(force=false){
  const body=document.getElementById('yaml_diff_body'),started=Date.now(),refresh=document.getElementById('yaml_diff_refresh');
  document.getElementById('yaml_diff_path').textContent='· '+yamlPath;document.getElementById('yaml_diff_position').textContent='Читаю файл…';document.getElementById('yaml_diff_resolved').textContent='';
  body.innerHTML='<div class="yaml-loading" style="margin:12px"><b>Готую повний файловий merge…</b><progress></progress><div class="muted" id="yaml_merge_loading">Витягую verified baseline · 0 с</div></div>';
  if(!yamlDiffDlg.open)yamlDiffDlg.showModal();refresh.disabled=true;
  const timer=setInterval(()=>{const line=document.getElementById('yaml_merge_loading');if(line)line.textContent='Витягую verified baseline · '+Math.floor((Date.now()-started)/1000)+' с';},1000);
  try{const endpoint=yamlPreviewMode==='json'?'/api/reconcile':yamlPreviewMode==='text'?'/api/reconcile/text':'/api/reconcile/yaml';const j=await apiJson(endpoint+'?server='+encodeURIComponent(current)+'&group='+encodeURIComponent(yamlGroup)+'&path='+encodeURIComponent(yamlPath)+(force?'&refresh=1':''));j.serverMatchesBaseline=j.serverMatchesBaseline??j.serverMatchesBackup;yamlPreviewCache.set(yamlPreviewMode+'\\n'+yamlPreviewKey(),j);openYamlLineDiff(j);}
  catch(e){body.innerHTML='<div class="backup-state bad" style="margin:12px">'+esc(e.message)+'</div>';document.getElementById('yaml_diff_position').textContent='Не вдалося прочитати';}
  finally{clearInterval(timer);refresh.disabled=false;}
}
async function loadYamlPreview(force=false){
  const key=yamlPreviewKey(),body=document.getElementById('yaml_body'),meta=document.getElementById('yaml_meta'),button=document.getElementById('yaml_refresh');
  const started=Date.now();body.innerHTML='<div class="yaml-loading"><b>Читаю YAML…</b><progress></progress><div class="muted" id="yaml_loading_text">Витягую verified baseline з локального backup · 0 с</div><div class="muted" style="font-size:11px;margin-top:5px">Перший доступ може зайняти 10–30 секунд через великий архів. Вікно не зависло.</div></div>';button.disabled=true;
  const loadingTimer=setInterval(()=>{const line=document.getElementById('yaml_loading_text');if(line)line.textContent='Витягую verified baseline з локального backup · '+Math.floor((Date.now()-started)/1000)+' с';},1000);
  try{
    const j=await apiJson('/api/reconcile/yaml?server='+encodeURIComponent(current)+'&group='+encodeURIComponent(yamlGroup)+'&path='+encodeURIComponent(yamlPath)+(force?'&refresh=1':''));
    yamlPreviewCache.set(key,j);
    if((j.textDiff&&j.textDiff.lines||[]).length>=500){yamlDlg.close();openYamlLineDiff(j);return;}
    const s=j.summary||{},changes=(j.rows||[]).filter(row=>row.status!=='same').sort((a,b)=>(Number(b.important)-Number(a.important))||a.key.localeCompare(b.key));
    meta.innerHTML='installer <code>'+esc((j.ref||'').slice(0,8))+'</code> · baseline <code>'+esc(j.baselineId||'—')+'</code>'
      +(j.serverMatchesBaseline?' · <span style="color:var(--ok)">live SHA збігається</span>':' · <span style="color:var(--bad)">live-файл дрейфував від baseline</span>')+(j.cached?' · <span style="color:var(--ok)">збережена звірка, SHA перевірено</span>':'');
    const rowHtml=row=>'<div class="yaml-row changed"><code>'+esc(row.key)+(row.important?'<span class="yaml-important">увага</span>':'')+'</code><code style="color:var(--bad)">'+esc(yamlValue(row.baseline))+'</code><span class="muted">→</span><code style="color:var(--ok)">'+esc(yamlValue(row.installer))+'</code></div>';
    const head='<div class="yaml-row" style="font-weight:700;background:var(--bg)"><span>Named-поле</span><span style="color:var(--bad)">Verified baseline</span><span></span><span style="color:var(--ok)">Installer</span></div>';
    const isEnvoy=String(yamlPath).toLowerCase().split('/').pop().startsWith('envoy'),kind=isEnvoy?'Envoy':'Compose/YAML';
    const changesBox='<div class="plan-result-section"><h4>Зміни '+kind+': '+changes.length+'</h4>'+head+(changes.length?changes.map(rowHtml).join(''):'<p class="muted">YAML повністю збігається.</p>')+'</div>';
    const diffButton='<div style="display:flex;justify-content:flex-end;margin-top:8px"><button id="yaml_open_diff">Відкрити повний рядковий diff в окремому вікні</button></div>'+(j.textDiff&&j.textDiff.truncated?'<div class="backup-state warn">Повний diff обрізано за безпечним лімітом.</div>':'');
    body.innerHTML='<div class="plan-result-head"><span class="pill">усього змін: '+esc(changes.length)+'</span><span class="pill">потребують уваги: '+esc(s.importantChanges||0)+'</span><span class="pill">змінено: '+esc(s.different||0)+'</span><span class="pill">лише baseline: '+esc(s.baselineOnly||0)+'</span><span class="pill">додає installer: '+esc(s.installerOnly||0)+'</span></div>'+changesBox+diffButton+'<div class="backup-state warn"><b>Застосування:</b> спочатку відкрий повний merge і вибери рішення для кожного блока. Apply змінює лише файл.</div>';
    document.getElementById('yaml_open_diff').onclick=()=>openYamlLineDiff(j);
    setConfigReview(yamlPath,'viewed');
  }catch(e){meta.textContent='';body.innerHTML='<div class="backup-state bad">'+esc(e.message)+'</div>';}
  finally{clearInterval(loadingTimer);button.disabled=false;}
}
function openYamlFor(path){if(!current){alert('Спершу вибери сервер.');return;}yamlPreviewMode='yaml';yamlGroup=currentGroup()||'rscore';yamlPath=path;loadYamlMergeDirect(false);}
async function loadTextPreview(force=false){
  const key='text\\n'+yamlPreviewKey(),body=document.getElementById('yaml_body'),meta=document.getElementById('yaml_meta'),button=document.getElementById('yaml_refresh'),started=Date.now();body.innerHTML='<div class="yaml-loading"><b>Читаю скрипт…</b><progress></progress><div class="muted" id="yaml_loading_text">Витягую verified baseline з локального backup · 0 с</div></div>';button.disabled=true;const loadingTimer=setInterval(()=>{const line=document.getElementById('yaml_loading_text');if(line)line.textContent='Витягую verified baseline з локального backup · '+Math.floor((Date.now()-started)/1000)+' с';},1000);
  try{const j=await apiJson('/api/reconcile/text?server='+encodeURIComponent(current)+'&group='+encodeURIComponent(yamlGroup)+'&path='+encodeURIComponent(yamlPath)+(force?'&refresh=1':''));yamlPreviewCache.set(key,j);
    meta.innerHTML='installer <code>'+esc((j.ref||'').slice(0,8))+'</code> · baseline <code>'+esc(j.baselineId||'—')+'</code>'+(j.serverMatchesBaseline?' · <span style="color:var(--ok)">live SHA збігається</span>':' · <span style="color:var(--bad)">live-файл дрейфував від baseline</span>');
    const lines=(j.textDiff&&j.textDiff.lines||[]),changed=lines.filter(line=>line.type!=='same').length,diff=lines.map(line=>'<span class="yaml-line '+esc(line.type)+'" '+(line.type==='same'?'data-yaml-same hidden':'')+'>'+esc((line.type==='add'?'+ ':line.type==='remove'?'- ':'  ')+line.text)+'</span>').join('');
    body.innerHTML='<div class="plan-result-head"><span class="pill">змінених рядків: '+changed+'</span><span class="pill">файлова транзакція</span></div><label class="muted" style="display:flex;align-items:center;gap:6px;margin:8px 0"><input id="yaml_show_same" type="checkbox" style="width:auto"> показати незмінені рядки</label><div class="yaml-diff">'+diff+'</div>'+(j.textDiff&&j.textDiff.truncated?'<div class="backup-state warn">Diff обрізано за безпечним лімітом.</div>':'')+'<div style="display:flex;justify-content:flex-end;margin-top:8px"><button id="text_open_merge">Відкрити merge та вибрати рішення →</button></div><div class="backup-state warn"><b>Важливо:</b> apply лише перезапише файл. Скрипт не запускається, контейнери не змінюються.</div>';
    document.getElementById('yaml_show_same').onchange=e=>body.querySelectorAll('[data-yaml-same]').forEach(line=>line.hidden=!e.target.checked);
    document.getElementById('text_open_merge').onclick=()=>openYamlLineDiff(j);
    setConfigReview(yamlPath,'viewed');
  }catch(e){meta.textContent='';body.innerHTML='<div class="backup-state bad">'+esc(e.message)+'</div>';}finally{clearInterval(loadingTimer);button.disabled=false;}
}
function openTextFor(path){if(!current){alert('Спершу вибери сервер.');return;}yamlPreviewMode='text';yamlGroup=currentGroup()||'rscore';yamlPath=path;loadYamlMergeDirect(false);}
function openConfigMergeFor(path){if(!current){alert('Спершу вибери сервер.');return;}yamlPreviewMode='json';yamlGroup=currentGroup()||'rscore';yamlPath=path;loadYamlMergeDirect(false);}
document.getElementById('yaml_close').onclick=()=>yamlDlg.close();
document.getElementById('yaml_refresh').onclick=()=>yamlPreviewMode==='text'?loadTextPreview(true):loadYamlPreview(true);
// ── Reconcile конфігу (dry-run, Фаза 1 MVP) ──
const reconcileDlg=document.getElementById('reconcileDlg');
let rcGroup='rscore';
const reconcileResultCache=new Map(),reconcileDecisionCache=new Map(),reconcileTargetCache=new Map();
const reconcileKey=(path)=>current+'\\n'+rcGroup+'\\n'+path;
function openReconcileFor(path){
  if(!current){alert('Спершу вибери сервер.');return;}
  rcGroup=(typeof currentGroup==='function'?currentGroup():'rscore')||'rscore';
  document.getElementById('rc_server').textContent='· '+current+' / '+rcGroup;
  if(path)document.getElementById('rc_path').value=path;
  document.getElementById('rc_body').innerHTML='';document.getElementById('rc_meta').textContent='';
  document.getElementById('rc_go').textContent=reconcileResultCache.has(reconcileKey(document.getElementById('rc_path').value.trim()))?'Оновити звірку':'Звірити';
  reconcileDlg.showModal();
  document.getElementById('rc_go').click(); // одразу звірити для обраного файлу
}
document.getElementById('rc_close').onclick=()=>reconcileDlg.close();
document.getElementById('rc_go').onclick=async event=>{
  const path=document.getElementById('rc_path').value.trim();
  const cacheKey=reconcileKey(path),force=!!event?.isTrusted;
  const meta=document.getElementById('rc_meta'),body=document.getElementById('rc_body');
  let usedCache=!force&&reconcileResultCache.has(cacheKey);
  meta.textContent=usedCache?'відновлюю останню звірку…':'звіряю…';body.innerHTML='';
  try{
    const previous=reconcileResultCache.get(cacheKey);
    const j=usedCache?previous:await apiJson('/api/reconcile?server='+encodeURIComponent(current)+'&group='+encodeURIComponent(rcGroup)+'&path='+encodeURIComponent(path)+(force?'&refresh=1':''));
    if(!usedCache){
      if(previous&&(previous.backupPlanId!==j.backupPlanId||previous.ref!==j.ref))reconcileDecisionCache.delete(cacheKey);
      for(const key of [...reconcileTargetCache.keys()])if(key.startsWith(cacheKey+'\\n'))reconcileTargetCache.delete(key);
      reconcileResultCache.set(cacheKey,j);
    }
    document.getElementById('rc_go').textContent='Оновити звірку';
    meta.innerHTML='installer <code>'+esc((j.ref||'').slice(0,8))+'</code> · '+esc(j.project||'')
      +' · baseline <code>'+esc(j.baselineId||j.backupPlanId||'—')+'</code> <span class="muted">'+esc(j.baselineKind==='transaction-baseline'?'verified transaction':'full backup')+'</span>'
      +(j.serverMatchesBackup?' · <span style="color:var(--ok)">live SHA збігається</span>':' · <span style="color:var(--bad)">live-файл змінився — target/apply заблоковано</span>')
      +(usedCache?' · <span class="muted">остання звірка</span>':'');
    const s=j.summary||{};
    const cap='<span style="color:var(--bad)">'+(s.conflict||0)+' змінено</span> · <span style="color:var(--mut)">'+(s['backup-only']||0)+' лише на сервері</span> · <span style="color:var(--ok)">'+(s['new-from-installer']||0)+' додає installer</span>'+(s['qa-override']?' · <span style="color:var(--acc)">'+s['qa-override']+' QA</span>':'');
    const fmt=v=>v===undefined?'':(typeof v==='string'?v:JSON.stringify(v));
    const RED='color-mix(in srgb,var(--bad) 15%,transparent)', GRN='color-mix(in srgb,var(--ok) 15%,transparent)';
    // side: 'l'=verified T0 backup, 'r'=installer. Для masked значення — reveal on-demand.
    const valInner=(side,key,value)=>{if(value===undefined)return '';const shown=fmt(value);
      if(j.masked&&value!=='(порожнє)')return '<span class="rc-reveal" data-side="'+(side==='l'?'backup':'installer')+'" data-key="'+escAttr(key)+'" title="Показати значення (клік)" style="cursor:pointer;border-bottom:1px dotted currentColor">'+esc(shown)+'</span>';
      return esc(shown);};
    const line=(side,key,value)=>esc(key)+(value===undefined?'':': ')+valInner(side,key,value);
    const cell=(side,mark,inner,bg)=>'<div style="background:'+(bg||'transparent')+';padding:0 8px;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;'+(side==='l'?'border-right:1px solid var(--bd)':'')+'"><span style="display:inline-block;width:10px;color:var('+(side==='l'?'--bad':'--ok')+')">'+(mark||'')+'</span>'+inner+'</div>';
    const dr=(l,r)=>'<div style="display:grid;grid-template-columns:1fr 1fr">'+l+r+'</div>';
    const build=list=>list.map(r=>{const k=r.key;
      if(r.verdict==='conflict') return dr(cell('l','-',line('l',k,r.backup),RED), cell('r','+',line('r',k,r.installer),GRN));
      if(r.verdict==='new-from-installer') return dr(cell('l','','',''), cell('r','+',line('r',k,r.installer),GRN));
      if(r.verdict==='backup-only') return dr(cell('l','-',line('l',k,r.backup),RED), cell('r','','',''));
      if(r.verdict==='qa-override') return dr(cell('l','',line('l',k,r.backup),''), cell('r','+',line('r',k,r.target),GRN));
      return dr(cell('l','',line('l',k,r.backup),''), cell('r','',line('r',k,r.installer),''));
    }).join('');
    const changes=(j.rows||[]).filter(r=>r.verdict!=='same'), sames=(j.rows||[]).filter(r=>r.verdict==='same');
    const head='<div style="display:grid;grid-template-columns:1fr 1fr;font-size:12px;background:var(--bg);border:1px solid var(--bd);border-bottom:none;border-radius:6px 6px 0 0"><div style="padding:5px 10px;color:var(--bad);border-right:1px solid var(--bd)">Verified baseline</div><div style="padding:5px 10px;color:var(--ok)">Installer target</div></div>';
    const box='<div style="font-family:ui-monospace,monospace;font-size:12px;line-height:1.9;border:1px solid var(--bd);border-radius:0 0 6px 6px;overflow:auto;max-height:52vh">'+(changes.length?build(changes):'<div class="muted" style="padding:8px">Усе збігається — змін нема.</div>')+'<div id="rc_same" hidden>'+build(sames)+'</div></div>';
    const maskNote=j.masked?'<div class="muted" style="font-size:12px;margin-bottom:6px">🔒 secret-файл — значення приховані, показано лише структуру (які параметри нові / зникли / змінились)</div>':'';
    body.innerHTML='<div class="muted" style="font-size:12px;margin-bottom:6px">'+cap+'</div>'+maskNote+head+box
      +(sames.length?'<label class="muted" style="font-size:12px;display:inline-flex;align-items:center;gap:6px;margin-top:8px;cursor:pointer"><input type="checkbox" id="rc_showsame" style="width:14px;height:14px;min-width:14px;margin:0;accent-color:var(--acc)"> показати однакові ('+sames.length+')</label>':'');
    const cb=document.getElementById('rc_showsame'); if(cb)cb.onchange=()=>{document.getElementById('rc_same').hidden=!cb.checked;};
    // reveal on-demand: клік → тягнемо одне значення, повторний клік — ховаємо (значення кешуємо в елементі)
    body.querySelectorAll('.rc-reveal').forEach(el=>{const masked=el.textContent;let real=null,shown=false;
      el.onclick=async()=>{
        if(shown){el.textContent=masked;el.style.opacity='';el.title='Показати значення (клік)';shown=false;return;}
        if(real===null){const prev=el.textContent;el.textContent='…';
          try{const jr=await apiJson('/api/reveal?server='+encodeURIComponent(current)+'&group='+encodeURIComponent(rcGroup)+'&path='+encodeURIComponent(path)+'&side='+el.dataset.side+'&key='+encodeURIComponent(el.dataset.key));real=jr.exists?String(jr.value):'(нема ключа)';}
          catch(e){el.textContent=prev;alert('reveal: '+e.message);return;}}
        el.textContent=real;el.style.opacity='.8';el.title='реальне значення (клік — сховати)';shown=true;
      };});
    // ── Рішення + компактний dynamic target; повний файл згорнутий окремо ──
    const conflicts=(j.rows||[]).filter(r=>r.verdict==='conflict');
    if(!conflicts.length)setConfigReview(path,'viewed');
    if(conflicts.length){
      const decisionStorageKey='standwatch.jsonDecisions.v1|'+[current,rcGroup,path,j.ref||'',j.baselineId||j.backupPlanId||''].map(x=>encodeURIComponent(String(x))).join('|');
      let persistedDecisions={};try{persistedDecisions=JSON.parse(localStorage.getItem(decisionStorageKey)||'{}')||{};}catch{}
      const decisions={...persistedDecisions,...(reconcileDecisionCache.get(cacheKey)||{})}; // key → 'server' | 'installer' | {value}
      const vals={};                                        // key → {sv, iv}
      const insp=v=>{const te=v.length-v.trimEnd().length,ls=v.length-v.trimStart().length;
        const dot=n=>'<span style="background:'+RED+';border-radius:2px">'+'·'.repeat(n)+'</span>';
        const shown=v===''?'<i>(порожнє)</i>':((ls?dot(ls):'')+esc(v.trim())+(te?dot(te):''));
        const notes=[];if(ls)notes.push('початковий пробіл');if(te)notes.push('кінцевий пробіл');
        return '<span style="font-family:ui-monospace,monospace">'+shown+'</span>'+(notes.length?' <span style="color:var(--warn)">— '+notes.join(', ')+'</span>':'')+' <span class="muted">· '+v.length+' симв.</span>';};
      const chip=(k,src,label)=>'<button type="button" class="rc-chip" data-k="'+escAttr(k)+'" data-src="'+src+'" style="border:1px solid var(--bd);border-radius:16px;padding:2px 10px;font-size:12px;background:var(--card);color:var(--fg);cursor:pointer">'+label+'</button>';
      const rowsHtml=conflicts.map(r=>{const k=r.key,sv=fmt(r.backup),iv=fmt(r.installer);vals[k]={sv,iv};
        if(j.masked&&decisions[k]===undefined){decisions[k]='server';} // секрет: дефолт — лишити значення з T0 backup
        const chips=j.masked
          ? chip(k,'server','лишити baseline')+chip(k,'installer','installer ⚠')+chip(k,'manual','вручну…')
          : chip(k,'server','baseline · '+esc(sv))+chip(k,'installer','installer · '+esc(iv));
        return '<div class="rc-dec" data-k="'+escAttr(k)+'" style="border:1px solid var(--bd);border-radius:8px;padding:8px 10px;margin-bottom:6px">'
          +'<div style="font-family:ui-monospace,monospace;font-weight:600;font-size:12px">'+esc(k)+(j.masked?' 🔒':'')+'</div>'
          +'<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:5px">'
          +'<input class="rc-dec-val" '+(j.masked?'placeholder="вручну, напр. $(pass …)" style="max-width:260px;display:none;padding:5px 7px"':'placeholder="обери або впиши…" style="max-width:260px;padding:5px 7px"')+'>'
          +chips+'<span class="rc-dec-ok" style="margin-left:auto;color:var(--ok);font-size:12px"></span></div>'
          +'<div class="rc-dec-insp muted" style="font-size:11px;margin-top:4px"></div></div>';}).join('');
      body.insertAdjacentHTML('beforeend','<div id="rc_decwrap" style="margin-top:14px">'
        +'<div style="font-size:11px;font-weight:600;letter-spacing:.04em;color:var(--mut);text-transform:uppercase;margin-bottom:8px">Рішення по конфліктах</div>'+rowsHtml
        +'<div style="border:1px solid var(--bd);border-radius:8px;background:color-mix(in srgb,var(--acc) 5%,var(--card));padding:9px 10px;margin-top:10px">'
        +'<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px"><b style="font-size:12px">Цільові зміни</b><span id="rc_target_status" class="muted" style="font-size:11px;margin-left:auto">обери рішення</span></div>'
        +'<div id="rc_target_changes" style="display:grid;gap:4px;font-size:12px"></div></div>'
        +'<div style="display:flex;align-items:center;gap:10px;margin-top:8px;flex-wrap:wrap"><span id="rc_dec_count" class="muted" style="font-size:12px"></span>'
        +'<button type="button" id="rc_full_toggle" style="margin-left:auto" disabled>Переглянути весь файл</button>'
        +'<button type="button" id="rc_apply" disabled style="font-weight:700">Застосувати JSON…</button></div>'
        +'<div id="rc_apply_status" style="margin-top:8px"></div>'
        +'<div id="rc_full_wrap" hidden style="margin-top:8px"><div class="muted" style="font-size:11px;margin-bottom:5px">Повний dry-run · змінені рядки підсвічені</div>'
        +'<pre id="rc_target" style="max-height:28vh;overflow:auto;border:1px solid var(--bd);border-radius:8px;padding:6px 0;white-space:pre;font-family:ui-monospace,monospace;font-size:12px"></pre></div></div>');
      const wrap=document.getElementById('rc_decwrap');
      wrap.querySelectorAll('.rc-dec').forEach(row=>{const d=decisions[row.dataset.k],inp=row.querySelector('.rc-dec-val');if(d&&typeof d==='object'){inp.value=d.value;inp.style.display='';}else if(d==='server'||d==='installer'){inp.value=vals[row.dataset.k][d==='installer'?'iv':'sv'];}});
      const valueFor=k=>{const d=decisions[k];if(d&&typeof d==='object')return d.value;if(d==='installer')return vals[k].iv;if(d==='server')return vals[k].sv;return undefined;};
      let validateTimer=null,validateSeq=0,targetCache=null;
      const changedLeafNames=new Set(conflicts.map(r=>r.key.split('.').pop().replace(/\\[\\d+\\]$/,'')));
      const renderFull=()=>{const out=document.getElementById('rc_target');if(!targetCache){out.textContent='';return;}
        out.innerHTML=String(targetCache.target||'').split('\\n').map(line=>{const m=/^\\s*"((?:\\\\.|[^"\\\\])+)"\\s*:/.exec(line);let key='';
          if(m){try{key=JSON.parse('"'+m[1]+'"');}catch{key=m[1];}}
          const hit=changedLeafNames.has(key),style='display:block;padding:0 9px;'+(hit?'background:color-mix(in srgb,var(--warn) 22%,transparent);border-left:3px solid var(--warn);color:var(--fg);':'border-left:3px solid transparent;');
          return '<span style="'+style+'">'+(esc(line)||'&nbsp;')+'</span>';}).join('');};
      const validateTarget=async()=>{const seq=++validateSeq,status=document.getElementById('rc_target_status'),toggle=document.getElementById('rc_full_toggle'),apply=document.getElementById('rc_apply');
        status.textContent='перевіряю типи…';status.style.color='var(--mut)';toggle.disabled=true;apply.disabled=true;
        try{const targetKey=cacheKey+'\\n'+JSON.stringify(decisions);const jr=reconcileTargetCache.has(targetKey)?reconcileTargetCache.get(targetKey):await apiJson('/api/reconcile/target',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({server:current,group:rcGroup,path,decisions})});if(seq!==validateSeq)return;
          if(jr.ok===false&&jr.unresolved)throw new Error('не вирішено: '+jr.unresolved.join(', '));
          if(jr.ok===false&&jr.invalid)throw new Error(jr.invalid.key+': '+jr.invalid.message);
          reconcileTargetCache.set(targetKey,jr);
          targetCache=jr;status.textContent='✓ типи перевірено';status.style.color='var(--ok)';toggle.disabled=false;apply.disabled=false;
          if(!document.getElementById('rc_full_wrap').hidden)renderFull();
        }catch(e){if(seq!==validateSeq)return;targetCache=null;status.textContent='⚠ '+e.message;status.style.color='var(--bad)';toggle.disabled=true;renderFull();}};
      const scheduleValidate=()=>{clearTimeout(validateTimer);const done=conflicts.every(r=>decisions[r.key]!==undefined);if(!done){validateSeq++;targetCache=null;document.getElementById('rc_target_status').textContent='обери всі рішення';document.getElementById('rc_target_status').style.color='var(--mut)';document.getElementById('rc_full_toggle').disabled=true;document.getElementById('rc_apply').disabled=true;return;}validateTimer=setTimeout(validateTarget,350);};
      const refresh=()=>{
        wrap.querySelectorAll('.rc-dec').forEach(row=>{const k=row.dataset.k,d=decisions[k];
          row.querySelectorAll('.rc-chip').forEach(c=>{const on=(c.dataset.src===d)||(c.dataset.src==='manual'&&d&&typeof d==='object');c.style.background=on?'var(--acc)':'var(--card)';c.style.color=on?'#fff':'var(--fg)';c.style.borderColor=on?'var(--acc)':'var(--bd)';});
          const ok=row.querySelector('.rc-dec-ok'),ins=row.querySelector('.rc-dec-insp');
          const resolved=d!==undefined;ok.textContent=resolved?'✓':'';
          if(!resolved){ins.innerHTML='';}
          else if(j.masked){ins.innerHTML=(typeof d==='object')?('піде: '+insp(d.value||'')):('піде: <span style="font-family:ui-monospace,monospace">••••••</span> <span class="muted">('+(d==='installer'?'installer':'baseline')+', приховано)</span>');}
          else{ins.innerHTML='піде: '+insp(String(valueFor(k)));}});
        const done=conflicts.filter(r=>decisions[r.key]!==undefined).length;
        const hasUnpersistableSecret=[...Object.values(decisions)].some(value=>value&&typeof value==='object')&&j.masked;
        setConfigReview(path,done===conflicts.length?'selected':null,!hasUnpersistableSecret);
        document.getElementById('rc_dec_count').innerHTML=conflicts.length+' конфл. · <span style="color:var(--ok)">'+done+' вирішено</span>'+(done<conflicts.length?' · <span style="color:var(--bad)">'+(conflicts.length-done)+' лишилось</span>':'');
        document.getElementById('rc_target_changes').innerHTML=conflicts.map(r=>{const value=valueFor(r.key),resolved=value!==undefined;
          return '<div style="display:grid;grid-template-columns:minmax(220px,360px) 16px minmax(72px,160px);justify-content:start;gap:6px;align-items:center"><code style="overflow-wrap:anywhere">'+esc(r.key)+'</code><span class="muted" style="text-align:center">'+(resolved?'→':'…')+'</span><code style="padding:2px 7px;border-radius:5px;background:'+(resolved?'color-mix(in srgb,var(--warn) 18%,transparent)':'transparent')+';color:'+(resolved?'var(--warn)':'var(--mut)')+'">'+(resolved?esc(String(value)):'не вибрано')+'</code></div>';}).join('');
        reconcileDecisionCache.set(cacheKey,JSON.parse(JSON.stringify(decisions)));
        const durable={};for(const [key,value] of Object.entries(decisions))if(typeof value==='string'||(!j.masked&&value&&typeof value==='object'))durable[key]=value;
        try{localStorage.setItem(decisionStorageKey,JSON.stringify(durable));}catch{}
        scheduleValidate();
      };
      wrap.addEventListener('click',e=>{const c=e.target.closest('.rc-chip');if(!c)return;const k=c.dataset.k,src=c.dataset.src,row=c.closest('.rc-dec'),inp=row.querySelector('.rc-dec-val');
        if(src==='manual'){inp.style.display='';decisions[k]={value:inp.value};inp.focus();}
        else{decisions[k]=src;if(!j.masked){inp.value=vals[k][src==='installer'?'iv':'sv'];}if(j.masked)inp.style.display='none';}
        refresh();});
      wrap.addEventListener('input',e=>{const inp=e.target.closest('.rc-dec-val');if(!inp)return;const k=inp.closest('.rc-dec').dataset.k;decisions[k]={value:inp.value};refresh();});
      document.getElementById('rc_full_toggle').onclick=()=>{const area=document.getElementById('rc_full_wrap'),btn=document.getElementById('rc_full_toggle');area.hidden=!area.hidden;btn.textContent=area.hidden?'Переглянути весь файл':'Сховати повний файл';if(!area.hidden)renderFull();};
      document.getElementById('rc_apply').onclick=async()=>{const btn=document.getElementById('rc_apply'),status=document.getElementById('rc_apply_status');
        if(!targetCache)return;btn.disabled=true;status.innerHTML='<div class="backup-state warn">Перевіряю live SHA і право atomic write…</div>';
        try{const payload={server:current,group:rcGroup,path,decisions};const pre=await apiJson('/api/reconcile/prepare',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
          if(!pre.prepareReady){const failed=Object.entries(pre.gates||{}).filter(([,v])=>!v).map(([k])=>k).join(', '),detail=pre.prerequisites&&pre.prerequisites.error?(' · '+pre.prerequisites.error):'';
            if(pre.gates&&pre.gates.remoteToolsReady===false){status.innerHTML='<div class="backup-state warn"><b>Потрібне одноразове системне налаштування сервера.</b> Після підтвердження preflight повториться автоматично.</div>';btn.disabled=false;openPermissionsSetup({path,onSuccess:()=>{status.innerHTML='<div class="backup-state ok"><b>✓ Сервер підготовлено.</b> Повторюю preflight файла…</div>';setTimeout(()=>btn.click(),0);}});return;}
            throw new Error('preflight заблокував apply: '+failed+detail);}
          if(!confirm('Атомарно перезаписати JSON-файл на '+current+'?\\n\\nФайл: '+pre.absolutePath+'\\nTarget SHA: '+pre.hashes.target.slice(0,12)+'…\\n\\nПеред записом буде створено T2 snapshot. Контейнери НЕ оновлюються і НЕ перезапускаються.')){status.innerHTML='';btn.disabled=false;return;}
          status.innerHTML='<div class="backup-state warn"><b>Файлова транзакція…</b> T2 snapshot → atomic write → SHA verify. Контейнери не чіпаємо.</div>';
          const applied=await apiJson('/api/reconcile/apply',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
          status.innerHTML='<div class="backup-state ok"><b>✓ JSON-файл атомарно оновлено.</b> Контейнери не змінювалися.<br>Транзакція <code>'+esc(applied.transactionId)+'</code> · SHA <code>'+esc(applied.hashes.target.slice(0,12))+'…</code><br><button type="button" id="rc_rollback" class="ghost" style="margin-top:8px">↶ Відкотити файл до T2</button></div>';
          btn.textContent='Застосовано';reconcileResultCache.delete(cacheKey);for(const key of [...reconcileTargetCache.keys()])if(key.startsWith(cacheKey+'\\n'))reconcileTargetCache.delete(key);
          document.getElementById('rc_rollback').onclick=async e=>{const rb=e.currentTarget;if(!confirm('Відкотити лише файл до стану T2? Контейнери не перезапускатимуться.'))return;rb.disabled=true;rb.textContent='Відкочую…';
            try{const rolled=await apiJson('/api/reconcile/rollback',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({transactionId:applied.transactionId})});status.innerHTML='<div class="backup-state ok"><b>✓ Файл відновлено з T2.</b> SHA <code>'+esc(rolled.hash.slice(0,12))+'…</code>. Контейнери не змінювалися.</div>';btn.textContent='Застосувати JSON…';btn.disabled=false;reconcileResultCache.delete(cacheKey);}
            catch(e){status.innerHTML='<div class="backup-state bad"><b>Rollback не завершено:</b> '+esc(e.message)+'</div>';rb.disabled=false;rb.textContent='↶ Повторити rollback';}};
        }catch(e){status.innerHTML='<div class="backup-state bad"><b>Apply не завершено:</b> '+esc(e.message)+'</div>';btn.disabled=false;}
      };
      refresh();
    }
  }catch(e){meta.textContent='';body.innerHTML='<p class="st FAILURE">'+esc(e.message)+'</p>';}
};
function closePlan(){planDlg.hidden=true;document.body.classList.remove('plan-open');}
function showPlanMessage(text,bad=false){document.getElementById('p_table').innerHTML='<div style="padding:18px" class="'+(bad?'st FAILURE':'muted')+'">'+esc(text)+'</div>';}
async function refreshCurrentPlan(){
  const value=await apiJson('/api/installer/plan?server='+encodeURIComponent(current)+'&group='+encodeURIComponent(currentGroup()));
  installerState.currentPlan=value;
  const button=document.getElementById('p_view_plan');button.hidden=!value.plan;
  if(value.plan){button.textContent=value.serverUnchanged?'Переглянути поточний план':'⚠ План застарів';button.classList.toggle('drift',!value.serverUnchanged);}
  const formButton=document.getElementById('p_execute');formButton.textContent=value.plan&&value.serverUnchanged?'Переформувати план':'Сформувати план';
  return value;
}
function openCurrentPlan(){
  const value=installerState.currentPlan;if(!value||!value.plan)return;
  const p=value.plan,services=p.services||[],changes=services.filter(x=>x.status==='change'),problems=services.filter(x=>x.status==='unknown'||x.status==='unmanaged'),cmp=p.configComparison||{},cc=cmp.counts||{},pre=p.backupPreflight||{},db=pre.databaseCandidates||[],backup=p.backup||{status:'not-created'},restore=p.restore||{status:'not-tested'};
  document.getElementById('plan_result_id').textContent='· '+value.id;
  const stale=value.serverUnchanged?'':'<div class="plan-result-stale"><b>План застарів:</b> стан сервера змінився після формування.'+(value.changedServices||[]).slice(0,6).map(x=>'<div><code>'+esc(x.image)+'</code>: '+esc(x.planned||'—')+' → '+esc(x.current||'—')+'</div>').join('')+'</div>';
  const serviceRows=changes.concat(problems).map(x=>'<tr><td><b>'+esc(x.image)+'</b></td><td class="server-cell"><code>'+esc(x.current||'—')+'</code></td><td class="installer-cell"><code>'+esc(x.target||'—')+'</code></td><td>'+esc(x.reason||x.status)+'</td></tr>').join('');
  installerCatalog.filePolicies=installerCatalog.filePolicies||{};
  const filePolicyKey=path=>p.server+'|'+p.group+'|'+p.target.project+'|'+path;
  let configAttention=0,configReviewed=0;
  const fileRows=(cmp.files||[]).slice(0,100).map(x=>{const policy=installerCatalog.filePolicies[filePolicyKey(x.path)]||x.policy||'managed',attention=policy!=='ignored'&&(x.status==='different'||x.status==='missing'),storedReview=configReviewState(x.path),review=storedReview==='selected'&&!completeFileMergeDraft(readFileMergeDraft(x.path))?'':storedReview;if(attention){configAttention++;if(review==='selected'||review==='viewed')configReviewed++;}const reviewClass=policy==='ignored'?'ignored':review==='selected'?'selected':review==='viewed'?'viewed':attention?'pending':'viewed',reviewLabel=policy==='ignored'?'⊘ Ігнорується':review==='selected'?'✓ Рішення вибрано':review==='viewed'?'✓ Переглянуто':attention?'○ До перевірки':'✓ Без дій';const _b=String(x.path).split('/').pop().toLowerCase(),isYaml=_b.endsWith('.yaml')||_b.endsWith('.yml'),isScript=String(x.path).startsWith('scripts/')&&_b.endsWith('.sh'),isJson=_b.endsWith('.json'),isEnv=_b==='.env'||_b.startsWith('.env.')||_b.endsWith('.env'),reconcilable=policy!=='ignored'&&(isJson||isEnv),clickable=(reconcilable||isYaml||isScript)&&policy!=='ignored'&&attention;const lock=x.secret?'<span title="secret-файл: значення маскуються">🔒</span>':'';const linkClass=isYaml?'yaml-file':isScript?'text-file':isJson?'merge-json-file':'rc-file',linkTitle=isEnv?'Переглянути структуру secret-файла без відкриття значень':'Порівняти повні файли та вибрати ціль',actionLabel=isEnv?'Переглянути без секретів →':'Відкрити merge →',action=clickable?'<button type="button" class="file-action '+linkClass+'" data-path="'+escAttr(x.path)+'" title="'+linkTitle+'">⇄ '+actionLabel+'</button>':'';const pathCell='<div class="file-target">'+lock+'<code title="'+escAttr(x.path)+'">'+esc(x.path)+'</code>'+action+'</div>';return'<tr><td>'+pathCell+'</td><td><span class="file-review '+reviewClass+'" data-config-review="'+escAttr(x.path)+'" data-attention="'+(attention?'1':'0')+'" data-review-state="'+escAttr(review)+'">'+esc(reviewLabel)+'</span></td><td><select class="file-policy policy-'+escAttr(policy)+'" title="Політика обробки цього файла" data-file-policy="'+escAttr(x.path)+'"><option value="managed" '+(policy==='managed'?'selected':'')+'>⚙ Керований</option><option value="observe-only" '+(policy==='observe-only'?'selected':'')+'>◉ Лише дивитись</option><option value="ignored" '+(policy==='ignored'?'selected':'')+'>⊘ Ігнорувати</option></select></td></tr>';}).join('');
  document.getElementById('plan_result_body').innerHTML=stale+'<div class="plan-result-head"><span class="pill">'+esc(p.status)+'</span><span class="pill">'+esc(p.server)+' · '+esc(p.group)+'</span><span class="pill">'+esc(p.target.project)+' @ '+esc(p.target.commit.shortId)+'</span><span class="pill">'+esc(p.installRoot)+'</span></div>'
    +'<div class="plan-result-section"><h4>Зміни сервісів: '+changes.length+' · проблеми: '+problems.length+'</h4><div class="source-legend"><span class="source-key server">● На сервері зараз</span><span class="source-key installer">◆ Передбачено installer</span></div>'+(serviceRows?'<table class="plan-result-table"><thead><tr><th>Сервіс</th><th class="server-col">● Сервер зараз</th><th class="installer-col">◆ Installer target</th><th>Причина</th></tr></thead><tbody>'+serviceRows+'</tbody></table>':'<span class="muted">Змін немає.</span>')+'</div>'
    +'<div class="plan-result-section"><h4 class="config-title">Конфігурації <span id="config_attention_count" class="review-count attention">потребують уваги: '+configAttention+'</span><span id="config_reviewed_count" class="review-count reviewed">опрацьовано: '+configReviewed+' / '+configAttention+'</span></h4>'+(fileRows?'<table class="plan-result-table config-table"><thead><tr><th>Файл і дія</th><th>Опрацювання</th><th>Політика</th></tr></thead><tbody>'+fileRows+'</tbody></table>':'')+'</div>'
    +'<div class="plan-result-section"><h4>Backup і відновлення</h4><div>Директорії для архіву: '+esc((pre.directories||[]).map(x=>x.name+' '+(x.exists?'✓':'—')).join(', ')||'—')+'</div><div>Контейнери: '+esc(pre.containerCount||0)+' · mounts: '+esc(pre.mountCount||0)+'</div><div><b>Виявлені DB-контейнери:</b> '+esc(db.map(x=>x.name+' ('+x.image+')').join(', ')||'немає')+'</div>'
    +(backup.status==='verified'?'<div class="backup-state ok"><b>✓ Локальний backup створено і перевірено.</b><br>DB dump: '+esc((backup.database&&backup.database.dumped||[]).join(', ')||'DB не виявлено')+' · артефактів: '+esc((backup.artifacts||[]).length)+'<br><span class="muted">'+esc(backup.directory||'')+'</span></div>':backup.status==='failed'?'<div class="backup-state bad"><b>✕ Backup не створено.</b> '+esc(backup.error||'невідома помилка')+'</div>':'<div class="backup-state warn"><b>⚠ Це лише виявлення.</b> Дані БД ще не збережені; відкат із цього плану поки неможливий.</div>')
    +(restore.status==='restore-tested'?'<div class="backup-state ok"><b>✓ Restore-test пройдено.</b> Dump розгорнуто в ізольований PostgreSQL; roles, databases, extensions і таблиці збігаються.</div>':restore.status==='restore-failed'?'<div class="backup-state bad"><b>✕ Restore-test не пройдено.</b> '+esc(restore.error||'дивись журнал')+'</div>':'')
    +((restore.unprotectedVolumes||backup.unprotectedVolumes||[]).length?'<div class="backup-state warn"><b>⚠ Destructive drill заблоковано:</b> не захищені Docker volumes: '+esc((restore.unprotectedVolumes||backup.unprotectedVolumes).map(x=>x.container+':'+(x.name||x.destination)).join(', '))+'. Потрібна backup/restore policy для кожного.</div>':'')
    +'<div class="muted">Deploy: '+esc(p.deploy&&p.deploy.status)+'</div></div>';
  const backupButton=document.getElementById('plan_backup');
  backupButton.disabled=!value.serverUnchanged||backup.status==='verified';
  backupButton.textContent=backup.status==='verified'?'✓ Backup готовий':backup.status==='creating'?'Повторити незавершений backup':value.serverUnchanged?'Створити локальний backup':'План застарів — backup заблоковано';
  const restoreButton=document.getElementById('plan_restore_test');restoreButton.hidden=backup.status!=='verified';restoreButton.disabled=!value.serverUnchanged||restore.status==='restore-tested';restoreButton.textContent=restore.status==='restore-tested'?'✓ Restore перевірено':restore.status==='restore-failed'?'Повторити restore-test':'Перевірити відновлення БД';
  document.getElementById('plan_backup_status').innerHTML='';document.getElementById('plan_restore_status').innerHTML='';document.getElementById('plan_config_apply_detail').innerHTML='';
  const packageButton=document.getElementById('plan_apply_configs'),debugPackageButton=document.getElementById('plan_debug_apply_configs'),packageStatus=document.getElementById('plan_config_apply_status');
  const packageCandidates=(cmp.files||[]).filter(x=>{const policy=installerCatalog.filePolicies[filePolicyKey(x.path)]||x.policy||'managed';return policy==='managed'&&(x.status==='different'||x.status==='missing');});
  const packageFiles=[],packagePending=[];
  for(const item of packageCandidates){const lower=String(item.path).toLowerCase(),supported=((lower.startsWith('home/')||lower.startsWith('volumes/config/'))&&(lower.endsWith('.json')||lower.endsWith('.yaml')||lower.endsWith('.yml')))||(lower.startsWith('scripts/')&&lower.endsWith('.sh')),draft=readFileMergeDraft(item.path);if(!supported)packagePending.push(item.path+' (тип поки не підтримано)');else if(configReviewState(item.path)!=='selected'||!completeFileMergeDraft(draft))packagePending.push(item.path);else packageFiles.push({path:item.path,decisions:draft.decisions});}
  packageButton.disabled=!value.serverUnchanged||backup.status!=='verified'||!!packagePending.length||!packageFiles.length;
  debugPackageButton.disabled=packageButton.disabled;
  packageButton.textContent=packagePending.length?'Спершу опрацювати: '+packagePending.length:packageFiles.length?'Застосувати лише зміни: '+packageFiles.length:'Нема вибраних конфігів';
  debugPackageButton.textContent=packagePending.length?'🧪 DEBUG недоступний: '+packagePending.length:'🧪 DEBUG: перезаписати всі '+packageFiles.length;
  packageStatus.textContent=!value.serverUnchanged?'план застарів':backup.status!=='verified'?'спочатку потрібен verified backup':packagePending.length?'не опрацьовано '+packagePending.length+' керованих файлів':packageFiles.length+' файлів готові до preflight';
  const permissionsPath=(packageFiles[0]&&packageFiles[0].path)||(packageCandidates[0]&&packageCandidates[0].path);
  const onlySystemSetupBlocked=(blocked,debugMode)=>blocked.length>0&&blocked.every(file=>file.gates&&file.gates.remoteToolsReady===false&&Object.entries(file.gates).filter(([name,ok])=>!ok&&(!debugMode||name!=='targetDiffers')).every(([name])=>name==='remoteToolsReady'));
  const requestPackageSystemSetup=retry=>{const detail=document.getElementById('plan_config_apply_detail');detail.innerHTML='<div class="backup-state warn"><b>Потрібне одноразове системне налаштування сервера.</b><br>SSH і контейнери вже визначені. Після підтвердження StandWatch сам повторить preflight.</div>';openPermissionsSetup({path:permissionsPath,onSuccess:()=>{detail.innerHTML='<div class="backup-state ok"><b>✓ Сервер підготовлено.</b> Повторюю preflight…</div>';setTimeout(retry,0);}});};
  apiJson('/api/reconcile/file/batch/latest?server='+encodeURIComponent(current)+'&group='+encodeURIComponent(currentGroup())).then(latest=>{if(!latest.available)return;const detail=document.getElementById('plan_config_apply_detail');if(detail.innerHTML)return;detail.innerHTML='<div class="backup-state ok"><b>Останній файловий пакет застосовано.</b><br>Batch <code>'+esc(latest.batchId)+'</code> · файлів: '+esc(latest.files.length)+'<br><button type="button" id="plan_rollback_latest" class="ghost" style="margin-top:7px">↶ Відкотити весь пакет до T2</button></div>';document.getElementById('plan_rollback_latest').onclick=async event=>{const button=event.currentTarget;if(!confirm('Відкотити всі '+latest.files.length+' файлів пакета до їхніх T2 snapshot? Контейнери не перезапускатимуться.'))return;button.disabled=true;const failures=[];for(const item of [...latest.files].reverse()){try{await apiJson('/api/reconcile/rollback',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({transactionId:item.transactionId})});}catch(e){failures.push(item.path+': '+e.message);}}detail.innerHTML=failures.length?'<div class="backup-state bad"><b>Пакетний rollback неповний:</b><br>'+failures.map(esc).join('<br>')+'</div>':'<div class="backup-state ok"><b>✓ Увесь пакет відновлено з T2.</b> Контейнери не змінювалися.</div>';};}).catch(()=>{});
  packageButton.onclick=async()=>{const detail=document.getElementById('plan_config_apply_detail'),payload={server:current,group:currentGroup(),files:packageFiles};packageButton.disabled=true;detail.innerHTML='<div class="backup-state warn"><b>Пакетний preflight…</b> Перевіряю baseline, live SHA, target і права запису для кожного файла.</div>';
    try{const pre=await apiJson('/api/reconcile/file/batch/prepare',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
      if(!pre.prepareReady){const blocked=(pre.files||[]).filter(file=>!file.ready);packageButton.disabled=false;if(onlySystemSetupBlocked(blocked,false)){requestPackageSystemSetup(()=>packageButton.click());return;}detail.innerHTML='<div class="backup-state bad"><b>Пакет заблоковано.</b><br>'+blocked.map(file=>esc(file.path)+': '+esc(Object.entries(file.gates||{}).filter(([,ok])=>!ok).map(([name])=>name).join(', '))).join('<br>')+'</div>';return;}
      if(!pre.changeCount){detail.innerHTML='<div class="backup-state ok"><b>Змінювати нічого.</b> Для всіх файлів у підготовленому пакеті вибрано серверний варіант.</div>';packageButton.disabled=false;return;}
      if(!confirm('Застосувати пакет конфігів на '+current+'?\\n\\nБуде змінено файлів: '+pre.changeCount+'\\nБез змін: '+pre.unchangedCount+'\\n\\nДля кожного файла створюється T2 snapshot. При помилці вже записані файли відкочуються. Контейнери НЕ оновлюються і НЕ перезапускаються.')){detail.innerHTML='';packageButton.disabled=false;return;}
      detail.innerHTML='<div class="backup-state warn"><b>Застосовую пакет…</b> T2 → atomic write → SHA verify для кожного файла.</div>';
      const applied=await apiJson('/api/reconcile/file/batch/apply',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
      detail.innerHTML='<div class="backup-state ok"><b>✓ Пакет застосовано: '+esc(applied.applied.length)+' файлів.</b> Контейнери не змінювалися.<br>Batch <code>'+esc(applied.batchId||'—')+'</code>'+(applied.skipped&&applied.skipped.length?'<br>Без змін: '+applied.skipped.map(esc).join(', '):'')+'<br><button type="button" id="plan_rollback_package" class="ghost" style="margin-top:7px">↶ Відкотити весь пакет до T2</button></div>';packageButton.textContent='✓ Пакет застосовано';
      document.getElementById('plan_rollback_package').onclick=async event=>{const button=event.currentTarget;if(!confirm('Відкотити всі файли пакета до їхніх T2 snapshot? Контейнери не перезапускатимуться.'))return;button.disabled=true;const failures=[];for(const item of [...applied.applied].reverse()){try{await apiJson('/api/reconcile/rollback',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({transactionId:item.transactionId})});}catch(e){failures.push(item.path+': '+e.message);}}detail.innerHTML=failures.length?'<div class="backup-state bad"><b>Пакетний rollback неповний:</b><br>'+failures.map(esc).join('<br>')+'</div>':'<div class="backup-state ok"><b>✓ Увесь пакет відновлено з T2.</b> Контейнери не змінювалися.</div>';};
    }catch(e){detail.innerHTML='<div class="backup-state bad"><b>Пакет не застосовано:</b> '+esc(e.message)+'</div>';packageButton.disabled=false;}};
  debugPackageButton.onclick=async()=>{const detail=document.getElementById('plan_config_apply_detail'),payload={server:current,group:currentGroup(),files:packageFiles,debugForceWrite:true};debugPackageButton.disabled=true;detail.innerHTML='<div class="backup-state warn"><b>DEBUG preflight усіх файлів…</b> Перевіряю baseline, live SHA, ціль і постійні права для кожного файла.</div>';
    try{const pre=await apiJson('/api/reconcile/file/batch/prepare',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
      if(!pre.prepareReady){const blocked=(pre.files||[]).filter(file=>!file.ready);debugPackageButton.disabled=false;if(onlySystemSetupBlocked(blocked,true)){requestPackageSystemSetup(()=>debugPackageButton.click());return;}detail.innerHTML='<div class="backup-state bad"><b>DEBUG-пакет заблоковано.</b><br>'+blocked.map(file=>esc(file.path)+': '+esc(Object.entries(file.gates||{}).filter(([name,ok])=>!ok&&name!=='targetDiffers').map(([name])=>name).join(', '))).join('<br>')+'</div>';return;}
      if(!confirm('DEBUG-перезаписати ВСІ '+pre.writeCount+' керованих файлів на '+current+'?\\n\\nРеально відрізняються: '+pre.changeCount+'\\nБайт-в-байт збігаються: '+pre.unchangedCount+'\\n\\nНавіть незмінні файли отримають T2 snapshot та atomic rewrite. Контейнери НЕ оновлюються і НЕ перезапускаються.')){detail.innerHTML='';debugPackageButton.disabled=false;return;}
      payload.debugConfirmation='REWRITE_ALL_MANAGED_FILES';detail.innerHTML='<div class="backup-state warn"><b>DEBUG: перезаписую всі файли…</b> T2 → atomic write → SHA verify для кожного файла.</div>';
      const applied=await apiJson('/api/reconcile/file/batch/apply',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
      detail.innerHTML='<div class="backup-state ok"><b>✓ DEBUG-пакет перезаписано: '+esc(applied.applied.length)+' файлів.</b> Контейнери не змінювалися.<br>Незмінних примусово перезаписано: '+esc(applied.forcedUnchangedCount||0)+'<br>Batch <code>'+esc(applied.batchId||'—')+'</code><br><button type="button" id="plan_rollback_package" class="ghost" style="margin-top:7px">↶ Відкотити весь DEBUG-пакет до T2</button></div>';debugPackageButton.textContent='✓ DEBUG-пакет записано';
      document.getElementById('plan_rollback_package').onclick=async event=>{const button=event.currentTarget;if(!confirm('Відкотити всі файли DEBUG-пакета до їхніх T2 snapshot? Контейнери не перезапускатимуться.'))return;button.disabled=true;const failures=[];for(const item of [...applied.applied].reverse()){try{await apiJson('/api/reconcile/rollback',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({transactionId:item.transactionId})});}catch(e){failures.push(item.path+': '+e.message);}}detail.innerHTML=failures.length?'<div class="backup-state bad"><b>DEBUG rollback неповний:</b><br>'+failures.map(esc).join('<br>')+'</div>':'<div class="backup-state ok"><b>✓ Увесь DEBUG-пакет відновлено з T2.</b> Контейнери не змінювалися.</div>';};
    }catch(e){detail.innerHTML='<div class="backup-state bad"><b>DEBUG-пакет не застосовано:</b> '+esc(e.message)+'</div>';debugPackageButton.disabled=false;}};
  document.querySelectorAll('#plan_result_body .rc-file').forEach(a=>a.onclick=e=>{e.preventDefault();openReconcileFor(a.dataset.path);});
  document.querySelectorAll('#plan_result_body .merge-json-file').forEach(a=>a.onclick=e=>{e.preventDefault();openConfigMergeFor(a.dataset.path);});
  document.querySelectorAll('#plan_result_body .yaml-file').forEach(a=>a.onclick=e=>{e.preventDefault();openYamlFor(a.dataset.path);});
  document.querySelectorAll('#plan_result_body .text-file').forEach(a=>a.onclick=e=>{e.preventDefault();openTextFor(a.dataset.path);});
  document.querySelectorAll('#plan_result_body [data-file-policy]').forEach(select=>select.onchange=()=>{const key=filePolicyKey(select.dataset.filePolicy),value=select.value;if(value==='managed')delete installerCatalog.filePolicies[key];else installerCatalog.filePolicies[key]=value;saveCatalog();openCurrentPlan();});
  document.getElementById('planResultDlg').showModal();
}
function updatePlanSetupSummary(){
  const b=installerState.binding||{},group=currentGroup(),root=document.getElementById('p_install_root').value||b.installRoot||'',s=installerState.snapshot;
  if(document.getElementById('p_mode').value!=='installer'){document.getElementById('p_setup_summary').textContent=group+' · ручний режим';return;}
  const source=s?(document.getElementById('p_source').value==='installer_branch'?(document.getElementById('p_branch').value+' @ '+s.commit.shortId):('tag '+(document.getElementById('p_baseline').value||s.commit.shortId))):(b.commit?((b.sourceKind==='branch'?(b.sourceName+' @ '):'tag ')+b.commit.shortId):'ціль не вибрано');
  document.getElementById('p_setup_summary').textContent=[group,source,root,installerState.scopeFiles.length?(installerState.scopeFiles.length+' compose'):'scope не вибрано'].filter(Boolean).join(' · ');
}
async function loadBinding(){
  installerState.binding=(await apiJson('/api/installer/binding?server='+encodeURIComponent(current)+'&group='+encodeURIComponent(currentGroup()))).binding;
  document.getElementById('p_mode').value=installerState.binding.mode==='installer'?'installer':'dev';
  await syncPlanMode();
  updatePlanSetupSummary();
}
async function openPlan(initialFilter='all'){
  if(typeof initialFilter!=='string')initialFilter='all';
  if(!current||!lastRows.length){alert('Спочатку відкрий сервер із доступним scan.');return;}
  planDlg.hidden=false;document.body.classList.add('plan-open');document.getElementById('p_server').textContent='· '+current;
  const groups=[...new Set(lastRows.map(groupOf))].sort();
  document.getElementById('p_group').innerHTML=groups.map(x=>'<option value="'+esc(x)+'">'+esc(x)+'</option>').join('');
  planFilter=['all','change','problem'].includes(initialFilter)?initialFilter:'all';document.querySelectorAll('.planfilter').forEach(x=>x.classList.toggle('active',x.dataset.pf===planFilter));
  showPlanMessage('Завантажую прив’язку installer…');
  try{await loadBinding();await refreshCurrentPlan();document.getElementById('p_setup').open=!(installerState.binding&&installerState.binding.mode==='installer'&&installerState.binding.commit);}catch(e){showPlanMessage(e.message,true);}
}
async function loadProjects(){
  const project=projectForServer(current);if(!project)throw new Error('Сервер не прикріплено до проєкту. Відкрий «Проєкти / installer» і виконай прив’язку.');
  const select=document.getElementById('p_project'),bound=installerState.binding&&installerState.binding.project,values=project.installers.map(x=>({path:x.projectPath,name:x.name,manifestRoot:x.manifestRoot||'home'}));
  if(!values.length)throw new Error('У проєкті «'+project.name+'» немає installer-репозиторіїв. Додай їх через «Проєкти / installer».');
  installerState.projects=values;select.innerHTML=values.map(x=>'<option value="'+esc(x.path)+'">'+esc(x.name)+' · '+esc(x.path)+'</option>').join('');
  // Передвибір installer для групи: коммітнутий binding → запамʼятований на групу → єдиний →
  // за назвою (останній сегмент шляху містить назву групи) → перший. Щоб не дообирати щоразу.
  const g=currentGroup(),gkey=current+'|'+g,remembered=(installerCatalog.groupInstaller||{})[gkey];
  const byName=values.find(x=>String(x.path).split('/').pop().toLowerCase().includes(g.toLowerCase()));
  const pick=(bound&&values.some(x=>x.path===bound))?bound
    :(remembered&&values.some(x=>x.path===remembered))?remembered
    :values.length===1?values[0].path
    :byName?byName.path:values[0].path;
  select.value=pick;
  document.getElementById('p_project_catalog_hint').innerHTML='Проєкт: <b>'+esc(project.name)+'</b> · <button type="button" class="ghost" id="p_open_catalog" style="padding:2px 6px">керувати</button>';
  document.getElementById('p_open_catalog').onclick=()=>{selectedCatalogProject=project.id;renderProjectManager();projectDlg.showModal();};
  loadInstallRootUi();
  await loadRefs();
}
function normalizeInstallerProject(value){
  let raw=String(value||'').trim();if(!raw)throw new Error('Встав GitLab URL або шлях installer-проєкту.');
  try{if(raw.toLowerCase().startsWith('http://')||raw.toLowerCase().startsWith('https://'))raw=decodeURIComponent(new URL(raw).pathname);}catch{throw new Error('Некоректний GitLab URL.');}
  raw=raw.split('?')[0].split('#')[0];while(raw.startsWith('/'))raw=raw.slice(1);while(raw.endsWith('/'))raw=raw.slice(0,-1);
  const marker=raw.indexOf('/-/');if(marker>=0)raw=raw.slice(0,marker);if(raw.toLowerCase().endsWith('.git'))raw=raw.slice(0,-4);
  const parts=raw.split('/').filter(Boolean);if(parts.length<2||parts.some(x=>!/^[A-Za-z0-9_.-]+$/.test(x)))throw new Error('Очікую шлях на кшталт group/installer.');
  return parts.join('/');
}
function currentManifestRoot(){const project=projectForServer(current),path=document.getElementById('p_project').value;return project&&project.installers.find(x=>x.projectPath===path)?.manifestRoot||'home';}
function scopedServices(snapshot=installerState.snapshot,files=installerState.scopeFiles){const selected=new Set(files||[]);return (snapshot?.services||[]).filter(value=>selected.has(value.sourceFile));}
function inferScopeFiles(snapshot=installerState.snapshot){
  const standNames=new Set(lastRows.filter(row=>groupOf(row)===currentGroup()).map(row=>row.image));
  return [...new Set((snapshot?.services||[]).filter(value=>standNames.has(value.image)).map(value=>value.sourceFile))].sort();
}
function renderScopeFiles(){
  const snapshot=installerState.snapshot,box=document.getElementById('p_scope_files'),hint=document.getElementById('p_scope_hint');if(!snapshot){box.innerHTML='';hint.textContent='';return;}
  const candidates=[...new Set((snapshot.services||[]).map(value=>value.sourceFile))].sort(),binding=installerState.binding||{};
  const saved=binding.project===document.getElementById('p_project').value&&Array.isArray(binding.scopeFiles)?binding.scopeFiles.filter(value=>candidates.includes(value)):[];
  if(!installerState.scopeFiles.length)installerState.scopeFiles=saved.length?saved:inferScopeFiles(snapshot);
  const selected=new Set(installerState.scopeFiles);box.innerHTML=candidates.map(file=>'<label><input type="checkbox" value="'+escAttr(file)+'" '+(selected.has(file)?'checked':'')+'> '+esc(file)+'</label>').join('');
  box.querySelectorAll('input').forEach(input=>input.onchange=()=>{installerState.scopeFiles=[...box.querySelectorAll('input:checked')].map(x=>x.value);hint.innerHTML='<b>Обрано вручну:</b> '+installerState.scopeFiles.length+' файлів · '+scopedServices().length+' сервісів';renderPlan();updatePlanSetupSummary();});
  hint.innerHTML=(saved.length?'<b>Збережений scope:</b> ':'<b>Автовиявлено за контейнерами групи:</b> ')+installerState.scopeFiles.length+' файлів · '+scopedServices().length+' сервісів'+(!installerState.scopeFiles.length?' <span class="st FAILURE">— обери файли вручну</span>':'');
}
function installRootKey(){return current+'|'+currentGroup()+'|'+document.getElementById('p_project').value;}
function loadInstallRootUi(){
  const input=document.getElementById('p_install_root'),hint=document.getElementById('p_install_root_hint'),binding=installerState.binding||{},saved=(binding.project===document.getElementById('p_project').value&&binding.installRoot)||installerCatalog.installRoots[installRootKey()],suggested='/usr/local/'+currentGroup();input.value=saved||suggested;
  hint.innerHTML=saved?(current==='Poruch QA'&&currentGroup()==='rscore'&&saved==='/usr/local/rscore'?'<span class="st SUCCESS">✓ Підтверджено read-only звіркою файлів installer</span>':'<span class="st SUCCESS">✓ Збережена прив’язка для цієї групи</span>'):'Запропоновано за назвою Docker-групи. Можна виправити вручну.';
}
async function loadRefs(){
  showPlanMessage('Читаю гілки й теги installer…');
  installerState.refs=await apiJson('/api/installer/refs?project='+encodeURIComponent(document.getElementById('p_project').value));
  const binding=installerState.binding||{};
  document.getElementById('p_source').value=binding.sourceKind==='branch'?'installer_branch':'installer_tag';
  await syncPlanSource();
}
async function syncPlanMode(){
  const installer=document.getElementById('p_mode').value==='installer';
  ['p_project_box','p_install_box','p_scope_box','p_source_box','p_ref_box','p_pinned_box'].forEach(id=>document.getElementById(id).hidden=!installer);
  document.getElementById('p_mode_hint').innerHTML=installer
    ?'<b>Цільовий стан задає installer.</b> Увесь manifest входить у план; сервер поки не змінюється.'
    :'<b>Ручний режим.</b> Розбіжності з installer не контролюються й не показуються.';
  document.getElementById('p_branch_box').hidden=true;
  document.getElementById('p_commit_preview').innerHTML='';document.getElementById('plan_preview').innerHTML='';
  if(!installer){installerState.snapshot=null;showPlanMessage('Група працює вручну. Збережи режим, якщо це потрібний стан.');return;}
  try{await loadProjects();}catch(e){showPlanMessage(e.message,true);}
}
async function syncPlanSource(){
  const branchMode=document.getElementById('p_source').value==='installer_branch',binding=installerState.binding||{};
  document.getElementById('p_branch_box').hidden=!branchMode;
  document.getElementById('p_ref_label').textContent=branchMode?'Commit гілки':'Тег installer';
  if(branchMode){
    const branches=installerState.refs.branches||[],bs=document.getElementById('p_branch');
    bs.innerHTML=branches.map(x=>'<option value="'+esc(x.name)+'">'+esc(x.name)+' · '+esc(x.shortCommit)+'</option>').join('');
    if(binding.sourceKind==='branch'&&branches.some(x=>x.name===binding.sourceName))bs.value=binding.sourceName;else if(branches.some(x=>x.name==='dev'))bs.value='dev';
    await loadCommits();
  }else{
    const tags=installerState.refs.tags||[],target=document.getElementById('p_baseline');
    target.innerHTML=tags.map(x=>'<option value="'+esc(x.name)+'">'+esc(x.name)+' · '+esc(x.shortCommit)+'</option>').join('');
    if(binding.sourceKind==='tag'&&tags.some(x=>x.name===binding.sourceName))target.value=binding.sourceName;
    await loadSnapshot();
  }
}
async function loadCommits(){
  installerState.commits=await apiJson('/api/installer/commits?project='+encodeURIComponent(document.getElementById('p_project').value)+'&branch='+encodeURIComponent(document.getElementById('p_branch').value));
  const target=document.getElementById('p_baseline'),binding=installerState.binding||{};
  target.innerHTML=installerState.commits.map((x,i)=>'<option value="'+esc(x.id)+'">'+esc(x.shortId)+' · '+(i?'':'HEAD · ')+esc((x.title||'').slice(0,55))+'</option>').join('');
  if(binding.sourceKind==='branch'&&installerState.commits.some(x=>x.id===binding.ref))target.value=binding.ref;
  await loadSnapshot();
}
const snapshotCache=new Map();
async function snapshotFor(ref){
  const key=document.getElementById('p_project').value+'@'+ref;if(snapshotCache.has(key))return snapshotCache.get(key);
  const value=await apiJson('/api/installer/snapshot?project='+encodeURIComponent(document.getElementById('p_project').value)+'&ref='+encodeURIComponent(ref)+'&root='+encodeURIComponent(currentManifestRoot()));snapshotCache.set(key,value);return value;
}
async function loadSnapshot(){
  const ref=document.getElementById('p_baseline').value;if(!ref)return showPlanMessage('У installer немає доступного ref.',true);
  showPlanMessage('Читаю точний склад installer…');
  try{
    installerState.snapshot=await snapshotFor(ref);installerState.scopeFiles=[];
    const s=installerState.snapshot,branchMode=document.getElementById('p_source').value==='installer_branch';
    document.getElementById('p_pinned').innerHTML=(branchMode?'<code>'+esc(document.getElementById('p_branch').value)+'</code> @ ':'tag ')+'<code>'+esc(s.commit.shortId)+'</code><div class="plansub">manifest '+esc(s.checksum.slice(0,12))+'</div>';
    renderScopeFiles();await renderCommitPreview();renderPlan();updatePlanSetupSummary();
  }catch(e){showPlanMessage(e.message,true);}
}
async function renderCommitPreview(){
  const box=document.getElementById('p_commit_preview'),branchMode=document.getElementById('p_source').value==='installer_branch';
  if(!branchMode){box.innerHTML='<div class="planhint"><b>'+esc(installerState.snapshot.commit.title)+'</b><br><span class="muted">'+esc(installerState.snapshot.commit.shortId)+' · '+esc(new Date(installerState.snapshot.commit.date).toLocaleString())+'</span></div>';return;}
  const idx=installerState.commits.findIndex(x=>x.id===document.getElementById('p_baseline').value),previous=installerState.commits[idx+1];
  if(!previous){box.innerHTML='';return;}
  try{
    const old=await snapshotFor(previous.id),before=new Map(old.services.map(x=>[x.image,x.tag])),after=new Map(installerState.snapshot.services.map(x=>[x.image,x.tag]));
    const names=[...new Set([...before.keys(),...after.keys()])].sort(),changes=names.filter(x=>before.get(x)!==after.get(x));
    box.innerHTML='<div class="planhint"><b>У цей commit увійшло: '+changes.length+'</b>'+changes.slice(0,6).map(x=>'<div>'+esc(x)+': <code>'+esc(before.get(x)||'＋')+'</code> → <code>'+esc(after.get(x)||'видалено')+'</code></div>').join('')+(changes.length>6?'<div class="muted">…ще '+(changes.length-6)+'</div>':'')+'</div>';
  }catch{box.innerHTML='';}
}
function buildPlanView(){
  const groupRows=lastRows.filter(row=>groupOf(row)===currentGroup()),byStand=new Map(groupRows.map(row=>[row.image,row])),byTarget=new Map(scopedServices().map(item=>[item.image,item]));
  const names=[...new Set([...byStand.keys(),...byTarget.keys()])].sort();
  planView=names.map(name=>{const row=byStand.get(name),target=byTarget.get(name),currentTag=row&&row.deployed&&row.deployed.tag;
    if(target&&(target.unresolvedVariables||[]).length)return{image:name,row,target,kind:'unknown',reason:'не розкрито змінні installer: '+target.unresolvedVariables.join(', ')};
    if(!row)return{image:name,row:null,target,kind:'unknown',reason:'є в installer, але контейнер не знайдено на стенді'};
    if(!target)return{image:name,row,target:null,kind:'unmanaged',reason:'є на стенді, але відсутній у installer'};
    return{image:name,row,target,kind:currentTag===target.tag?'same':'change',reason:currentTag===target.tag?'відповідає installer':'installer задає інший tag'};});
  return planView;
}
function renderPlan(){
  if(!installerState.snapshot)return;
  const items=buildPlanView(),matched=items.filter(x=>x.kind==='same').length,changes=items.filter(x=>x.kind==='change').length,unknown=items.filter(x=>x.kind==='unknown'||x.kind==='unmanaged').length,s=installerState.snapshot;
  document.getElementById('p_total').textContent='installer: '+scopedServices(s).length;
  document.getElementById('p_matched').textContent='відповідає: '+matched;document.getElementById('p_changes').textContent='до зміни: '+changes;document.getElementById('p_unknown').textContent='увага: '+unknown;
  document.getElementById('p_files').textContent='home '+s.fileGroups.home+' · scripts '+s.fileGroups.scripts+' · config '+s.fileGroups.configs;
  const visible=items.filter(x=>planFilter==='all'||planFilter==='change'&&x.kind==='change'||planFilter==='problem'&&(x.kind==='unknown'||x.kind==='unmanaged'));
  document.getElementById('p_table').innerHTML='<table><thead><tr><th>Сервіс</th><th class="server-col">● Сервер зараз</th><th class="installer-col">◆ Installer target</th><th>Рішення</th></tr></thead><tbody>'+visible.map(x=>{
    const dep=x.row&&x.row.deployed||{},cl=x.kind==='change'?'plan-change':(x.kind==='unknown'||x.kind==='unmanaged')?'plan-unmatched':'';
    const badge=x.kind==='same'?'<span class="planstatus ok">✓ відповідає</span>':x.kind==='change'?'<span class="planstatus warn">⇄ змінити</span>':'<span class="planstatus bad">! перевірити</span>';
    return'<tr class="'+cl+'"><td><div class="plansvc">'+esc(x.image)+'</div><div class="plansub">'+esc((x.target&&x.target.sourceFile)||groupOf(x.row||{}))+'</div></td><td class="server-cell"><code>'+esc(dep.tag||'—')+'</code></td><td class="installer-cell"><code>'+esc((x.target&&x.target.tag)||'—')+'</code></td><td>'+badge+'<div class="plansub">'+esc(x.reason)+'</div></td></tr>';}).join('')+'</tbody></table>';
  document.getElementById('plan_preview').innerHTML='';
}
document.getElementById('planbtn').onclick=()=>openPlan('all');document.getElementById('p_close').onclick=closePlan;
document.getElementById('p_group').onchange=async()=>{await loadBinding();await refreshCurrentPlan();};document.getElementById('p_mode').onchange=syncPlanMode;
document.getElementById('p_project').onchange=()=>{installerCatalog.groupInstaller=installerCatalog.groupInstaller||{};installerCatalog.groupInstaller[current+'|'+currentGroup()]=document.getElementById('p_project').value;saveCatalog();loadInstallRootUi();loadRefs();};document.getElementById('p_source').onchange=syncPlanSource;
document.getElementById('p_branch').onchange=loadCommits;document.getElementById('p_baseline').onchange=loadSnapshot;
document.getElementById('p_install_root').oninput=()=>{document.getElementById('p_install_root_hint').textContent='Ручний шлях буде збережено разом із цільовим станом.';updatePlanSetupSummary();};
document.getElementById('p_detect_root').onclick=async()=>{const input=document.getElementById('p_install_root'),hint=document.getElementById('p_install_root_hint'),btn=document.getElementById('p_detect_root');btn.disabled=true;hint.textContent='Читаю Docker Compose labels через SSH…';try{const data=await apiJson('/api/installer/detect-roots?server='+encodeURIComponent(current)+'&manifestRoot='+encodeURIComponent(currentManifestRoot())),found=data.groups.find(x=>x.group===currentGroup());if(found&&found.root){input.value=found.root;hint.innerHTML='<span class="st SUCCESS">✓ Виявлено з Docker Compose labels</span>'+(found.workingDirs.length?' · compose: '+esc(found.workingDirs.join(', ')):'');}else if(found&&found.candidates.length){hint.innerHTML='<span class="st FAILURE">Знайдено кілька директорій:</span> '+found.candidates.map(esc).join(', ')+' — обери вручну.';}else{input.value=found?.suggestedRoot||('/usr/local/'+currentGroup());hint.textContent='Compose working_dir не знайдено. Запропоновано шлях за назвою групи; перевір його вручну.';}}catch(e){hint.innerHTML='<span class="st FAILURE">Автовиявлення: '+esc(e.message)+'</span>';}finally{btn.disabled=false;}};
document.querySelectorAll('.planfilter').forEach(b=>b.onclick=()=>{planFilter=b.dataset.pf;document.querySelectorAll('.planfilter').forEach(x=>x.classList.toggle('active',x===b));renderPlan();});
document.getElementById('p_view_plan').onclick=openCurrentPlan;document.getElementById('plan_result_close').onclick=()=>document.getElementById('planResultDlg').close();
const humanBytes=value=>{const n=Number(value)||0;if(n<1024)return n+' B';if(n<1048576)return(n/1024).toFixed(1)+' KiB';if(n<1073741824)return(n/1048576).toFixed(1)+' MiB';return(n/1073741824).toFixed(2)+' GiB';};
const backupPhase=value=>({preflight:'Перевірка плану', 'db-preflight':'Перевірка PostgreSQL', inventory:'Збереження стану контейнерів', 'stand-files':'Підготовка файлів стенду', 'stand-files-archive':'Пакування home / scripts / volumes на сервері', 'stand-files-transfer':'Передача архіву на локальний компʼютер', 'stand-files-verify':'Перевірка локального архіву', 'database-dump':'Створення PostgreSQL dump', 'database-transfer':'Передача PostgreSQL dump', 'database-verify':'Перевірка PostgreSQL dump', finalizing:'Фінальна перевірка checksum', done:'Готово', failed:'Помилка'}[value]||value||'Підготовка');
async function refreshBackupProgress(planId){
  const job=await apiJson('/api/installer/backup-status?planId='+encodeURIComponent(planId)),status=document.getElementById('plan_backup_status');
  const total=Number(job.totalBytes)||0,processed=Math.min(Number(job.processedBytes)||0,total||Number(job.processedBytes)||0),percent=total?Math.min(100,Math.round(processed/total*100)):0;
  status.innerHTML='<div class="backup-state warn backup-progress"><div class="line"><b>'+esc(backupPhase(job.phase))+'</b><span>'+(total?('≈ '+percent+'%'):'…')+'</span></div><progress max="100" value="'+percent+'"></progress><div class="line"><span>'+humanBytes(processed)+(total?' / ≈ '+humanBytes(total):'')+'</span><span>'+humanBytes(job.speedBytesPerSecond||0)+'/с</span></div></div>';
  return job;
}
document.getElementById('plan_backup').onclick=async()=>{
  const value=installerState.currentPlan;if(!value||!value.plan||!value.serverUnchanged)return;
  const db=(value.plan.backupPreflight&&value.plan.backupPreflight.databaseCandidates||[]).map(x=>x.name);
  if(!confirm('Створити локальну точку відновлення для '+value.plan.server+' / '+value.plan.group+'?\\n\\nБуде передано через SSH: home, scripts, volumes'+(db.length?' та PostgreSQL dump: '+db.join(', '):'. DB-контейнери не виявлено.')+'\\nСервер не змінюється.'))return;
  const button=document.getElementById('plan_backup'),status=document.getElementById('plan_backup_status');button.disabled=true;button.textContent='Створюється backup…';status.innerHTML='<div class="backup-state warn">Пакую у тимчасовий файл на сервері, передаю через SCP і видаляю server temp після перевірки. Не закривай StandWatch.</div>';let poll=null;
  try{
    const request=apiJson('/api/installer/backup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({server:current,group:currentGroup(),planId:value.id})});
    poll=setInterval(()=>refreshBackupProgress(value.id).catch(()=>{}),1000);await refreshBackupProgress(value.id).catch(()=>{});const result=await request;
    await refreshCurrentPlan();document.getElementById('planResultDlg').close();openCurrentPlan();
  }catch(e){status.innerHTML='<div class="backup-state bad"><b>Backup не створено:</b> '+esc(e.message)+'</div>';button.disabled=false;button.textContent='Повторити backup';await refreshCurrentPlan().catch(()=>{});}finally{if(poll)clearInterval(poll);}
};
const restorePhase=value=>({checksums:'Перевірка checksum', 'live-structure':'Знімок структури живої БД', 'temporary-database':'Запуск ізольованого PostgreSQL', 'database-restore':'Відновлення SQL dump', 'restored-structure':'Звірка відновленої БД', done:'Restore перевірено', failed:'Restore-test не пройдено'}[value]||value||'Підготовка');
async function refreshRestoreProgress(planId){const job=await apiJson('/api/installer/restore-test-status?planId='+encodeURIComponent(planId)),status=document.getElementById('plan_restore_status');status.innerHTML='<div class="backup-state '+(job.status==='restore-failed'?'bad':job.status==='restore-tested'?'ok':'warn')+'"><b>'+esc(restorePhase(job.phase))+'</b>'+(job.error?'<br>'+esc(job.error):'')+'<br><span class="muted">Тимчасова БД ізольована: без портів і без робочих volumes. Детальний JSONL зберігається біля backup.</span></div>';return job;}
document.getElementById('plan_restore_test').onclick=async()=>{
  const value=installerState.currentPlan;if(!value||!value.plan||value.plan.backup?.status!=='verified')return;
  if(!confirm('Перевірити PostgreSQL dump у тимчасовому ізольованому контейнері на '+value.plan.server+'?\\n\\nРобоча БД не зупиняється і не змінюється. StandWatch створить лише власний тимчасовий container/volume, збере журнал і видалить їх після тесту.'))return;
  const button=document.getElementById('plan_restore_test');button.disabled=true;button.textContent='Restore-test виконується…';let poll=null;
  try{const request=apiJson('/api/installer/restore-test',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({server:current,group:currentGroup(),planId:value.id})});poll=setInterval(()=>refreshRestoreProgress(value.id).catch(()=>{}),1200);await refreshRestoreProgress(value.id).catch(()=>{});await request;await refreshCurrentPlan();document.getElementById('planResultDlg').close();openCurrentPlan();}
  catch(e){document.getElementById('plan_restore_status').innerHTML='<div class="backup-state bad"><b>Restore-test не пройдено:</b> '+esc(e.message)+'</div>';button.disabled=false;button.textContent='Повторити restore-test';await refreshCurrentPlan().catch(()=>{});}finally{if(poll)clearInterval(poll);}
};
document.getElementById('p_dry').onclick=async()=>{
  const mode=document.getElementById('p_mode').value==='installer'?'installer':'manual',group=currentGroup(),body={server:current,group,mode};
  if(mode==='installer'){const branch=document.getElementById('p_source').value==='installer_branch',root=document.getElementById('p_install_root').value.trim();if(!root.startsWith('/')){document.getElementById('plan_preview').innerHTML='<p class="st FAILURE">Вкажи абсолютний шлях на сервері, починаючи з /.</p>';return;}if(!installerState.scopeFiles.length){document.getElementById('plan_preview').innerHTML='<p class="st FAILURE">Обери compose-файли цієї Docker-групи.</p>';return;}installerCatalog.installRoots[installRootKey()]=root;saveCatalog();Object.assign(body,{project:document.getElementById('p_project').value,manifestRoot:currentManifestRoot(),installRoot:root,scopeFiles:installerState.scopeFiles,sourceKind:branch?'branch':'tag',sourceName:branch?document.getElementById('p_branch').value:document.getElementById('p_baseline').value,ref:document.getElementById('p_baseline').value});}
  try{const j=await apiJson('/api/installer/binding',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});installerState.binding=j.binding;updatePlanSetupSummary();document.getElementById('p_setup').open=false;const preview=document.getElementById('plan_preview');preview.innerHTML='<p class="planhint"><b>✓ Цільовий стан збережено.</b> '+esc(mode==='installer'?(j.binding.project+' · '+j.binding.commit.shortId):'ручний режим')+'</p>';setTimeout(()=>{if(preview.textContent.includes('Цільовий стан збережено'))preview.innerHTML='';},2500);if(lastData)render(lastData);}catch(e){document.getElementById('plan_preview').innerHTML='<p class="st FAILURE">'+esc(e.message)+'</p>';}
};
document.getElementById('p_execute').onclick=async()=>{
  if(!installerState.snapshot)return;
  if(!installerState.scopeFiles.length){document.getElementById('plan_preview').innerHTML='<p class="st FAILURE">Обери compose-файли цієї Docker-групи.</p>';return;}
  if(installerState.currentPlan?.plan&&installerState.currentPlan.serverUnchanged&&!confirm('Поточний план досі актуальний. Сформувати його заново?'))return;
  const items=buildPlanView(),blocked=items.filter(x=>x.kind==='unknown'||x.kind==='unmanaged'),btn=document.getElementById('p_execute');
  btn.disabled=true;btn.textContent='Перевіряю конфіги…';document.getElementById('plan_preview').innerHTML='<p class="muted">Read-only checksum через SSH. Сервер не змінюється…</p>';
  try{
    const requestBody={server:current,group:currentGroup(),project:document.getElementById('p_project').value,ref:installerState.snapshot.commit.id,manifestRoot:currentManifestRoot(),installRoot:document.getElementById('p_install_root').value.trim()};
    const [f,pre]=await Promise.all([apiJson('/api/installer/compare-files',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(requestBody)}),apiJson('/api/installer/preflight',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(requestBody)})]);
    const c=f.counts;
    const saved=await apiJson('/api/installer/plan',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({server:current,group:currentGroup(),installRoot:requestBody.installRoot,scopeFiles:installerState.scopeFiles,snapshot:installerState.snapshot,items:items.map(x=>({image:x.image,current:x.row&&x.row.deployed&&x.row.deployed.tag,target:x.target&&x.target.tag,status:x.kind,reason:x.reason})),comparison:f,preflight:pre})});
    await refreshCurrentPlan();
    const preview=document.getElementById('plan_preview');preview.innerHTML='<div class="planhint"><b>✓ План збережено.</b> Сервіси до зміни: '+items.filter(x=>x.kind==='change').length+' · невирішено: '+blocked.length+' · конфіги відрізняються: '+c.different+'. <b>Деталі — «Переглянути поточний план».</b></div>';setTimeout(()=>{if(preview.textContent.includes('План збережено'))preview.innerHTML='';},4000);
  }catch(e){document.getElementById('plan_preview').innerHTML='<p class="st FAILURE">Перевірка конфігів: '+esc(e.message)+'</p>';}
  finally{btn.disabled=false;btn.textContent=installerState.currentPlan?.plan&&installerState.currentPlan.serverUnchanged?'Переформувати план':'Сформувати план';}
};
function render(d){
  lastData=d;
  const prj=r=>(r.deployed&&r.deployed.project)||'';
  const rows=[...d.rows].sort((a,b)=>prj(a).localeCompare(prj(b))||sev(a)-sev(b)||a.image.localeCompare(b.image));
  lastRows=rows;
  const multiProj=new Set(rows.map(prj).filter(Boolean)).size>1;
  // лічильники
  let down=0,upd=0,fail=0,ok=0,na=0,unb=0,nv=0;
  rows.forEach(r=>{const dep=r.deployed||{};if(dep.state&&dep.state!=='running')down++;else if(r.verdict.code===20)fail++;else if(r.verdict.code===10)upd++;else if(r.verdict.mark==='⚪️')na++;else ok++; if(r.unbuilt&&!r.unbuilt.error&&r.unbuilt.count>0)unb++; if(r.newerVersion)nv++;});
  let lastProj=null;
  const cards=rows.map((row,i)=>{
    const dep=row.deployed||{};
    let head='';
    if(multiProj && (dep.project||'')!==lastProj){
      lastProj=dep.project||'';
      const cnt=rows.filter(r=>((r.deployed&&r.deployed.project)||'')===lastProj).length;
      head='<div class="proj-h">'+esc(lastProj||'(без проєкту)')+' <span class="muted">· '+cnt+'</span></div>';
    }
    const stopped=dep.state&&dep.state!=='running';
    const cl=stopped?'bad':vcls(row.verdict.code);
    const ub=row.unbuilt;
    const stateBadge=dep.state?(stopped?' <span class="st FAILURE">⛔ '+esc(dep.state)+'</span>':''):'';
    const badges=(ub&&!ub.error&&ub.count>0?' <span class="ubbadge">гілка +'+ub.count+'</span>':'')
      +(row.newerVersion?' <span class="ubbadge">release ↑'+esc(row.newerVersion)+'</span>':'');
    // компактна картка: назва + тег + короткий вердикт; деталі/перемикання — у модалці по кліку
    return head+'<div class="card mini '+cl+'" data-idx="'+i+'">'
      +'<h2><span class="mk">'+esc(row.verdict.mark)+'</span> <span class="nm">'+esc(row.image)+'</span>'+(dep.tag?'<span class="tag">'+esc(dep.tag)+'</span>':'')+stateBadge+badges+'</h2>'
      +'<div class="verdict '+cl+'">'+(stopped?'⛔ НЕ запущений — лежить':esc(row.verdict.text))+'</div>'
      +'</div>';
  }).join('');
  const sum='<div id="sum">'
    +(down?'<span class="pill bad">⛔ лежить: '+down+'</span>':'')
    +(fail?'<span class="pill bad">білд впав: '+fail+'</span>':'')
    +(upd?'<span class="pill warn">🔶 треба апдейт: '+upd+'</span>':'')
    +(nv?'<span class="pill warn">новіший release tag: '+nv+'</span>':'')
    +(unb?'<span class="pill warn">гілка не зібрана: '+unb+'</span>':'')
    +'<span class="pill ok">✅ актуально: '+ok+'</span>'
    +(na?'<span class="pill na">невідомо: '+na+'</span>':'')
    +'<span class="pill na">усього: '+rows.length+'</span></div>';
  const sshErr=(d.ssh&&d.ssh.error&&!(d.ssh.containers&&d.ssh.containers.length))
    ? '<div class="card bad" style="margin:0 0 10px"><b>SSH до сервера не вдався</b> — список контейнерів недоступний.<pre>'+esc(d.ssh.error)+'</pre>Перевір ключ/доступ (панель бере ключ із servers.json).</div>' : '';
  app.innerHTML=sshErr+'<div id="installerStatus"></div>'+sum+'<div id="grid">'+cards+'</div>';
  refreshInstallerStatus(rows);
  app.querySelectorAll('.card.mini').forEach(c=>c.onclick=()=>openTagModal(+c.dataset.idx));
}
async function refreshInstallerStatus(rows){
  const host=document.getElementById('installerStatus');if(!host||!current)return;
  const groups=[...new Set(rows.map(groupOf))],active=[];
  try{
    for(const group of groups){const b=(await apiJson('/api/installer/binding?server='+encodeURIComponent(current)+'&group='+encodeURIComponent(group))).binding;if(b.mode==='installer')active.push({group,b});}
    if(!active.length){document.getElementById('planbtn').textContent='Режими груп';return;}
    let drift=0,attention=0;
    for(const x of active){const s=await apiJson('/api/installer/snapshot?project='+encodeURIComponent(x.b.project)+'&ref='+encodeURIComponent(x.b.ref)+'&root='+encodeURIComponent(x.b.manifestRoot||'home')),scope=rows.filter(r=>groupOf(r)===x.group),standNames=new Set(scope.map(r=>r.image));let files=Array.isArray(x.b.scopeFiles)?x.b.scopeFiles.filter(Boolean):[];if(!files.length)files=[...new Set(s.services.filter(v=>standNames.has(v.image)).map(v=>v.sourceFile))];const fileSet=new Set(files),targets=s.services.filter(v=>fileSet.has(v.sourceFile)),target=new Map(targets.map(v=>[v.image,v]));scope.forEach(r=>{const item=target.get(r.image);if(!item||(item.unresolvedVariables||[]).length)attention++;else if(item.tag!==(r.deployed&&r.deployed.tag))drift++;});for(const item of targets)if(!standNames.has(item.image))attention++;}
    document.getElementById('planbtn').textContent=(drift||attention?'⚠ ':'✓ ')+'Installer: '+drift;
    host.innerHTML='<button id="installerAlert" class="installer-alert"><span>'+(drift||attention?'⚠':'✓')+'</span><span><b>'+(drift?'Відмінності від installer: '+drift:'Стенд відповідає installer')+'</b>'+(attention?' · '+attention+' позицій потребують перевірки':'')+'</span><span class="go">Відкрити →</span></button>';
    document.getElementById('installerAlert').onclick=()=>openPlan(drift?'change':'problem');
  }catch(e){host.innerHTML='<div class="muted" style="margin-bottom:8px">Installer-контроль недоступний: '+esc(e.message)+'</div>';}
}
// деталі сервіса — двома колонками
const bb=x=>(x&&(x.branch||x.build))?' <span class="muted">['+esc(x.branch||'?')+' #'+esc(x.build||'?')+']</span>':'';
// ЛІВА колонка — стан образу (що розгорнуто / що в реєстрі / чи є новіша версія)
function detailsLeftHtml(row){
  const dep=row.deployed||{}, reg=row.registry||{};
  const latest=row.teamcity&&row.teamcity.latest;
  return '<div class="det"><table>'
    +'<tr><th>розгорнуто</th><td><code>'+esc(short(dep.digest))+'</code>'+bb(dep)+' · '+esc(ago(dep.created))+' · TC '+tc(row.teamcity&&row.teamcity.deployed)+'</td></tr>'
    +'<tr><th>у реєстрі</th><td><code>'+esc(short(reg.digest))+'</code>'+bb(reg)+' · '+esc(ago(reg.created))+' · TC '+tc(row.teamcity&&row.teamcity.registry)+(reg.error?' <span class="muted">('+esc(reg.error)+')</span>':'')+'</td></tr>'
    +(latest?'<tr><th>останній успішний TC</th><td>'+tc(latest)+(latest.commit?' · commit <code>'+esc(short(latest.commit))+'</code>':'')+(dep.build&&latest.number&&String(dep.build)!==String(latest.number)?' <b class="drift">— стенд відстає</b>':'')+'</td></tr>':'')
    +(row.newerVersion?'<tr><th class="warnh">новіший release tag</th><td><b class="drift">'+esc(row.newerVersion)+'</b> <span class="muted">(розгорнуто '+esc(dep.tag)+')</span></td></tr>':'')
    +'</table></div>';
}
// ПРАВА колонка — git / CI (комміт, що принесе апдейт, що в гілці не зібрано + лінки)
function detailsRightHtml(row){
  const dep=row.deployed||{}, dev=row.devState, ub=row.unbuilt;
  const verified=row.unbuiltBasis==='teamcity';
  let drift='';
  if(dev&&dev.build&&dep.build&&String(dev.build)!==String(dep.build))
    drift='<tr><th>гілка dev</th><td class="drift">'+tc(dev.teamcity)+' · '+esc(ago(dev.created))+' <span class="muted">(розгорнуто <b>'+esc(dep.branch||'?')+'</b>, dev далі)</span></td></tr>';
  let unbuiltRow='';
  if(ub&&!ub.error){
    if(ub.note) unbuiltRow='<tr><th>після останнього TC</th><td class="muted">'+esc(ub.note)+'</td></tr>';
    else if(ub.count>0){
      const list=(ub.commits||[]).slice(0,6).map(c=>'<div class="cmt">'+esc(c.id)+' '+esc((c.title||'').slice(0,80))+'</div>').join('');
      const links='<div class="ublinks">'
        +(row.buildConfigUrl?'<a href="'+esc(row.buildConfigUrl)+'" target="_blank">▶ зібрати в TeamCity</a>':'')
        +(ub.compareUrl?' · <a href="'+esc(ub.compareUrl)+'" target="_blank">переглянути зміни</a>':'')+'</div>';
      unbuiltRow='<tr><th class="warnh">'+(verified?'треба збілдити':'GitLab після образу')+'</th><td><b class="drift">'+ub.count+' закомічених змін</b> після '+(verified?'останнього успішного TeamCity build':'commit поточного образу; TeamCity-базу не підтверджено')+(ub.head?'<br><span class="muted">HEAD <code>'+esc(ub.head.id)+'</code> '+esc(ago(ub.head.date))+'</span>':'')+'<div class="cmts">'+list+(ub.count>6?'<div class="muted">…ще '+(ub.count-6)+'</div>':'')+'</div>'+links+'</td></tr>';
    } else unbuiltRow='<tr><th>GitLab → TeamCity</th><td class="muted">0 змін після '+(verified?'останнього успішного build — він містить HEAD гілки':'commit образу; TeamCity-базу не підтверджено')+'</td></tr>';
  }
  let updRow='';
  if(row.commits&&!row.commits.error&&row.commits.count>0){
    const list=(row.commits.commits||[]).slice(0,6).map(c=>'<div class="cmt">'+esc(c.id)+' '+esc((c.title||'').slice(0,80))+'</div>').join('');
    updRow='<tr><th>апдейт принесе</th><td>'+row.commits.count+' комітів<div class="cmts">'+list+(row.commits.count>6?'<div class="muted">…ще '+(row.commits.count-6)+'</div>':'')+'</div></td></tr>';
  }
  const rows=(row.gitlab&&row.gitlab.commit?'<tr><th>білд-комміт</th><td><code>'+esc(row.gitlab.commit.short_id)+'</code> '+esc((row.gitlab.commit.title||'').slice(0,90))+'</td></tr>':'')+updRow+unbuiltRow+drift;
  if(!rows) return '<div class="muted" style="padding:6px">git/CI-даних нема</div>';
  return '<div class="det"><table>'+rows+'</table></div>';
}

// ── Модалка: гілка (випадайка) + теги (список) + виконання ───────────────────
const tagDlg=document.getElementById('tagDlg');
const YML_PROJ=new Set(['rscore','retail','x5']);
let tagRow=null;
const buildOf=t=>{const m=/\.(\d+)$/.exec(t||'');return m?+m[1]:null;}; // № білда з тега
function openTagModal(idx){
  tagRow=lastRows[idx]; if(!tagRow)return;
  const dep=tagRow.deployed||{}, reg=tagRow.registry||{};
  // блок «зараз розгорнуто» + «останній зібраний»
  const now='Зараз розгорнуто: <code>'+esc(dep.tag||'?')+'</code>'+(dep.build?' <b>#'+esc(dep.build)+'</b>':'')+(dep.created?' · '+esc(ago(dep.created)):'');
  const latest=(reg.tag&&reg.build&&reg.tag!==dep.tag||reg.build&&String(reg.build)!==String(dep.build))
    ? '<div class="muted">Останній білд у реєстрі: <code>'+esc(reg.tag||'')+'</code> #'+esc(reg.build||'?')+' · '+esc(ago(reg.created))+'</div>' : '';
  document.getElementById('t_title').innerHTML=esc(tagRow.image)+' <span class="muted">'+esc(dep.project||'')+'</span><div class="nowline">'+now+'</div>'+latest;
  document.getElementById('t_details').innerHTML=detailsLeftHtml(tagRow);
  document.getElementById('t_git').innerHTML=detailsRightHtml(tagRow);
  const branches=tagRow.branches||[];
  const sw=document.getElementById('t_switch');
  if(!branches.length){ sw.hidden=true; tagDlg.showModal(); return; } // нема тегів для перемикання
  sw.hidden=false;
  const sel=document.getElementById('t_branch');
  sel.innerHTML=branches.map(b=>{
    let lbl=b.branch;
    if(b.branch===dep.branch) lbl+=' — поточна';
    return '<option value="'+esc(b.branch)+'">'+esc(lbl)+'</option>'; // ліворуч — рівно назва гілки
  }).join('');
  // дефолт — група, що містить ПОТОЧНИЙ тег (щоб одразу бачити «ЗАРАЗ»)
  let cur=branches.find(b=>b.latestTag===dep.tag||(b.builds||[]).includes(dep.tag))?.branch;
  if(!cur&&dep.branch&&branches.find(b=>b.branch===dep.branch)) cur=dep.branch;
  if(!cur) cur=branches[0]&&branches[0].branch;
  if(cur)sel.value=cur;
  sel.onchange=()=>renderTagList(sel.value);
  document.getElementById('t_cmd').innerHTML='';
  renderTagList(sel.value);
  tagDlg.showModal();
}
function renderTagList(branchName){
  const tsel=document.getElementById('t_tag');
  const b=(tagRow.branches||[]).find(x=>x.branch===branchName);
  const dep=tagRow.deployed||{}, curTag=dep.tag, depBuild=dep.build?+dep.build:null;
  const sameBranch=(branchName===dep.branch);
  const items=[];
  if(b){
    if(b.latestTag) items.push({tag:b.latestTag, build:b.maxBuild});
    (b.builds||[]).forEach(t=>{ if(t!==b.latestTag) items.push({tag:t, build:buildOf(t)}); });
  }
  if(!items.length){tsel.innerHTML='<option value="">нема тегів для цієї гілки</option>';document.getElementById('t_cmd').innerHTML='';return;}
  tsel.innerHTML=items.map(it=>{
    const isCur=it.tag===curTag;
    let mark='';
    if(isCur) mark='  ● зараз';
    else if(sameBranch&&depBuild!=null&&it.build!=null){
      if(it.build>depBuild) mark='  ↑ новіше';
      else if(it.build<depBuild) mark='  ↓ старіше';
    }
    return '<option value="'+esc(it.tag)+'"'+(isCur?' selected':'')+'>'+esc(it.tag)+mark+'</option>'; // праворуч — рівно тег
  }).join('');
  tsel.onchange=()=>showTagCommand(tsel.value);
  showTagCommand(tsel.value); // одразу для вибраного (поточного або першого)
}
async function showTagCommand(tag){
  if(!tag)return;
  const dep=tagRow.deployed||{}, project=dep.project||'';
  const isCur=(tag===dep.tag);
  document.getElementById('t_pick').innerHTML='Піде в деплой: <code class="pick-tag">'+esc(tag)+'</code>'
    +(isCur?' <span class="muted">— це вже розгорнутий тег</span>':' <span class="muted">(зараз: '+esc(dep.tag||'?')+')</span>');
  const box=document.getElementById('t_cmd'); box.innerHTML='<p class="muted">будую…</p>';
  const resp=await fetch('/api/deploy-command?project='+encodeURIComponent(project)+'&image='+encodeURIComponent(tagRow.image)+'&tag='+encodeURIComponent(tag));
  const j=await resp.json();
  let html='<pre>'+esc(j.command||j.error||'')+'</pre>';
  if(j.canExecute) html+='<button id="t_exec" data-tag="'+esc(tag)+'"'+(isCur?' disabled title="цей тег уже розгорнутий"':'')+'>▶ Розгорнути «'+esc(tag)+'» на '+esc(current)+'</button> <span class="muted">перепише home/*.yml і запустить update.sh</span>';
  else html+='<p class="muted">Копіюй і виконай на стенді від root.</p>';
  box.innerHTML=html;
  const ex=document.getElementById('t_exec');
  if(ex) ex.onclick=()=>execDeploy(project,tagRow.image,tag,box);
}
async function execDeploy(project,image,tag,box){
  if(!confirm('Перемкнути '+image+' → '+tag+' на '+current+' і запустити update.sh? Це змінить робочий сервер.')) return;
  box.innerHTML='<p class="muted">виконую на сервері… (може зайняти до 1–2 хв)</p>';
  const r=await fetch('/api/deploy',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({server:current,project,image,tag})});
  const j=await r.json();
  if(j.ok){box.innerHTML='<p class="st SUCCESS">✓ Готово. Перескануй сервер.</p><pre>'+esc((j.out||'').slice(-2000))+'</pre>';}
  else if(j.needSetup){
    const w=await (await fetch('/api/deploy-wrapper')).json();
    box.innerHTML='<p class="card bad" style="padding:8px">Деплой на цьому сервері не налаштовано. Виконай на ньому <b>від root</b> (одноразово), потім спробуй ще раз:</p><pre>'+esc(w.command)+'</pre>';
  }
  else{box.innerHTML='<p class="card bad" style="padding:8px">Помилка (код '+esc(j.code)+')</p><pre>'+esc((j.err||j.out||'').slice(-2000))+'</pre>';}
}
document.getElementById('t_close').onclick=()=>tagDlg.close();

document.getElementById('scan').onclick=scan;
let timer=null;
let customMin=null;
function intervalMin(){
  const v=document.getElementById('ival').value;
  if(v==='custom'){ if(customMin==null){const x=prompt('Інтервал автооновлення у хвилинах:', '15'); customMin=Math.max(1,parseInt(x,10)||15);} return customMin; }
  customMin=null; return +v;
}
function setAuto(){clearInterval(timer);if(document.getElementById('auto').checked){const m=intervalMin();timer=setInterval(scan,m*60*1000);scan();}}
document.getElementById('auto').onchange=setAuto;
document.getElementById('ival').onchange=()=>{customMin=null; if(document.getElementById('auto').checked)setAuto();};
// first-run: нема токенів або готової пари SSH-ключів → одразу відкрити налаштування
fetch('/api/config').then(r=>r.json()).then(s=>{
  if(new URLSearchParams(location.search).get('preview')!=='plan'&&(!s.gitlab||!s.sshKeyExists||!s.sshPublicKeyExists)){
    openCfg();
    document.getElementById('cfg_msg').innerHTML=!s.sshKeyExists||!s.sshPublicKeyExists
      ?'<span class="st FAILURE">Створи рекомендований ключ для моніторингу або вибери наявний.</span>'
      :'<span class="st FAILURE">Впиши токени — без них панель нічого не покаже.</span>';
  }
}).catch(()=>{});
// query для локального дизайн-preview: відкриває кеш сервера та modal без scan.
const previewArgs=new URLSearchParams(location.search);
hydrateInstallerCatalog().then(loadServers).then(async()=>{
  if(previewArgs.get('preview')==='plan'){
    current=previewArgs.get('server')||'Poruch QA';
    document.getElementById('planbtn').hidden=false;
    await loadServers(); await showCached();
    setTimeout(openPlan,80);
  }else showOverview();
});
addEventListener('pagehide',()=>{ try{ navigator.sendBeacon('/api/window-closed'); }catch{} });
</script></body></html>`;

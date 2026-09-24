#!/usr/bin/env node
// stand-version.mjs — що зараз розгорнуто на стенді vs що зібрано в CI (GitLab).
//
// Проблема: образи тегнуті мутабельним `1.0.0-dev.latest`, за тегом версію не видно.
// Реальна ідентичність = digest (sha256) + git-revision із лейблів образу + час збірки.
//
// Джерела (кожне опційне, відсутнє = "невідомо", скрипт не падає):
//   1. Стенд по HTTP  — фінгерпринт web-бандла + хеш swagger.json (працює завжди, без доступів)
//   2. Стенд по SSH   — точний RepoDigest розгорнутих контейнерів (потрібен ssh-доступ)
//   3. Реєстр по HTTP — digest+час збірки тега dev.latest (потрібен GITLAB_TOKEN)
//   4. GitLab API     — комміт + статус pipeline за git-revision (потрібен GITLAB_TOKEN)
//
// Вивід: консольна таблиця (типово) | --json | --html. Exit code для CI.
//
// Usage:
//   node tools/stand-version.mjs                 таблиця в консоль
//   node tools/stand-version.mjs --html          + звіт QA1_AsBuilt/00-infra/stand-version.html
//   node tools/stand-version.mjs --json          машинний вивід
//   node tools/stand-version.mjs --save-baseline зберегти поточний стан як baseline для порівнянь
//   node tools/stand-version.mjs --no-ssh        не ходити по SSH
//
// Exit: 0 = все актуально/невідомо | 10 = є новіший образ у реєстрі (треба апдейтитись)
//       20 = pipeline тега впав (не оновлюйся) | 1 = помилка конфігу/мережі

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Портативний режим: коли запущено як .exe (execPath не node) — дані поряд із exe.
export const PORTABLE = !/[\\/]node(\.exe)?$/i.test(process.execPath);
export const DATA_DIR = PORTABLE ? join(dirname(process.execPath), 'data') : ROOT;
if (PORTABLE) { try { mkdirSync(DATA_DIR, { recursive: true }); } catch {} }
// у портативному — config.env поряд; у dev — звичний .env у корені
const ENV_FILE = PORTABLE ? join(DATA_DIR, 'config.env') : join(ROOT, '.env');

// ── .env (без зовнішніх залежностей: простий парсер) ────────────────────────
function loadEnv(file) {
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(k in process.env)) process.env[k] = v;
  }
}
loadEnv(ENV_FILE);
export { ENV_FILE };
// Вшитий збирач (щоб .exe був самодостатній; джерело — tools/stand-inspect.sh)
const STAND_INSPECT = Buffer.from("IyEvdXNyL2Jpbi9lbnYgYmFzaAojINCS0LjQutC+0L3Rg9GU0YLRjNGB0Y8g0J3QkCDQodCi0JXQndCU0IYuINCU0YDRg9C60YPRlCDQv9C+INGA0Y/QtNC60YMg0L3QsCDQutC+0LbQtdC9INC60L7QvdGC0LXQudC90LXRgCDRltC3INC/0YDQuNCy0LDRgtC90L7Qs9C+INGA0LXRlNGB0YLRgNGDOgojICAg0L7QsdGA0LDQt3xyZXBvRGlnZXN0fGNvbW1pdHxjcmVhdGVkfGJyYW5jaHxidWlsZHxzdGF0ZQojINCU0LbQtdGA0LXQu9CwOiBkb2NrZXIgaW5zcGVjdCArIGRvY2tlciBpbWFnZSBpbnNwZWN0ICjQu9C10LnQsdC70LggcnNjb3JlLiopLgojINCe0L/RgtC40LzRltC30L7QstCw0L3QvjogMyDQstC40LrQu9C40LrQuCBkb2NrZXIg0LLRgdGM0L7Qs9C+ICjQsdCw0YLRh9C10LwpLCDQsCDQvdC1INC/0L4g0LrRltC70YzQutCwINC90LAg0LrQvtC90YLQtdC50L3QtdGAIOKAlAojINGW0L3QsNC60YjQtSDQvdCwINGB0YLQtdC90LTQsNGFINGW0Lcg0LTQtdGB0Y/RgtC60LDQvNC4INGB0LXRgNCy0ZbRgdGW0LIg0L3QtSDQstGB0YLQuNCz0LDRlCDQt9CwIFNTSC3RgtCw0LnQvNCw0YPRgi4KIwojIEZJTFRFUiAoZW52LCDQtNC10YTQvtC70YIgcmVnaXN0cnkucmVub21lLXNtYXJ0LmNvbSkg4oCUINGP0LrRliDQvtCx0YDQsNC30Lgg0LHRgNCw0YLQuC4KIyDQktC40LrQvtGA0LjRgdGC0LDQvdC90Y86IHNzaCA8aG9zdD4gImJhc2ggLXMiIDwgdG9vbHMvc3RhbmQtaW5zcGVjdC5zaApzZXQgLXUKRklMVEVSPSIke0ZJTFRFUjotcmVnaXN0cnkucmVub21lLXNtYXJ0LmNvbX0iCgpuYW1lcz0kKGRvY2tlciBwcyAtYSAtLWZvcm1hdCAne3suTmFtZXN9fScpClsgLXogIiRuYW1lcyIgXSAmJiBleGl0IDAKCmRlY2xhcmUgLUEgQ0lNRyBTVEFURSBJTUdJRCBQUk9KCndoaWxlIElGUz0nfCcgcmVhZCAtciBubSBjaW1nIHN0IGlpZCBwcm9qOyBkbwogIG5tPSIke25tIy99IgogIENJTUdbIiRubSJdPSIkY2ltZyI7IFNUQVRFWyIkbm0iXT0iJHN0IjsgSU1HSURbIiRubSJdPSIkaWlkIjsgUFJPSlsiJG5tIl09IiRwcm9qIgpkb25lIDwgPChkb2NrZXIgaW5zcGVjdCAtLWZvcm1hdCAne3suTmFtZX19fHt7LkNvbmZpZy5JbWFnZX19fHt7LlN0YXRlLlN0YXR1c319fHt7LkltYWdlfX18e3tpbmRleCAuQ29uZmlnLkxhYmVscyAiY29tLmRvY2tlci5jb21wb3NlLnByb2plY3QifX0nICRuYW1lcyAyPi9kZXYvbnVsbCkKCiMg0YPQvdGW0LrQsNC70YzQvdGWIGlkINC+0LHRgNCw0LfRltCyINC70LjRiNC1INC00LvRjyDQv9C+0YLRgNGW0LHQvdC+0LPQviDRgNC10ZTRgdGC0YDRgwppZHM9JChmb3Igbm0gaW4gIiR7IUNJTUdbQF19IjsgZG8KICBjYXNlICIke0NJTUdbJG5tXX0iIGluICoiJEZJTFRFUiIqKSBlY2hvICIke0lNR0lEWyRubV19Ijs7IGVzYWMKZG9uZSB8IHNvcnQgLXUpClsgLXogIiRpZHMiIF0gJiYgZXhpdCAwCgpkZWNsYXJlIC1BIFJEIENPTU1JVCBDUkVBVEVEIEJSQU5DSCBCVUlMRAp3aGlsZSBJRlM9J3wnIHJlYWQgLXIgaWlkIHJkIGNvbW1pdCBjcmVhdGVkIGJyYW5jaCBidWlsZDsgZG8KICBSRFsiJGlpZCJdPSIkcmQiOyBDT01NSVRbIiRpaWQiXT0iJGNvbW1pdCI7IENSRUFURURbIiRpaWQiXT0iJGNyZWF0ZWQiCiAgQlJBTkNIWyIkaWlkIl09IiRicmFuY2giOyBCVUlMRFsiJGlpZCJdPSIkYnVpbGQiCmRvbmUgPCA8KGRvY2tlciBpbWFnZSBpbnNwZWN0IC0tZm9ybWF0ICd7ey5JZH19fHt7aWYgLlJlcG9EaWdlc3RzfX17e2luZGV4IC5SZXBvRGlnZXN0cyAwfX17e2VuZH19fHt7aW5kZXggLkNvbmZpZy5MYWJlbHMgInJzY29yZS5jb21taXQifX18e3suQ3JlYXRlZH19fHt7aW5kZXggLkNvbmZpZy5MYWJlbHMgInJzY29yZS5icmFuY2gifX18e3tpbmRleCAuQ29uZmlnLkxhYmVscyAicnNjb3JlLmJ1aWxkIn19JyAkaWRzIDI+L2Rldi9udWxsKQoKZm9yIG5tIGluICIkeyFDSU1HW0BdfSI7IGRvCiAgaW1nPSIke0NJTUdbJG5tXX0iCiAgY2FzZSAiJGltZyIgaW4gKiIkRklMVEVSIiopIDs7ICopIGNvbnRpbnVlOzsgZXNhYwogIGlpZD0iJHtJTUdJRFskbm1dfSIKICBlY2hvICIke2ltZ318JHtSRFskaWlkXTotfXwke0NPTU1JVFskaWlkXTotfXwke0NSRUFURURbJGlpZF06LX18JHtCUkFOQ0hbJGlpZF06LX18JHtCVUlMRFskaWlkXTotfXwke1NUQVRFWyRubV06LX18JHtQUk9KWyRubV06LX18JHtubX0iCmRvbmUK", "base64").toString("utf8");

// ── Конфіг (дефолти з installer-dev, усе перекривається через .env) ─────────
const CFG = {
  standUrl:  (process.env.STAND_URL || 'https://10.0.31.51').replace(/\/+$/, ''),
  gitlabUrl: (process.env.GITLAB_URL || 'https://gitlab.renome-smart.com').replace(/\/+$/, ''),
  token:     process.env.GITLAB_TOKEN || '',
  // Basic-логін для авторизації в реєстрі. Для PAT зазвичай годиться будь-який
  // юзер + PAT як пароль; лишаю налаштовуваним.
  registryUser: process.env.GITLAB_USER || process.env.REGISTRY_USER || 'token',
  registry: process.env.REGISTRY || 'registry.renome-smart.com:5001',
  registryPath: process.env.REGISTRY_PATH || 'vpo/docker-registry',
  images: (process.env.IMAGES ||
    'rcc-mission-care-service,rcc-mission-care-web,rcc-mission-care-import-service').split(','),
  tag: process.env.IMAGE_TAG || '1.0.0-dev.latest',
  ssh: process.env.SSH_STAND || 'akirpichnikov@10.0.31.51',
  sshKey: process.env.SSH_KEY || '',
  bootstrapKey: process.env.SSH_BOOTSTRAP_KEY || '',
  sshDefaultUser: process.env.SSH_DEFAULT_USER || (process.env.SSH_STAND || 'akirpichnikov@10.0.31.51').split('@')[0],
  branch: process.env.GITLAB_BRANCH || 'dev',
};

const ARGS = new Set(process.argv.slice(2));
const OUT_JSON = ARGS.has('--json');
const OUT_HTML = ARGS.has('--html');
const SAVE_BASELINE = ARGS.has('--save-baseline');
const NO_SSH = ARGS.has('--no-ssh');
const NO_REGISTRY = ARGS.has('--no-registry');
if (ARGS.has('--help') || ARGS.has('-h')) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n')
    .filter(l => l.startsWith('//')).map(l => l.slice(3)).join('\n'));
  process.exit(0);
}

const BASELINE_PATH = PORTABLE ? join(DATA_DIR, 'baseline.json') : join(ROOT, 'QA1_AsBuilt', '00-infra', 'stand-version.baseline.json');
const HTML_PATH = PORTABLE ? join(DATA_DIR, 'stand-version.html') : join(ROOT, 'QA1_AsBuilt', '00-infra', 'stand-version.html');

// Стенд — самопідписаний сертифікат (envoy). Реєстр — валідний nginx.
// Вимикаємо перевірку TLS лише якщо явно не задано (внутрішній QA-інструмент).
if (!process.env.NODE_TLS_REJECT_UNAUTHORIZED) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const log = (...a) => { if (!OUT_JSON) console.error(...a); };
const notes = [];

// ── HTTP helpers ────────────────────────────────────────────────────────────
async function httpGet(url, { headers = {}, timeout = 15000, retries = 1 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeout);
    try {
      const r = await fetch(url, { headers, signal: ac.signal, redirect: 'follow' });
      const body = await r.arrayBuffer();
      return { ok: r.ok, status: r.status, headers: r.headers, buf: Buffer.from(body) };
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
    } finally { clearTimeout(t); }
  }
  throw lastErr;
}
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
// порівняння semver X.Y.Z (числове), не лексичне
const isSemver = (t) => /^\d+\.\d+\.\d+$/.test(t || '');
function cmpSemver(a, b) {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) { if (pa[i] !== pb[i]) return pa[i] - pb[i]; }
  return 0;
}

// ── 1. Стенд по HTTP: фінгерпринт web + backend ──────────────────────────────
async function gatherStandHttp(standUrl = CFG.standUrl) {
  const fp = { webAssets: null, webLastModified: null, swaggerSha: null, error: null };
  try {
    const idx = await httpGet(standUrl + '/');
    fp.webLastModified = idx.headers.get('last-modified');
    const html = idx.buf.toString('utf8');
    const assets = [...html.matchAll(/\/assets\/([\w.-]+\.(?:js|css))/g)].map(m => m[1]).sort();
    fp.webAssets = assets.length ? assets : null;
  } catch (e) { fp.error = String(e.message || e); }
  try {
    const sw = await httpGet(standUrl + '/swagger/v1/swagger.json', { timeout: 20000 });
    if (sw.ok) fp.swaggerSha = sha256(sw.buf);
  } catch { /* backend swagger може бути вимкнений */ }
  return fp;
}

// ── 2. Стенд по SSH: RepoDigest розгорнутих контейнерів ──────────────────────
// Розбір повного посилання образу HOST[:PORT]/PATH.../NAME:TAG на складові.
export function parseImageRef(image) {
  const lastSeg = image.split('/').pop() || '';
  const ci = lastSeg.lastIndexOf(':');
  const tag = ci >= 0 ? lastSeg.slice(ci + 1) : null;
  const pathPart = ci >= 0 ? image.slice(0, image.length - (lastSeg.length - ci)) : image;
  const segs = pathPart.split('/');
  const registryHost = segs[0];             // registry.renome-smart.com:5001
  const name = segs[segs.length - 1];       // transaction-service
  const path = segs.slice(1, -1).join('/'); // rscore/docker-registry
  return { registryHost, path, name, tag };
}
function parseInspect(text) {
  const nv = (s) => (!s || s === '<no value>') ? '' : s; // Go-шаблон друкує <no value>
  return text.trim().split('\n').filter(Boolean).map(line => {
    let [image, repoDigest = '', commit = '', created = '', branch = '', build = '', state = '', project = '', container = ''] = line.split('|');
    repoDigest = nv(repoDigest); commit = nv(commit); created = nv(created);
    branch = nv(branch); build = nv(build); state = nv(state); project = nv(project); container = nv(container);
    const ref = parseImageRef(image);
    return {
      image, name: ref.name, tag: ref.tag, registryHost: ref.registryHost, path: ref.path,
      project: project || null, container: container || null,
      digest: (repoDigest.split('@')[1] || null),
      gitRev: commit || null, branch: branch || null, build: build || null,
      state: state || null, created,
    };
  });
}
// Асинхронний запуск ssh (НЕ блокує event loop, на відміну від spawnSync).
export function sshRun(ssh, sshKey, remoteArgs, { input, timeout = 60000 } = {}) {
  return new Promise((resolve) => {
    const opts = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'StrictHostKeyChecking=accept-new'];
    if (sshKey) opts.push('-o', 'IdentitiesOnly=yes', '-i', sshKey);
    let ch;
    try { ch = spawn('ssh', [...opts, ssh, ...remoteArgs], { windowsHide: true }); }
    catch (e) { return resolve({ status: 1, stdout: '', stderr: String(e.message) }); }
    let out = '', err = '', done = false;
    const finish = (r) => { if (done) return; done = true; clearTimeout(t); resolve(r); };
    const t = setTimeout(() => { try { ch.kill(); } catch {} finish({ status: 124, stdout: out, stderr: err + ' (timeout)' }); }, timeout);
    ch.stdout.on('data', d => { out += d; });
    ch.stderr.on('data', d => { err += d; });
    ch.on('error', e => finish({ status: 1, stdout: out, stderr: String(e.message) }));
    ch.on('close', code => finish({ status: code == null ? 1 : code, stdout: out, stderr: err }));
    if (input != null) { try { ch.stdin.write(input); ch.stdin.end(); } catch {} }
  });
}
async function sshInspect(ssh, sshKey) {
  const res = await sshRun(ssh, sshKey, ['bash -s'], { input: STAND_INSPECT, timeout: 60000 });
  if (res.status !== 0) {
    const e = (res.stderr || '').trim().split('\n')
      .filter(l => !/post-quantum|store now|may need to be upgraded|openssh\.com\/pq/i.test(l))
      .slice(-3).join(' ').trim();
    return { error: e || `ssh exit ${res.status}`, containers: [] };
  }
  return { source: 'ssh', containers: parseInspect(res.stdout) };
}
async function gatherStandSsh(ssh = CFG.ssh, sshKey = CFG.sshKey) {
  const fi = process.argv.indexOf('--stand-file');
  if (fi >= 0 && process.argv[fi + 1]) {
    try { return { source: 'file', containers: parseInspect(readFileSync(process.argv[fi + 1], 'utf8')) }; }
    catch (e) { return { error: 'stand-file: ' + e.message, containers: [] }; }
  }
  if (NO_SSH) return { skipped: 'вимкнено --no-ssh', containers: [] };
  return sshInspect(ssh, sshKey);
}

// ── 3. Реєстр по HTTP: digest тега + git-revision + час збірки ───────────────
// coords = { registryHost, path } — беруться з образу контейнера (різні продукти
// живуть у різних неймспейсах: vpo/docker-registry, rscore/docker-registry, …).
function coordsFor(image, coords) {
  return {
    registryHost: coords?.registryHost || CFG.registry,
    path: coords?.path || CFG.registryPath,
  };
}
async function registryToken(image, coords) {
  const { registryHost, path } = coordsFor(image, coords);
  const scope = `repository:${path}/${image}:pull`;
  const url = `${CFG.gitlabUrl}/jwt/auth?service=container_registry&scope=${encodeURIComponent(scope)}`;
  const basic = Buffer.from(`${CFG.registryUser}:${CFG.token}`).toString('base64');
  const r = await httpGet(url, { headers: { Authorization: `Basic ${basic}` } });
  if (!r.ok) throw new Error(`auth ${r.status}`);
  return JSON.parse(r.buf.toString('utf8')).token;
}
async function gatherRegistryImage(image, tag = CFG.tag, coords = null) {
  const out = { image, tag, digest: null, created: null, gitRev: null, branch: null, build: null, error: null };
  try {
    const { registryHost, path } = coordsFor(image, coords);
    const token = await registryToken(image, coords);
    const base = `https://${registryHost}/v2/${path}/${image}`;
    const accept = [
      'application/vnd.oci.image.index.v1+json',
      'application/vnd.docker.distribution.manifest.list.v2+json',
      'application/vnd.oci.image.manifest.v1+json',
      'application/vnd.docker.distribution.manifest.v2+json',
    ].join(', ');
    const h = { Authorization: `Bearer ${token}`, Accept: accept };
    let m = await httpGet(`${base}/manifests/${encodeURIComponent(tag)}`, { headers: h });
    if (!m.ok) throw new Error(`manifest ${m.status}`);
    out.digest = m.headers.get('docker-content-digest');
    let man = JSON.parse(m.buf.toString('utf8'));
    // multi-arch index → беремо перший amd64/linux
    if (Array.isArray(man.manifests)) {
      const pick = man.manifests.find(x => x.platform?.architecture === 'amd64') || man.manifests[0];
      const mm = await httpGet(`${base}/manifests/${pick.digest}`, { headers: h });
      man = JSON.parse(mm.buf.toString('utf8'));
    }
    // config blob → created + labels
    if (man.config?.digest) {
      const cfg = await httpGet(`${base}/blobs/${man.config.digest}`, { headers: h });
      if (cfg.ok) {
        const j = JSON.parse(cfg.buf.toString('utf8'));
        out.created = j.created || null;
        const labels = j.config?.Labels || j.container_config?.Labels || {};
        out.gitRev = labels['rscore.commit'] || labels['org.opencontainers.image.revision'] || null;
        out.branch = labels['rscore.branch'] || null;
        out.build = labels['rscore.build'] || null;
      }
    }
  } catch (e) { out.error = String(e.message || e); }
  return out;
}

// Перелік гілок образу з тегів реєстру. Тег: 1.0.0-<branch>.(latest|<build>).
// Повертає [{ branch, latestTag, maxBuild }] відсортовано (dev перший).
async function listBranches(image, coords = null) {
  if (!CFG.token) return [];
  try {
    const { registryHost, path } = coordsFor(image, coords);
    const token = await registryToken(image, coords);
    const r = await httpGet(`https://${registryHost}/v2/${path}/${image}/tags/list`,
      { headers: { Authorization: `Bearer ${token}` }, timeout: 20000 });
    if (!r.ok) return [];
    const tags = JSON.parse(r.buf.toString('utf8')).tags || [];
    const map = new Map();     // branch → { latestTag, maxBuild, builds:[{n,tag}] }
    const pinned = [];         // теги без гілки (фіксовані версії, напр. 6.6.3)
    for (const t of tags) {
      const m = /^(.*?)-(.+)\.(latest|\d+)$/.exec(t); // <version>-<branch>.<suffix>
      if (!m) { if (/^[\w.]+$/.test(t) && t !== 'latest') pinned.push(t); continue; }
      const branch = m[2], suffix = m[3];
      const e = map.get(branch) || { branch, latestTag: null, maxBuild: -1, builds: [] };
      if (suffix === 'latest') e.latestTag = t;
      else { const n = +suffix; e.builds.push({ n, tag: t }); if (n > e.maxBuild) e.maxBuild = n; }
      map.set(branch, e);
    }
    const arr = [...map.values()].map(e => ({
      branch: e.branch, latestTag: e.latestTag, maxBuild: e.maxBuild < 0 ? null : e.maxBuild,
      builds: e.builds.sort((a, b) => b.n - a.n).slice(0, 20).map(b => b.tag), // останні 20 білдів
    }));
    arr.sort((a, b) => (a.branch === 'dev' ? -1 : b.branch === 'dev' ? 1 : a.branch.localeCompare(b.branch)));
    if (pinned.length) arr.push({ branch: '(фіксовані версії)', latestTag: null, maxBuild: null, builds: pinned.sort(cmpSemver).reverse().slice(0, 20) });
    return arr;
  } catch { return []; }
}

// Стан гілки dev для образу (тег того ж <version> з гілкою dev) + статус TeamCity.
async function branchState(image, devTag, coords = null) {
  const reg = await gatherRegistryImage(image, devTag, coords);
  const tm = tagBuildMeta(devTag);
  reg.branch ||= tm.branch;
  reg.build ||= tm.build;
  const tc = await tcBuild(image, { build: reg?.build, commit: reg?.gitRev, branch: reg?.branch, registryPath: coords?.path });
  reg.gitRev ||= tc?.commit;
  return { branch: reg.branch || 'dev', tag: devTag, digest: reg.digest, build: reg.build, gitRev: reg.gitRev, created: reg.created, teamcity: tc, error: reg.error };
}

// ── 4. GitLab API: комміт + статус pipeline ──────────────────────────────────
async function gitlabApi(path) {
  const r = await httpGet(`${CFG.gitlabUrl}/api/v4/${path}`, {
    headers: { 'PRIVATE-TOKEN': CFG.token },
  });
  if (!r.ok) throw new Error(`gitlab ${path} → ${r.status}`);
  return JSON.parse(r.buf.toString('utf8'));
}
async function gatherGitlab(gitRev, project) {
  if (!gitRev || !project) return null;
  const pid = encodeURIComponent(project);
  const out = { project, commit: null, pipeline: null, error: null };
  try {
    out.commit = await gitlabApi(`projects/${pid}/repository/commits/${gitRev}`);
    // статус збірки саме цього коміта (pipeline, що зібрав образ)
    const pls = await gitlabApi(`projects/${pid}/repository/commits/${gitRev}/statuses?per_page=1`)
      .catch(() => null);
    if (Array.isArray(pls) && pls[0]) out.pipeline = { status: pls[0].status, url: pls[0].target_url };
  } catch (e) { out.error = String(e.message || e); }
  return out;
}

// ── TeamCity: статус збірки («чи норм збілджено») ────────────────────────────
// GitLab CI тут не використовується — статус білда живе в TeamCity.
// Прив'язка: rscore.build (№ білда) + buildType конфіга, fallback — git-revision.
const TC = {
  url: (process.env.TEAMCITY_URL || 'https://teamcity.renome-smart.com').replace(/\/+$/, ''),
  token: process.env.TEAMCITY_TOKEN || '',
};
const TC_BUILDTYPE = (() => {
  const def = {
    'rcc-mission-care-service': 'RsCore_Products_RCCMissionCare_RCCMissionCareService',
    'rcc-mission-care-web': 'RsCore_Products_RCCMissionCare_RCCMissionCareWeb',
    'rcc-mission-care-import-service': 'RsCore_Products_RCCMissionCare_RCCImportServiceService',
  };
  try { return process.env.TEAMCITY_BUILDTYPE_MAP ? { ...def, ...JSON.parse(process.env.TEAMCITY_BUILDTYPE_MAP) } : def; }
  catch { return def; }
})();
const _tcNumberCache = new Map();
const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
function tagBuildMeta(tag) {
  const m = /^(.*?)-(.+)\.(latest|\d+)$/.exec(String(tag || ''));
  return m ? { branch: m[2], build: m[3] === 'latest' ? null : m[3] } : { branch: null, build: null };
}
function tcResult(b) {
  return b ? { number: b.number, status: b.status, state: b.state, branch: b.branchName,
    finished: b.finishDate, url: b.webUrl, buildTypeId: b.buildTypeId,
    commit: b.revisions?.revision?.[0]?.version || null } : null;
}
async function tcBuildsByNumber(build) {
  if (_tcNumberCache.has(build)) return _tcNumberCache.get(build);
  const promise = (async () => {
    try {
      const fields = 'build(id,number,status,state,branchName,finishDate,webUrl,buildTypeId,revisions(revision(version)))';
      const r = await httpGet(`${TC.url}/app/rest/builds?locator=${encodeURIComponent(`number:${build},count:200`)}&fields=${encodeURIComponent(fields)}`,
        { headers: { Authorization: `Bearer ${TC.token}`, Accept: 'application/json' }, timeout: 20000 });
      if (!r.ok) return [];
      return JSON.parse(r.buf.toString('utf8')).build || [];
    } catch { return []; }
  })();
  _tcNumberCache.set(build, promise);
  return promise;
}
function tcCandidateScore(image, candidate, branch, registryPath) {
  const imageNorm = normName(image), btNorm = normName(candidate.buildTypeId);
  const generic = new Set(['service', 'portal', 'web', 'api', 'app', 'backend', 'frontend']);
  const tokens = String(image || '').toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 2 && !generic.has(t));
  let score = imageNorm.length >= 8 && btNorm.includes(imageNorm) ? 100 : 0;
  for (const token of tokens) if (btNorm.includes(token)) score += 18;
  const ns = String(registryPath || '').split('/')[0].toLowerCase();
  if (ns.length > 2 && btNorm.includes(normName(ns))) score += 25;
  if (branch && candidate.branchName && String(candidate.branchName).replace(/^refs\/heads\//, '') === branch) score += 20;
  return score;
}
async function tcBuild(image, { build, commit, branch, registryPath } = {}) {
  if (!TC.token) return null;
  const bt = TC_BUILDTYPE[image];
  const locators = [];
  if (bt && build) locators.push(`number:${build},buildType:${bt},branch:(default:any)`);
  if (commit) locators.push(`revision:${commit},branch:(default:any)`);
  if (bt && commit) locators.push(`revision:${commit},buildType:${bt},branch:(default:any)`);
  if (bt && !build && !commit) locators.push(`buildType:${bt},branch:${branch || '(default:any)'},state:finished`);
  for (const loc of locators) {
    try {
      const r = await httpGet(`${TC.url}/app/rest/builds?locator=${encodeURIComponent(loc)},count:1&fields=build(number,status,state,branchName,finishDate,webUrl,buildTypeId,revisions(revision(version)))`,
        { headers: { Authorization: `Bearer ${TC.token}`, Accept: 'application/json' } });
      if (!r.ok) continue;
      const j = JSON.parse(r.buf.toString('utf8'));
      const b = (j.build || [])[0];
      if (b) return tcResult(b);
    } catch { /* next locator */ }
  }
  // Generic fallback for images without OCI/rscore labels: build number and branch
  // are derived from a tag like 1.4.1-dev.108, then the best TeamCity build type
  // is selected by image/namespace/branch similarity. Ambiguous matches are rejected.
  if (!bt && build) {
    const ranked = (await tcBuildsByNumber(build)).map(b => ({ b, score: tcCandidateScore(image, b, branch, registryPath) }))
      .filter(x => x.score >= 45).sort((a, b) => b.score - a.score);
    if (ranked[0] && (!ranked[1] || ranked[0].score - ranked[1].score >= 10 || ranked[0].b.buildTypeId === ranked[1].b.buildTypeId))
      return tcResult(ranked[0].b);
  }
  return null;
}

// Останній успішний завершений build гілки. Саме його revision є базою для
// GitLab compare «що вже закомічено, але ще не збілджено». Образ на стенді може
// бути старішим і не повинен штучно збільшувати цей лічильник.
async function tcLatestSuccessful(buildTypeId, branch) {
  if (!TC.token || !buildTypeId) return null;
  try {
    const locator = `buildType:${buildTypeId},branch:${branch || '(default:any)'},status:SUCCESS,state:finished,count:1`;
    const fields = 'build(id,number,status,state,branchName,finishDate,webUrl,buildTypeId,revisions(revision(version)))';
    const r = await httpGet(`${TC.url}/app/rest/builds?locator=${encodeURIComponent(locator)}&fields=${encodeURIComponent(fields)}`,
      { headers: { Authorization: `Bearer ${TC.token}`, Accept: 'application/json' }, timeout: 20000 });
    if (!r.ok) return null;
    const j = JSON.parse(r.buf.toString('utf8'));
    return tcResult((j.build || [])[0]);
  } catch { return null; }
}

// Образ → GitLab-проєкт. Спершу GITLAB_PROJECT_MAP / GITLAB_PROJECT, інакше —
// автопошук у GitLab за точним збігом імені проєкту (кешується). Працює для
// будь-якого продукту (rcc, rscore, retail, …) без ручної мапи.
const _projCache = new Map();
async function projectForImage(image, commit = null) {
  if (_projCache.has(image)) return _projCache.get(image);
  let proj = null;
  try {
    const m = process.env.GITLAB_PROJECT_MAP ? JSON.parse(process.env.GITLAB_PROJECT_MAP) : null;
    if (m && m[image]) proj = m[image];
  } catch { /* ignore */ }
  if (!proj && process.env.GITLAB_PROJECT) proj = process.env.GITLAB_PROJECT;
  if (!proj && CFG.token) {
    try {
      const parts = String(image).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
      const terms = [image, parts.join(' ')];
      if (parts.length >= 3) terms.push(parts.slice(1).join('-'), parts.slice(1).join(' '));
      if (parts.length >= 3) terms.push(parts.slice(0, -1).join(' '));
      if (parts.length >= 4 && ['service', 'portal', 'web', 'api', 'backend', 'frontend'].includes(parts.at(-1)))
        terms.push(parts.slice(0, -2).join(' '));
      const uniqueTerms = [...new Set(terms.map(x => String(x).trim()).filter(x => x.length >= 3))];
      const found = new Map();
      for (const term of uniqueTerms) {
        const arr = await gitlabApi(`search?scope=projects&search=${encodeURIComponent(term)}&per_page=50`);
        for (const p of arr || []) found.set(p.id, p);
      }
      const aliases = new Set(uniqueTerms.map(normName));
      const imageTokens = new Set(parts.filter(t => t.length > 2));
      const candidates = [...found.values()].map(p => {
        const pn = normName(p.path);
        const namespace = String(p.path_with_namespace || '').toLowerCase();
        const projectTokens = new Set(namespace.split(/[^a-z0-9]+/).filter(Boolean));
        const overlap = [...imageTokens].filter(t => projectTokens.has(t)).length;
        let score = p.path === image ? 120 : aliases.has(pn) ? 90 : normName(namespace).includes(normName(image)) ? 60 : overlap * 15;
        return { p, score };
      }).filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 20);
      if (commit) {
        for (const x of candidates) {
          try {
            await gitlabApi(`projects/${x.p.id}/repository/commits/${encodeURIComponent(commit)}`);
            proj = x.p.path_with_namespace; break;
          } catch { /* candidate does not contain this commit */ }
        }
      }
      if (!proj && candidates[0]?.score >= 100) proj = candidates[0].p.path_with_namespace;
    } catch { /* ignore */ }
  }
  _projCache.set(image, proj);
  return proj;
}

// Нові коміти між розгорнутим і реєстровим образом (що саме зміниться при апдейті).
async function gatherCommits(project, from, to) {
  if (!project || !from || !to) return null;
  if (from === to) return { count: 0, commits: [], sameCommit: true };
  try {
    const pid = encodeURIComponent(project);
    const j = await gitlabApi(`projects/${pid}/repository/compare?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&straight=true`);
    const cs = j.commits || [];
    return { count: cs.length, commits: cs.slice(0, 20).map(c => ({ id: c.short_id, title: c.title, author: c.author_name })) };
  } catch (e) { return { error: String(e.message || e) }; }
}

// Коміти у гілці, під які ще НЕ зібрано образ: HEAD гілки vs комміт останнього білда.
async function gatherUnbuilt(project, branch, builtSHA) {
  if (!project || !branch || !builtSHA) return null;
  try {
    const pid = encodeURIComponent(project);
    const br = await gitlabApi(`projects/${pid}/repository/branches/${encodeURIComponent(branch)}`)
      .catch(e => { if (String(e.message).includes('404')) return null; throw e; });
    if (!br) return { note: `гілку «${branch}» не знайдено в git (могла бути видалена/змержена)` };
    const head = br?.commit?.id;
    if (!head) return null;
    const headInfo = { id: br.commit.short_id, title: br.commit.title, date: br.commit.committed_date };
    const webBase = `${CFG.gitlabUrl}/${project}`;
    if (head === builtSHA || head.startsWith(builtSHA) || builtSHA.startsWith(head)) return { count: 0, head: headInfo };
    const j = await gitlabApi(`projects/${pid}/repository/compare?from=${encodeURIComponent(builtSHA)}&to=${encodeURIComponent(head)}&straight=true`);
    const cs = j.commits || [];
    // посилання на порівняння змін у GitLab (що саме не зібрано)
    const compareUrl = `${webBase}/-/compare/${encodeURIComponent(builtSHA)}...${encodeURIComponent(head)}`;
    return { count: cs.length, head: headInfo, commits: cs.slice(0, 20).map(c => ({ id: c.short_id, title: c.title, author: c.author_name })), compareUrl };
  } catch (e) { return { error: String(e.message || e) }; }
}

// ── Порівняння + вердикт ──────────────────────────────────────────────────
function verdictFor(deployedDigest, registryDigest, tcTargetStatus) {
  if (!deployedDigest || !registryDigest)
    return { code: 0, mark: '⚪️', text: 'невідомо (немає digest з обох боків)' };
  if (deployedDigest === registryDigest)
    return { code: 0, mark: '✅', text: 'актуально (digest збігається з реєстром)' };
  // є новіший образ у реєстрі — але чи його білд у TeamCity успішний?
  if (tcTargetStatus && tcTargetStatus !== 'SUCCESS')
    return { code: 20, mark: '❌', text: `у реєстрі новіший образ, але його білд у TeamCity — ${tcTargetStatus}; не оновлюйся` };
  return { code: 10, mark: '🔶', text: 'у реєстрі новіший образ (білд успішний) — треба апдейтитись' };
}

// Паралельний map з обмеженням одночасних задач; зберігає порядок.
async function runPool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// ── Збір усіх даних (переюзається CLI і панеллю) ─────────────────────────────
export async function collect({ withBranches = false, server = null } = {}) {
  const standUrl = server?.standUrl || CFG.standUrl;
  const sshHost = server?.ssh || CFG.ssh;
  const sshKey = server?.sshKey || CFG.sshKey;
  const [standHttp, ssh] = await Promise.all([gatherStandHttp(standUrl), gatherStandSsh(sshHost, sshKey)]);

  // Джерело — розгорнуті контейнери (кожен несе свій реєстр/шлях/тег).
  let units;
  if (ssh.containers?.length) {
    const seen = new Set();
    units = ssh.containers.filter(c => {
      const k = (c.project || '') + '/' + c.name + ':' + c.tag; // різні продукти (rscore/retail/x5) не зливати
      if (seen.has(k)) return false; seen.add(k); return true;
    });
  } else if (ssh.error) {
    units = []; // SSH не вдався — НЕ підставляти дефолтні образи (вводило в оману), показати помилку
  } else {
    units = CFG.images.map(image => ({ image, name: image, tag: CFG.tag, registryHost: null, path: null }));
  }

  // Обробка одного контейнера (усі HTTP-виклики всередині).
  async function buildRow(source) {
    const d = { ...source };
    const image = d.name;                       // ім'я образу в реєстрі (напр. transaction-service)
    const coords = { registryHost: d.registryHost, path: d.path };
    const tag = d.tag || CFG.tag;               // реєстр перевіряємо за РЕАЛЬНО розгорнутим тегом
    const dm = tagBuildMeta(d.tag);
    d.branch ||= dm.branch; d.build ||= dm.build;
    const reg = (CFG.token && !NO_REGISTRY) ? await gatherRegistryImage(image, tag, coords)
      : { image, tag, digest: null, created: null, gitRev: null, branch: null, build: null, error: CFG.token ? null : 'немає токена' };
    const rm = tagBuildMeta(reg.tag || tag);
    reg.branch ||= rm.branch; reg.build ||= rm.build;
    const [tcDeployed, tcRegistry] = await Promise.all([
      tcBuild(image, { build: d.build, commit: d.gitRev, branch: d.branch, registryPath: coords.path }),
      tcBuild(image, { build: reg?.build, commit: reg?.gitRev, branch: reg?.branch, registryPath: coords.path }),
    ]);
    d.gitRev ||= tcDeployed?.commit;
    reg.gitRev ||= tcRegistry?.commit;
    const builtBranch = reg.branch || d.branch || tcRegistry?.branch || tcDeployed?.branch;
    const buildTypeId = tcRegistry?.buildTypeId || tcDeployed?.buildTypeId || TC_BUILDTYPE[image] || null;
    const tcLatest = await tcLatestSuccessful(buildTypeId, builtBranch);
    const lastBuiltCommit = tcLatest?.commit || reg.gitRev || d.gitRev;
    const project = CFG.token ? await projectForImage(image, lastBuiltCommit) : null;
    const gl = project ? await gatherGitlab(lastBuiltCommit, project) : null;
    const [commits, unbuilt] = await Promise.all([
      // що дасть апдейт: коміти між розгорнутим і реєстровим образом
      (project && d.gitRev && reg.gitRev && d.gitRev !== reg.gitRev) ? gatherCommits(project, d.gitRev, reg.gitRev) : null,
      // що в гілці ще НЕ зібрано: HEAD гілки vs комміт останнього білда
      (project && builtBranch && lastBuiltCommit) ? gatherUnbuilt(project, builtBranch, lastBuiltCommit) : null,
    ]);
    const v = verdictFor(d.digest, reg.digest, tcRegistry?.status);
    // дрейф dev: якщо розгорнута гілка не dev — глянути dev.latest тієї ж версії
    const m = /^(.*?)-(.+)\.(latest|\d+)$/.exec(tag || '');
    const deployedBranch = d.branch || (m ? m[2] : null);
    let devState = null;
    if (CFG.token && m && deployedBranch && deployedBranch !== 'dev') {
      devState = await branchState(image, `${m[1]}-dev.latest`, coords);
    }
    const branches = withBranches ? await listBranches(image, coords) : undefined;
    // для пінняних версій (X.Y.Z) — чи є новіша пінняна версія в реєстрі
    let newerVersion = null;
    if (branches && isSemver(d.tag)) {
      const pg = branches.find(b => b.branch === '(фіксовані версії)');
      const cand = (pg?.builds || []).filter(isSemver).sort(cmpSemver);
      const newest = cand[cand.length - 1];
      if (newest && cmpSemver(newest, d.tag) > 0) newerVersion = newest;
    }
    // для гілкових тегів (X.Y.Z-<branch>.<N>, у т.ч. dev.latest) — чи є новіший ЗІБРАНИЙ
    // білд ТІЄЇ Ж гілки в реєстрі (maxBuild > розгорнутого номера білда). Раніше не показувалось:
    // блок вище рахував лише для пінняних semver, тому для dev видно було лише «гілка +N».
    if (!newerVersion && branches && deployedBranch) {
      const bg = branches.find(b => b.branch === deployedBranch);
      const dn = Number(d.build != null ? d.build : (m && m[3] !== 'latest' ? m[3] : NaN));
      if (bg && bg.maxBuild != null && Number.isFinite(dn) && bg.maxBuild > dn) {
        // КОНКРЕТНЕ число білда (напр. 1.0.0-dev.210), а не мутабельний dev.latest.
        // builds — це рядки тегів; шукаємо той, що закінчується на «.<maxBuild>», інакше будуємо з префікса.
        const bt = (bg.builds || []).find(t => new RegExp('\\.' + bg.maxBuild + '$').test(String(t)));
        newerVersion = bt || (m ? `${m[1]}-${deployedBranch}.${bg.maxBuild}` : null);
      }
    }
    // посилання на конфіг білда в TeamCity (де кнопка Run), з гілкою
    let buildConfigUrl = null;
    const tcUrl = tcRegistry?.url || tcDeployed?.url;
    const btm = tcUrl && /\/buildConfiguration\/([^/?#]+)/.exec(tcUrl);
    if (btm) buildConfigUrl = `${TC.url}/buildConfiguration/${btm[1]}` + (builtBranch ? `?branch=${encodeURIComponent(builtBranch)}` : '');
    return {
      image, deployed: d, registry: reg, gitlab: gl,
      teamcity: { deployed: tcDeployed, registry: tcRegistry, latest: tcLatest, buildTypeId },
      devState, branches, commits, unbuilt, unbuiltBasis: tcLatest?.commit ? 'teamcity' : 'image-fallback', newerVersion, buildConfigUrl, verdict: v,
    };
  }
  // Паралельно з обмеженням (щоб не завалити реєстр/TeamCity сотнями запитів).
  const rows = await runPool(units, 8, buildRow);

  // baseline: чи змінився фінгерпринт стенду з минулого запуску
  let baseline = null;
  if (existsSync(BASELINE_PATH)) { try { baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')); } catch {} }
  const fpChanged = baseline ? JSON.stringify(baseline.standHttp) !== JSON.stringify(standHttp) : null;

  return {
    generatedAt: new Date().toISOString(),
    serverName: server?.name || null,
    stand: standUrl, registry: `${CFG.registry}/${CFG.registryPath}`, tag: CFG.tag,
    standHttp, ssh, rows,
    fingerprintVsBaseline: baseline
      ? { changed: fpChanged, baselineAt: baseline.generatedAt }
      : { changed: null, note: 'baseline ще не збережено (--save-baseline)' },
    notes,
  };
}
export { CFG, listBranches, branchState, gatherRegistryImage, tcBuild, sshInspect };
// sshRun вже експортовано вище (для панелі — деплой)

// Оновлення токенів наживо (для сторінки налаштувань — без перезапуску).
export function setTokens({ gitlabToken, gitlabUser, teamcityToken, sshKey, bootstrapKey, sshDefaultUser } = {}) {
  if (gitlabToken != null && gitlabToken !== '') CFG.token = gitlabToken;
  if (gitlabUser != null && gitlabUser !== '') CFG.registryUser = gitlabUser;
  if (teamcityToken != null && teamcityToken !== '') TC.token = teamcityToken;
  if (sshKey != null) CFG.sshKey = sshKey; // шлях до SSH-ключа (можна очистити порожнім)
  if (bootstrapKey != null) CFG.bootstrapKey = bootstrapKey || CFG.sshKey;
  if (sshDefaultUser != null && sshDefaultUser !== '') CFG.sshDefaultUser = sshDefaultUser;
  _projCache.clear(); // проєкти могли не резолвитись без токена — скинути кеш
}
export function tokenStatus() {
  return { gitlab: !!CFG.token, gitlabUser: CFG.registryUser, teamcity: !!TC.token,
    sshKey: CFG.sshKey || '', bootstrapKey: CFG.bootstrapKey || '',
    sshDefaultUser: CFG.sshDefaultUser || '', gitlabUrl: CFG.gitlabUrl, teamcityUrl: TC.url };
}

// ── main (лише при прямому запуску) ──────────────────────────────────────────
async function main() {
  log(`\nСтенд: ${CFG.standUrl}   Реєстр: ${CFG.registry}/${CFG.registryPath}   Тег: ${CFG.tag}`);
  log(`GITLAB_TOKEN: ${CFG.token ? 'є' : 'НЕМАЄ (реєстр пропускається)'}   TEAMCITY: ${TC.token ? 'є' : 'НЕМАЄ'}   SSH: ${NO_SSH ? 'off' : CFG.ssh}\n`);
  const result = await collect();

  if (OUT_JSON) { process.stdout.write(JSON.stringify(result, null, 2) + '\n'); }
  else { printConsole(result); }
  if (OUT_HTML) { renderHtml(result); log(`\nHTML-звіт: ${HTML_PATH}`); }
  if (SAVE_BASELINE) {
    mkdirSync(dirname(BASELINE_PATH), { recursive: true });
    writeFileSync(BASELINE_PATH, JSON.stringify(result, null, 2));
    log(`\nBaseline збережено: ${BASELINE_PATH}`);
  }
  process.exit(Math.max(0, ...result.rows.map(r => r.verdict.code)));
}

// запускаємо main лише якщо файл викликано напряму (не при import з панелі)
// лише при прямому запуску саме цього файлу (не з бандла панелі)
if (process.argv[1] && /stand-version\.mjs$/.test(process.argv[1]) && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(e => { console.error('FATAL:', e); process.exit(1); });
}

// ── Рендер: консоль ──────────────────────────────────────────────────────────
function short(d) { return d ? d.replace('sha256:', '').slice(0, 12) : '—'; }
function ago(iso) {
  if (!iso) return '—';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (isNaN(s)) return iso;
  if (s < 3600) return Math.round(s / 60) + ' хв тому';
  if (s < 86400) return Math.round(s / 3600) + ' год тому';
  return Math.round(s / 86400) + ' дн тому';
}
function printConsole(r) {
  console.log('┌─ Версії сервісів на стенді vs реєстр (' + r.generatedAt + ')');
  for (const row of r.rows) {
    const d = row.deployed, rg = row.registry;
    const bb = (x) => (x?.branch || x?.build) ? `  [${x.branch || '?'} #${x.build || '?'}]` : '';
    const st = d?.state && d.state !== 'running' ? `  ⛔ ${d.state}` : '';
    console.log(`│\n│ ${row.verdict.mark}  ${row.image}${d?.tag ? '  тег ' + d.tag : ''}${st}`);
    console.log(`│    розгорнуто:  digest ${short(d?.digest)}  git ${short(d?.gitRev)}${bb(d)}  ${d?.created ? ago(d.created) : ''}`);
    console.log(`│    у реєстрі:   digest ${short(rg?.digest)}  git ${short(rg?.gitRev)}${bb(rg)}  зібрано ${ago(rg?.created)}${rg?.error ? '  (' + rg.error + ')' : ''}`);
    if (row.gitlab?.commit) console.log(`│    комміт:      ${row.gitlab.commit.short_id} — ${(row.gitlab.commit.title || '').slice(0, 60)}`);
    const tcStr = (t) => t ? `#${t.number} ${t.status}/${t.state}` : '—';
    if (row.teamcity?.deployed || row.teamcity?.registry)
      console.log(`│    TeamCity:    розгорнуто ${tcStr(row.teamcity?.deployed)}   реєстр ${tcStr(row.teamcity?.registry)}${row.teamcity?.registry?.url ? '  ' + row.teamcity.registry.url : ''}`);
    console.log(`│    → ${row.verdict.text}`);
  }
  console.log('│');
  console.log(`│ Web-бандл на стенді: ${(r.standHttp.webAssets || ['—']).join(', ')}`);
  console.log(`│ Swagger sha256:      ${short(r.standHttp.swaggerSha ? 'sha256:' + r.standHttp.swaggerSha : null)}   Front last-modified: ${r.standHttp.webLastModified || '—'}`);
  const b = r.fingerprintVsBaseline;
  console.log(`│ Фінгерпринт vs baseline: ${b.changed === null ? (b.note || '—') : (b.changed ? '⚠️ ЗМІНИВСЯ з ' + b.baselineAt : 'без змін з ' + b.baselineAt)}`);
  if (r.ssh?.error) console.log(`│ SSH: ${r.ssh.error}`);
  console.log('└─');
}

// ── Рендер: HTML (у стилі інших звітів проєкту) ──────────────────────────────
function esc(s) { return String(s ?? '—').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
function tcHtml(t) {
  if (!t) return '—';
  const cls = t.status === 'SUCCESS' ? '#22c55e' : (t.status ? '#ef4444' : 'var(--mut)');
  const s = `<b style="color:${cls}">#${esc(t.number)} ${esc(t.status)}</b>`;
  return t.url ? `<a href="${esc(t.url)}" style="text-decoration:none">${s}</a>` : s;
}
function renderHtml(r) {
  const rowsHtml = r.rows.map(row => `
    <div class="card ${row.verdict.code === 0 ? 'ok' : row.verdict.code === 10 ? 'warn' : 'bad'}">
      <h3>${row.verdict.mark} ${esc(row.image)}${row.deployed?.tag ? ` <span class="tag">${esc(row.deployed.tag)}</span>` : ''}</h3>
      <table>
        <tr><th>розгорнуто (стенд)</th><td><code>${esc(short(row.deployed?.digest))}</code> · git <code>${esc(short(row.deployed?.gitRev))}</code>${row.deployed?.branch || row.deployed?.build ? ` · <b>${esc(row.deployed?.branch || '?')} #${esc(row.deployed?.build || '?')}</b>` : ''} · ${esc(row.deployed?.created ? ago(row.deployed.created) : '—')}</td></tr>
        <tr><th>у реєстрі (${esc(row.registry?.tag || CFG.tag)})</th><td><code>${esc(short(row.registry?.digest))}</code> · git <code>${esc(short(row.registry?.gitRev))}</code>${row.registry?.branch || row.registry?.build ? ` · <b>${esc(row.registry?.branch || '?')} #${esc(row.registry?.build || '?')}</b>` : ''} · зібрано ${esc(ago(row.registry?.created))}${row.registry?.error ? ' <span class="err">(' + esc(row.registry.error) + ')</span>' : ''}</td></tr>
        ${row.gitlab?.commit ? `<tr><th>комміт</th><td><code>${esc(row.gitlab.commit.short_id)}</code> — ${esc((row.gitlab.commit.title || '').slice(0, 80))}</td></tr>` : ''}
        ${(row.teamcity?.deployed || row.teamcity?.registry) ? `<tr><th>TeamCity білд</th><td>розгорнуто: ${tcHtml(row.teamcity?.deployed)} · реєстр: ${tcHtml(row.teamcity?.registry)}</td></tr>` : ''}
        <tr><th>вердикт</th><td><b>${esc(row.verdict.text)}</b></td></tr>
      </table>
    </div>`).join('');
  const b = r.fingerprintVsBaseline;
  const html = `<!doctype html><html lang="uk"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Версії на стенді · RCC</title>
<style>
  :root{--bg:#f8fafc;--fg:#0f172a;--mut:#64748b;--bd:#e2e8f0;--card:#fff}
  @media(prefers-color-scheme:dark){:root{--bg:#0f172a;--fg:#e2e8f0;--mut:#94a3b8;--bd:#1e293b;--card:#1e293b}}
  body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,Segoe UI,sans-serif;padding:24px}
  h1{font-size:20px;margin:0 0 4px} .sub{color:var(--mut);margin:0 0 20px;font-size:13px}
  .tag{font-size:11px;font-weight:600;background:rgba(59,130,246,.15);color:#3b82f6;padding:2px 7px;border-radius:10px;vertical-align:middle}
  .card{background:var(--card);border:1px solid var(--bd);border-left-width:4px;border-radius:8px;padding:14px 16px;margin:0 0 14px;max-width:820px}
  .card.ok{border-left-color:#22c55e}.card.warn{border-left-color:#f59e0b}.card.bad{border-left-color:#ef4444}
  .card h3{margin:0 0 8px;font-size:15px}
  table{width:100%;border-collapse:collapse} th{text-align:left;color:var(--mut);font-weight:500;width:190px;vertical-align:top;padding:3px 8px 3px 0}
  td{padding:3px 0} code{background:rgba(127,127,127,.15);padding:1px 5px;border-radius:4px;font-size:12px}
  .err{color:#ef4444} a{color:#3b82f6}
  .fp{max-width:820px;color:var(--mut);font-size:13px;border-top:1px solid var(--bd);padding-top:12px;margin-top:6px}
</style></head><body>
  <h1>Версії сервісів на стенді vs реєстр</h1>
  <p class="sub">${esc(r.stand)} · тег <code>${esc(r.tag)}</code> · згенеровано ${esc(r.generatedAt)}</p>
  ${rowsHtml}
  <div class="fp">
    <b>Web-бандл:</b> ${esc((r.standHttp.webAssets || ['—']).join(', '))}<br>
    <b>Swagger sha256:</b> <code>${esc(short(r.standHttp.swaggerSha ? 'sha256:' + r.standHttp.swaggerSha : null))}</code> · <b>Front last-modified:</b> ${esc(r.standHttp.webLastModified)}<br>
    <b>Фінгерпринт vs baseline:</b> ${b.changed === null ? esc(b.note || '—') : (b.changed ? '⚠️ змінився з ' + esc(b.baselineAt) : 'без змін з ' + esc(b.baselineAt))}
    ${r.ssh?.error ? `<br><b>SSH:</b> <span class="err">${esc(r.ssh.error)}</span>` : ''}
  </div>
</body></html>`;
  mkdirSync(dirname(HTML_PATH), { recursive: true });
  writeFileSync(HTML_PATH, html);
}

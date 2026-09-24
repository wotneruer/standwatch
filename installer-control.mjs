// Read-only GitLab installer discovery and manifest extraction.
// No server commands and no GitLab mutations live in this module.

import { createHash } from 'node:crypto';

const cleanBase = value => String(value || '').replace(/\/+$/, '');

async function glRequest({ baseUrl, token }, path) {
  const response = await fetch(cleanBase(baseUrl) + '/api/v4/' + path, {
    headers: { 'PRIVATE-TOKEN': token, Accept: 'application/json' },
  });
  if (!response.ok) throw new Error('GitLab ' + response.status + ': ' + path);
  return response;
}

async function glJson(config, path) {
  return (await glRequest(config, path)).json();
}

async function paged(config, path, limit = 500) {
  const out = [];
  let page = 1;
  while (out.length < limit) {
    const separator = path.includes('?') ? '&' : '?';
    const response = await glRequest(config, path + separator + 'per_page=100&page=' + page);
    const values = await response.json();
    if (Array.isArray(values)) out.push(...values);
    const next = Number(response.headers.get('x-next-page') || 0);
    if (!next) break;
    page = next;
  }
  return out.slice(0, limit);
}

export async function searchInstallerProjects(config, search = 'installer') {
  const projects = await paged(config,
    'projects?membership=true&simple=true&order_by=last_activity_at&sort=desc&search=' + encodeURIComponent(search), 200);
  return projects
    .filter(project => /install/i.test(project.name || project.path || ''))
    .map(project => ({ id: project.id, name: project.name, path: project.path_with_namespace,
      defaultBranch: project.default_branch, webUrl: project.web_url }));
}

export async function installerRefs(config, project) {
  const id = encodeURIComponent(project);
  const [branches, tags] = await Promise.all([
    paged(config, 'projects/' + id + '/repository/branches', 200),
    paged(config, 'projects/' + id + '/repository/tags', 200),
  ]);
  return {
    branches: branches.map(value => ({ name: value.name, commit: value.commit?.id,
      shortCommit: value.commit?.short_id, date: value.commit?.committed_date })),
    tags: tags.map(value => ({ name: value.name, commit: value.commit?.id,
      shortCommit: value.commit?.short_id, date: value.commit?.committed_date })),
  };
}

export async function installerCommits(config, project, branch, count = 20) {
  const id = encodeURIComponent(project);
  const values = await paged(config, 'projects/' + id + '/repository/commits?ref_name=' +
    encodeURIComponent(branch) + '&order=default', Math.min(Math.max(Number(count) || 20, 1), 100));
  return values.map(value => ({ id: value.id, shortId: value.short_id, title: value.title,
    message: value.message, author: value.author_name, date: value.committed_date, webUrl: value.web_url }));
}

async function repositoryTree(config, project, ref) {
  const id = encodeURIComponent(project);
  return paged(config, 'projects/' + id + '/repository/tree?recursive=true&ref=' + encodeURIComponent(ref), 2000);
}

async function rawFile(config, project, path, ref) {
  const id = encodeURIComponent(project);
  const response = await glRequest(config, 'projects/' + id + '/repository/files/' +
    encodeURIComponent(path) + '/raw?ref=' + encodeURIComponent(ref));
  return Buffer.from(await response.arrayBuffer());
}

export function parseDotEnv(text) {
  const values = {};
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (value.startsWith('"') || value.startsWith("'")) { const quote = value[0], end = value.indexOf(quote, 1); if (end > 0) value = value.slice(1, end); }
    else value = value.replace(/\s+#.*$/, '').trim();
    values[match[1]] = value;
  }
  return values;
}

export function expandComposeVariables(value, env = {}) {
  const unresolved = new Set();
  const expanded = String(value || '').replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-?])(.*?))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (whole, bracedName, operator, fallback, plainName) => {
      const name = bracedName || plainName, present = Object.prototype.hasOwnProperty.call(env, name), current = present ? String(env[name]) : '';
      const useFallback = operator === ':-' ? !current : operator === '-' ? !present : false;
      if (useFallback) return fallback || '';
      if (operator === ':?' || operator === '?') { if (!present || (operator === ':?' && !current)) { unresolved.add(name); return whole; } }
      if (!present) { unresolved.add(name); return whole; }
      return current;
    });
  return { value: expanded, unresolved: [...unresolved] };
}

// Текст одного файлу репозиторію за ref (для reconcile конфігів).
export async function installerFileText(config, project, path, ref) {
  return (await rawFile(config, project, path, ref)).toString('utf8');
}

export function parseComposeImages(text, sourceFile = '', env = {}) {
  const services = [];
  let composeService = null;
  let containerName = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    const section = /^  ([A-Za-z0-9_.-]+):\s*(?:#.*)?$/.exec(line);
    if (section) { composeService = section[1]; containerName = null; continue; }
    const container = /^\s+container_name:\s*["']?([^"'#\s]+)["']?/.exec(line);
    if (container) { containerName = container[1]; continue; }
    const imageLine = /^\s+image:\s*["']?([^"'#\s]+)["']?/.exec(line);
    if (!imageLine) continue;
    const rawTemplate = imageLine[1], interpolation = expandComposeVariables(rawTemplate, env), raw = interpolation.value;
    const withoutDigest = raw.split('@')[0];
    const last = withoutDigest.split('/').pop() || '';
    const split = last.lastIndexOf(':');
    const image = split >= 0 ? last.slice(0, split) : last;
    const tag = split >= 0 ? last.slice(split + 1) : 'latest';
    if (!image) continue;
    services.push({ image, tag, composeService, containerName, raw, rawTemplate, sourceFile, unresolvedVariables: interpolation.unresolved });
  }
  return services;
}

export async function installerSnapshot(config, { project, ref, manifestRoot = 'home' }) {
  if (!project || !ref) throw new Error('Installer project і ref обов’язкові');
  const id = encodeURIComponent(project);
  const [commit, tree] = await Promise.all([
    glJson(config, 'projects/' + id + '/repository/commits/' + encodeURIComponent(ref)),
    repositoryTree(config, project, ref),
  ]);
  const root = String(manifestRoot || 'home').replace(/^\/+|\/+$/g, '');
  const composeFiles = tree.filter(item => item.type === 'blob' &&
    item.path.startsWith(root + '/') && /\.ya?ml$/i.test(item.path));
  const envFiles = tree.filter(item => item.type === 'blob' && (item.path === '.env' || item.path === root + '/.env'));
  const envContents = await Promise.all(envFiles.map(async item => (await rawFile(config, project, item.path, commit.id)).toString('utf8')));
  const composeEnv = Object.assign({}, ...envContents.map(parseDotEnv));
  const contents = await Promise.all(composeFiles.map(async item => ({ item,
    text: (await rawFile(config, project, item.path, commit.id)).toString('utf8') })));
  const deduped = new Map();
  for (const value of contents) {
    for (const service of parseComposeImages(value.text, value.item.path, composeEnv)) deduped.set(service.image, service);
  }
  const managedRoots = ['home/', 'scripts/', 'volumes/config/'];
  const managedFiles = tree.filter(item => item.type === 'blob' && managedRoots.some(prefix => item.path.startsWith(prefix)))
    .map(item => ({ path: item.path, blobId: item.id }));
  const checksum = createHash('sha256').update(JSON.stringify({
    services: [...deduped.values()].map(value => [value.image, value.tag, value.sourceFile]),
    files: managedFiles.map(value => [value.path, value.blobId]),
  })).digest('hex');
  return {
    project, ref, manifestRoot: root,
    commit: { id: commit.id, shortId: commit.short_id, title: commit.title,
      author: commit.author_name, date: commit.committed_date, webUrl: commit.web_url },
    services: [...deduped.values()].sort((a, b) => a.image.localeCompare(b.image)),
    composeFiles: composeFiles.map(item => item.path),
    composeEnvFiles: envFiles.map(item => item.path),
    unresolvedVariables: [...new Set([...deduped.values()].flatMap(item => item.unresolvedVariables || []))].sort(),
    managedFiles,
    checksum,
    fileGroups: {
      home: managedFiles.filter(item => item.path.startsWith('home/')).length,
      scripts: managedFiles.filter(item => item.path.startsWith('scripts/')).length,
      configs: managedFiles.filter(item => item.path.startsWith('volumes/config/')).length,
    },
  };
}

const SAFE_COMPARE = /\.(?:ya?ml|json|config|conf|sh)$/i;
const SECRET_PATH = /(?:^|\/)(?:\.env|.*\.pem|.*\.key|.*secret[^/]*)$/i;
// .env — структурований конфіг: порівнюємо (хеш + reconcile по ключах),
// але значення маскуємо (див. reconcile masked). Справжні бінарні секрети
// (.pem/.key/*secret*) лишаються поза порівнянням.
const isEnvFile = path => { const b = String(path).split('/').pop().toLowerCase(); return b === '.env' || b.startsWith('.env.') || b.endsWith('.env'); };

export async function installerComparableFileHashes(config, { project, ref, paths }) {
  const selected = (paths || []).filter(path => isEnvFile(path) || (SAFE_COMPARE.test(path) && !SECRET_PATH.test(path)));
  const out = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(8, selected.length) }, async () => {
    while (cursor < selected.length) {
      const path = selected[cursor++];
      const value = await rawFile(config, project, path, ref);
      out.push({ path, sha256: createHash('sha256').update(value).digest('hex'), size: value.length, secret: isEnvFile(path) });
    }
  });
  await Promise.all(workers);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

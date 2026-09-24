// config-reconcile.mjs — движок звірки конфігів (Фаза 1 MVP, dry-run).
// Модель (див. PLAN-config-reconcile-restore.md):
//   backup    = authoritative values (pre-upgrade snapshot)
//   installer = desired structure / нові опції / нові дефолти
//   qaProfile = обов'язкові environment-specific overrides
//   → target-конфіг + класифікація по кожному ключу. Нічого не застосовує.
//
// Формати: JSON (appsettings) — зараз; .env — далі; yaml (envoy) — окремо (js-yaml).

import { readFileSync, writeFileSync } from 'node:fs';

// ── Толерантний парсер JSON (JSONC): коментарі // та /* */, trailing commas, BOM ──
// Прибирає коментарі й висячі коми ЛИШЕ поза рядковими значеннями (щоб не зачепити
// "http://…" чи "a/*b" всередині лапок). JSON використовує лише подвійні лапки.
function stripJsonComments(text) {
  let out = '', inStr = false, esc = false;
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    const c = s[i], c2 = s[i + 1];
    if (inStr) { out += c; if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '/' && c2 === '/') { i += 2; while (i < s.length && s[i] !== '\n') i++; out += '\n'; continue; }
    if (c === '/' && c2 === '*') { i += 2; while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++; i++; continue; }
    out += c;
  }
  return out;
}
export function hasJsonComments(text) {
  let inStr = false, esc = false;
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i], c2 = s[i + 1];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; continue; }
    if (c === '/' && (c2 === '/' || c2 === '*')) return true;
  }
  return false;
}
function stripTrailingCommas(text) {
  let out = '', inStr = false, esc = false;
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) { out += c; if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === ',') { let j = i + 1; while (j < s.length && /\s/.test(s[j])) j++; if (s[j] === '}' || s[j] === ']') continue; }
    out += c;
  }
  return out;
}
export function parseJsonc(text) {
  const clean = stripTrailingCommas(stripJsonComments(String(text).replace(/^﻿/, '')));
  return JSON.parse(clean);
}

// ── Парсер .env → плаский обʼєкт {KEY: value} (export, лапки, inline-коментарі) ──
export function parseEnv(text) {
  const values = {};
  for (const rawLine of String(text || '').replace(/^﻿/, '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (value.startsWith('"') || value.startsWith("'")) { const q = value[0], end = value.indexOf(q, 1); if (end > 0) value = value.slice(1, end); }
    else value = value.replace(/\s+#.*$/, '').trim();
    values[match[1]] = value;
  }
  return values;
}

// ── Диспетчер за розширенням/іменем: .json (JSONC) або .env. yaml/envoy — окремо. ──
export function configFormat(path) {
  const base = String(path || '').split('/').pop().toLowerCase();
  if (base === '.env' || base.startsWith('.env.') || base.endsWith('.env')) return 'env';
  if (base.endsWith('.json')) return 'json';
  return null;
}
export function parseConfig(path, text) {
  const fmt = configFormat(path);
  if (fmt === 'env') return parseEnv(text);
  if (fmt === 'json') return parseJsonc(text);
  throw new Error('непідтримуваний формат (лише .json / .env; yaml/envoy — окремо)');
}

// ── Плоска мапа dotted-path → значення (листові вузли) ──
export function flatten(value, prefix = '', out = {}) {
  if (value === null || typeof value !== 'object') { out[prefix] = value; return out; }
  if (Array.isArray(value)) {
    if (value.length === 0) { if (prefix) out[prefix] = []; }        // порожній масив — лист лише якщо не корінь
    else value.forEach((v, i) => flatten(v, prefix ? `${prefix}[${i}]` : `[${i}]`, out));
    return out;
  }
  const keys = Object.keys(value);
  if (keys.length === 0) { if (prefix) out[prefix] = {}; }           // порожній об'єкт — лист лише якщо не корінь
  else for (const k of keys) flatten(value[k], prefix ? `${prefix}.${k}` : k, out);
  return out;
}

// Підозра на шаблон/мок (сигнал, не вирок).
const PLACEHOLDER = /^\s*$|change[-_ ]?me|example|sample|your[-_ ]|replace|_here|xxx+|placeholder|dummy|todo|password123|secret123|localhost|127\.0\.0\.1|0\.0\.0\.0/i;
export function looksPlaceholder(v) { return typeof v === 'string' && PLACEHOLDER.test(v); }

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const valueKind = value => value === null ? 'null' : (Array.isArray(value) ? 'array' : typeof value);

// Manual values arrive from an HTML input as text. For JSON configs we must
// restore the semantic type of the conflicting value instead of silently
// writing every value as a string (8 -> "8", true -> "true"). If backup and
// installer disagree on the type, selecting either side is unambiguous but a
// manual value is not, so it is rejected.
export function coerceManualValue(raw, row, format = 'json') {
  if (format === 'env') return String(raw ?? '');
  if (format !== 'json') throw new Error(`непідтримуваний формат: ${format}`);

  const backupKind = valueKind(row?.backup);
  const installerKind = valueKind(row?.installer);
  if (backupKind !== installerKind) {
    throw new Error(`тип значення неоднозначний (${backupKind} ↔ ${installerKind}); обери server або installer`);
  }

  const text = String(raw ?? '');
  if (backupKind === 'string') return text;
  if (backupKind === 'number') {
    const trimmed = text.trim();
    if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(trimmed)) throw new Error('очікується число');
    const value = Number(trimmed);
    if (!Number.isFinite(value)) throw new Error('число поза допустимим діапазоном');
    return value;
  }
  if (backupKind === 'boolean') {
    const normalized = text.trim().toLowerCase();
    if (normalized !== 'true' && normalized !== 'false') throw new Error('очікується true або false');
    return normalized === 'true';
  }
  if (backupKind === 'null') {
    if (text.trim() !== 'null') throw new Error('очікується null');
    return null;
  }
  if (backupKind === 'object' || backupKind === 'array') {
    let value;
    try { value = parseJsonc(text); } catch { throw new Error(`очікується коректний JSON ${backupKind === 'array' ? 'масив' : 'об’єкт'}`); }
    if (valueKind(value) !== backupKind) throw new Error(`очікується JSON ${backupKind === 'array' ? 'масив' : 'об’єкт'}`);
    return value;
  }
  throw new Error(`ручне значення типу ${backupKind} не підтримується`);
}

// ── Two-way reconcile (+ QA overrides) ──
// verdict: same | new-from-installer | backup-only | conflict | qa-override
export function reconcile(backup, installer, qaProfile = {}) {
  const B = flatten(backup), I = flatten(installer), Q = flatten(qaProfile);
  const keys = [...new Set([...Object.keys(B), ...Object.keys(I), ...Object.keys(Q)])].sort();
  const rows = [];
  for (const key of keys) {
    const inB = key in B, inI = key in I, inQ = key in Q;
    const bv = inB ? B[key] : undefined, iv = inI ? I[key] : undefined, qv = inQ ? Q[key] : undefined;

    if (inQ) { rows.push({ key, verdict: 'qa-override', target: qv, backup: bv, installer: iv, auto: true, note: 'QA-профіль (обов\'язкове)' }); continue; }
    if (inI && !inB) { rows.push({ key, verdict: 'new-from-installer', target: iv, installer: iv, auto: true, note: 'нова опція' + (looksPlaceholder(iv) ? ' — шаблон, заповни' : ''), warn: looksPlaceholder(iv) }); continue; }
    if (inB && !inI) { rows.push({ key, verdict: 'backup-only', target: bv, backup: bv, auto: true, note: 'нема в installer — лишаємо' }); continue; }
    if (eq(bv, iv)) { rows.push({ key, verdict: 'same', target: bv, backup: bv, installer: iv, auto: true }); continue; }
    // є в обох, значення різні — машина не доведе (env-value чи змінений default) → рішення оператора
    rows.push({ key, verdict: 'conflict', target: undefined, backup: bv, installer: iv, auto: false,
      note: 'різні значення — рішення оператора', suggest: looksPlaceholder(iv) ? 'backup' : null });
  }
  const summary = {};
  for (const r of rows) summary[r.verdict] = (summary[r.verdict] || 0) + 1;
  const conflicts = rows.filter(r => !r.auto).length;
  return { rows, summary, conflicts, autoResolved: rows.length - conflicts, total: rows.length };
}

// ── Зібрати target-об'єкт із рішень (auto беруть target; conflict — доки не вирішено — беруть backup, або rendered за вибором) ──
export function buildTarget(result, decisions = {}) {
  const flat = {};
  for (const r of result.rows) {
    if (r.auto) { if (r.verdict !== 'backup-only' || r.target !== undefined) flat[r.key] = r.target; if (r.verdict === 'backup-only') flat[r.key] = r.backup; }
    else {
      const d = decisions[r.key]; // 'backup' | 'installer' | {value}
      if (d && typeof d === 'object' && 'value' in d) flat[r.key] = d.value;
      else if (d === 'installer') flat[r.key] = r.installer;
      else flat[r.key] = r.backup; // дефолт до рішення — зберігаємо фактичне
    }
  }
  return { flat, unresolved: result.rows.filter(r => !r.auto && !(r.key in decisions)).map(r => r.key) };
}

// ── Зворотне до flatten: dotted-path мапа → вкладений обʼєкт ──
function parsePath(key) {
  const parts = [];
  for (const seg of String(key).split('.')) {
    const name = seg.replace(/\[\d+\]/g, '');
    if (name) parts.push(name);
    for (const m of seg.matchAll(/\[(\d+)\]/g)) parts.push(Number(m[1]));
  }
  return parts;
}
export function unflatten(flat) {
  const root = {};
  for (const key of Object.keys(flat)) {
    const parts = parsePath(key);
    if (!parts.length) continue;
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (i === parts.length - 1) { node[p] = flat[key]; break; }
      if (node[p] === undefined || node[p] === null) node[p] = typeof parts[i + 1] === 'number' ? [] : {};
      node = node[p];
    }
  }
  return root;
}

// ── Матеріалізація target у текст файлу за форматом ──
export function materialize(path, target) {
  const fmt = configFormat(path);
  if (fmt === 'json') return JSON.stringify(unflatten(target), null, 2) + '\n';
  if (fmt === 'env') return Object.keys(target).map(k => `${k}=${target[k] === null || target[k] === undefined ? '' : String(target[k])}`).join('\n') + '\n';
  throw new Error('materialize: підтримується лише .json / .env');
}

const parseByExt = (path, text) => parseConfig(path, text);

// ── CLI (тимчасово, для дебагу семантики; кінцевий інтерфейс — UI) ──
const invoked = process.argv[1] && /config-reconcile\.mjs$/.test(process.argv[1]);
if (invoked) {
  const [backupPath, installerPath, qaPath] = process.argv.slice(2);
  if (!backupPath || !installerPath) { console.error('usage: node config-reconcile.mjs <backup.json> <installer.json> [qa.json]'); process.exit(2); }
  try {
    const backup = parseByExt(backupPath, readFileSync(backupPath, 'utf8'));
    const installer = parseByExt(installerPath, readFileSync(installerPath, 'utf8'));
    const qa = qaPath ? JSON.parse(readFileSync(qaPath, 'utf8')) : {};
    const res = reconcile(backup, installer, qa);
    const icon = v => ({ same: '  ', 'new-from-installer': '+ ', 'backup-only': '· ', conflict: '⚠ ', 'qa-override': 'Q ' }[v] || '  ');
    console.log(`\n  RECONCILE (dry-run) — backup ↔ installer${qaPath ? ' + QA' : ''}`);
    console.log(`  авто: ${res.autoResolved}  ·  на рішення (conflict): ${res.conflicts}  ·  усього ключів: ${res.total}`);
    console.log('  ' + Object.entries(res.summary).map(([k, n]) => `${k}:${n}`).join('  '));
    console.log('\n  ── ключі, що не «same» ──');
    for (const r of res.rows) {
      if (r.verdict === 'same') continue;
      const b = r.backup === undefined ? '—' : JSON.stringify(r.backup);
      const i = r.installer === undefined ? '—' : JSON.stringify(r.installer);
      console.log(`  ${icon(r.verdict)}${r.key}`);
      console.log(`        backup=${b}  installer=${i}  → ${r.note || r.verdict}`);
    }
    const { unresolved } = buildTarget(res);
    console.log(`\n  Нерозв'язаних conflict: ${unresolved.length}${unresolved.length ? ' (' + unresolved.join(', ') + ')' : ''}`);
    console.log('  Це dry-run — нічого не застосовано.\n');
    process.exit(res.conflicts ? 1 : 0);
  } catch (e) { console.error('reconcile помилка:', e.message); process.exit(2); }
}

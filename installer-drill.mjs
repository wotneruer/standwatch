// installer-drill.mjs — DRY-RUN плану destructive restore drill.
// БЕЗПЕЧНО: нічого не виконує на сервері. Будує з restore-point + containers.json
// точну впорядковану послідовність «прибити й відновити» (за PORUCH-RESTORE-DRILL.md §6),
// перелічує контейнери/томи/шляхи реальними іменами, перевіряє gate-умови (§6 «Умови
// негайної зупинки») і пише drill-dryrun.json + друкує звіт.
//
// Запуск:  node installer-drill.mjs <шлях-до-теки-backup>
//   напр.: node installer-drill.mjs data/backups/20260916080531886_poruch_qa_rscore
//
// Реального (destructive) виконання тут НЕМАЄ і не буде без окремого рішення.

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';

const sh = s => "'" + String(s).replace(/'/g, `'\\''`) + "'";              // shell-quote
const human = b => b == null ? '—' : (b / 1073741824 >= 1 ? (b / 1073741824).toFixed(2) + ' GiB'
  : (b / 1048576).toFixed(1) + ' MiB');

function loadJson(path) { return JSON.parse(readFileSync(path, 'utf8')); }

// Список контейнерів + образів + томів із containers.json (докер-inspect бекапу).
function parseContainers(raw) {
  const arr = Array.isArray(raw) ? raw : (raw.containers || raw.Containers || []);
  return arr.map(c => {
    const name = String(c.Name || c.name || '').replace(/^\//, '');
    const image = (c.Config && c.Config.Image) || c.Image || c.image || '';
    const digest = (Array.isArray(c.RepoDigests) && c.RepoDigests[0]) ||
      (c.Image && String(c.Image).startsWith('sha256:') ? c.Image : '') || '';
    const composeGroup = (c.Config && c.Config.Labels && c.Config.Labels['com.docker.compose.project']) ||
      (c.Labels && c.Labels['com.docker.compose.project']) || '';
    const volumes = (c.Mounts || c.mounts || []).filter(m => (m.Type || m.type) === 'volume')
      .map(m => ({ name: m.Name || m.name || '', dest: m.Destination || m.destination || '' }));
    return { name, image, digest, composeGroup, volumes };
  });
}

export function buildDrillDryRun(backupDir) {
  const dir = resolve(backupDir);
  const rpPath = join(dir, 'restore-point.json');
  if (!existsSync(rpPath)) throw new Error('нема restore-point.json у ' + dir);
  const rp = loadJson(rpPath);
  const containersPath = join(dir, 'containers.json');
  const containers = existsSync(containersPath) ? parseContainers(loadJson(containersPath)) : [];

  const server = rp.server, group = rp.group, installRoot = rp.installRoot;
  const artifacts = rp.artifacts || [];
  const filesArt = artifacts.find(a => a.kind === 'stand-files');
  const dbArt = artifacts.find(a => a.kind === 'postgresql-dump');
  const dbContainers = (rp.database && rp.database.detected) || [];

  // Томи, які треба зберегти/відновити (stateful). За домовленістю: тільки rabbit
  // (DB йде через dump). pgdata свідомо не чіпаємо.
  const statefulVolumes = [];
  for (const c of containers) for (const v of c.volumes) {
    if (/rabbit/i.test(c.name) || /\/var\/lib\/rabbitmq/i.test(v.dest)) statefulVolumes.push({ container: c.name, ...v });
  }

  // ── Впорядкований план (PORUCH-RESTORE-DRILL.md §6). commands — те, що ВИКОНАВ БИ
  //    реальний прогін; тут лише показуємо. mutating:true = змінює сервер.
  const groupContainers = containers.filter(c => !group || !c.composeGroup || c.composeGroup === group);
  const steps = [
    { n: 1, title: 'Другий свіжий backup перед drill', mutating: false,
      note: 'створити НОВИЙ verified backup безпосередньо перед руйнуванням (не цей).' },
    { n: 2, title: 'Зупинити compose-групу ' + group, mutating: true,
      commands: [`cd ${sh(installRoot)} && bash scripts/stop.sh`],
      note: 'офіційним скриптом інсталятора; Poruch на кілька хв офлайн.' },
    { n: 3, title: 'Видалити лише контейнери групи ' + group, mutating: true,
      commands: groupContainers.map(c => `docker rm -f ${sh(c.name)}`),
      note: `${groupContainers.length} контейнерів; сторонні compose-групи НЕ чіпаємо.` },
    { n: 4, title: 'Очистити погоджений installRoot', mutating: true,
      commands: [`# лише вміст ${installRoot} (без широких rm -rf); архів нижче його відновить`],
      note: 'жодних видалень поза ' + installRoot + '.' },
    { n: 5, title: 'Відновити home/scripts/volumes з архіву', mutating: true,
      commands: [`# stream: local ${filesArt ? filesArt.name : 'stand-files.tar.gz'} → tar -xzf у ${installRoot} (owners/modes збережені)`],
      note: filesArt ? `${human(filesArt.bytes)}, sha256 ${String(filesArt.sha256).slice(0, 12)}; включає ${(filesArt.includes || []).join('/')}, крім ${(filesArt.excludes || []).join(', ')}` : 'архіву нема!' },
    { n: 6, title: 'Відновити RabbitMQ-том(и)', mutating: true,
      commands: statefulVolumes.map(v => `# відновити том ${v.name} → ${v.dest} (контейнер ${v.container})`),
      note: statefulVolumes.length ? `${statefulVolumes.length} том(ів)` : 'rabbit-томів у бекапі не знайдено — перевір!' },
    { n: 7, title: 'Створити чистий PostgreSQL і влити dump', mutating: true,
      commands: [`# новий postgres (${(rp.restore && rp.restore.image) || 'postgres:14.5'}), stream local ${dbArt ? dbArt.name : 'database/*.sql.gz'} → psql`],
      note: dbArt ? `${human(dbArt.bytes)} стиснено; контейнер БД: ${dbContainers.join(', ')}; спосіб: pg_dumpall` : 'dump-артефакту нема!' },
    { n: 8, title: 'Підняти stack інсталятором (re-pull образів)', mutating: true,
      commands: [`cd ${sh(installRoot)} && bash scripts/start.sh`],
      note: 'образи тягнуться з реєстру ЗА DIGEST (нижче); спершу Postgres/інфра, потім backend/web.' },
    { n: 9, title: 'Health кожного сервісу з таймаутом', mutating: false,
      commands: groupContainers.map(c => `# чекати running/healthy: ${c.name} (таймаут на сервіс)`),
      note: `${groupContainers.length} сервісів; стоп на першій невідповідності.` },
    { n: 10, title: 'Прибрати невикористані образи на сервері', mutating: true,
      commands: [`docker image prune -f`],
      note: 'щоб серверний диск не забивався.' },
    { n: 11, title: 'Звірка з installer + restore-point', mutating: false,
      commands: [`# StandWatch scan → порівняти tags/digests з target checksum ${String((rp.target || {}).checksum || '').slice(0, 12)}`],
      note: 'жодних втрат сервісів / невідомих образів.' },
  ];

  // ── Образи, які re-pull за digest (§ образи не зберігаємо) ──
  const images = groupContainers.map(c => ({ name: c.name, image: c.image, digest: c.digest || '(digest не зафіксовано в containers.json)' }));

  // ── GATE-умови (PORUCH-RESTORE-DRILL.md §6 «Умови негайної зупинки») ──
  const gates = [];
  const g = (ok, name, detail) => gates.push({ ok, name, detail });
  g(rp.status === 'verified' || rp.status === 'restore-tested', 'backup verified',
    'status=' + rp.status);
  g((rp.restore && rp.restore.status) === 'restore-tested', 'restore-test пройдено',
    'restore.status=' + ((rp.restore && rp.restore.status) || 'нема') + ' — БД має відновлюватись у чистий PG перед drill');
  g(artifacts.length > 0 && artifacts.every(a => a.verified === true), 'checksum усіх артефактів',
    artifacts.map(a => a.name + ':' + (a.verified ? '✓' : '✗')).join(' '));
  g(!!dbArt && (rp.database && rp.database.complete === true), 'DB dump повний',
    'complete=' + String(rp.database && rp.database.complete));
  const groups = [...new Set(containers.map(c => c.composeGroup).filter(Boolean))];
  g(groups.length <= 1, 'scope однозначний (одна compose-група)',
    'групи в inventory: ' + (groups.join(', ') || '(labels відсутні — перевір вручну)'));
  g(!!filesArt, 'файловий архів присутній', filesArt ? filesArt.name : 'НЕМА');
  g(statefulVolumes.length > 0, 'rabbit-том у бекапі', statefulVolumes.length + ' том(ів)');
  // Другий свіжий backup — перевіряємо наявність ІНШОГО verified backup цього ж плану, новішого за restore-test
  let secondBackup = false, siblingInfo = '';
  try {
    const backupsRoot = dirname(dir), planId = rp.planId;
    const sibs = readdirSync(backupsRoot).filter(x => x !== basename(dir) && x.includes(planId.split('_')[1] || 'poruch') );
    siblingInfo = sibs.length ? sibs.join(', ') : 'інших backup цього сервера нема';
    secondBackup = sibs.some(s => { try { const j = loadJson(join(backupsRoot, s, 'restore-point.json')); return j.status === 'verified' && new Date(j.createdAt) > new Date(rp.createdAt); } catch { return false; } });
  } catch { }
  g(secondBackup, 'другий СВІЖИЙ backup перед drill', secondBackup ? siblingInfo : 'потрібно створити новий verified backup безпосередньо перед drill (' + siblingInfo + ')');

  const canProceed = gates.every(x => x.ok);
  return {
    mode: 'dry-run', generatedAt: new Date().toISOString(),
    server, group, installRoot,
    target: rp.target || null,
    inventory: { containers: containers.length, groupContainers: groupContainers.length, statefulVolumes: statefulVolumes.length, dbContainers },
    steps, images, statefulVolumes, gates, canProceed,
    warnings: [
      containers.length < ((rp.target && rp.target.serviceCount) || 0)
        ? `inventory (${containers.length}) < serviceCount у target (${rp.target.serviceCount}) — можливо, у containers.json не всі контейнери (напр. Postgres). Реальний drill має брати ПОВНИЙ живий inventory через SSH.` : null,
      images.some(i => !i.digest || i.digest.startsWith('('))
        ? 'у частини образів digest не зафіксовано в containers.json — реальний drill має підтягнути digest живим inspect і попередити, якщо його вже нема в реєстрі.' : null,
    ].filter(Boolean),
  };
}

// ── Друк звіту ──
function printReport(r) {
  const L = [];
  L.push(`\n  DRY-RUN destructive restore drill — ${r.server} / group ${r.group}`);
  L.push(`  installRoot: ${r.installRoot}   target: ${r.target ? r.target.project + '@' + r.target.ref : '—'}`);
  L.push(`  inventory: ${r.inventory.groupContainers} контейнерів групи, ${r.inventory.statefulVolumes} stateful-том(ів), DB: ${r.inventory.dbContainers.join(', ') || '—'}`);
  L.push(`\n  ── КРОКИ (нічого не виконано) ──`);
  for (const s of r.steps) {
    L.push(`  ${s.n}. ${s.mutating ? '⚠ ' : '  '}${s.title}`);
    for (const c of (s.commands || [])) L.push(`        $ ${c}`);
    if (s.note) L.push(`        — ${s.note}`);
  }
  L.push(`\n  ── ОБРАЗИ (re-pull за digest) ── ${r.images.length}`);
  for (const i of r.images.slice(0, 40)) L.push(`     ${i.name}  ${i.image}  ${String(i.digest).slice(0, 24)}`);
  L.push(`\n  ── GATE-умови (мають бути всі ✓ перед реальним drill) ──`);
  for (const x of r.gates) L.push(`     ${x.ok ? '✓' : '✗'} ${x.name} — ${x.detail}`);
  if (r.warnings.length) { L.push(`\n  ── ⚠ ПОПЕРЕДЖЕННЯ ──`); for (const w of r.warnings) L.push(`     • ${w}`); }
  L.push(`\n  Готовність до реального drill: ${r.canProceed ? '✓ усі gate ок (але виконання лише після окремого підтвердження)' : '✗ НЕ готово — див. ✗ вище'}\n`);
  return L.join('\n');
}

// ── CLI ──
const invoked = process.argv[1] && /installer-drill\.mjs$/.test(process.argv[1]);
if (invoked) {
  const backupDir = process.argv[2];
  if (!backupDir) { console.error('usage: node installer-drill.mjs <шлях-до-теки-backup>'); process.exit(2); }
  try {
    const r = buildDrillDryRun(backupDir);
    console.log(printReport(r));
    const out = join(resolve(backupDir), 'drill-dryrun.json');
    writeFileSync(out, JSON.stringify(r, null, 2));
    console.log(`  Звіт збережено: ${out}`);
    process.exit(r.canProceed ? 0 : 1);
  } catch (e) { console.error('DRY-RUN помилка:', e.message); process.exit(2); }
}

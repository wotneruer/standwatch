# Продовження 2026-09-16 (Claude, поки Codex недоступний до понеділка)

## Перевірив код Codex — завершені пункти РОБОЧІ
- **`${VAR}` розкриття** (`installer-control.mjs` `expandComposeVariables`/`parseComposeImages`) —
  юніт-тест: `${VAR}`, `${VAR:-def}` (set/unset) працюють; нерозкриті змінні трекаються в
  `unresolved`/`unresolvedVariables` (не вигаданий тег). ✅
- **Scope по compose-файлах групи** (`scopedServices`, `p_scope_files`, `buildPlanView` бере
  `scopedServices()`) — у коді є, синтаксис ок; повний E2E потребує живого GitLab-снапшоту (не гнав).
- **Збереження каталогу** (`catalogSaveChain` + `reconcileCatalog`) — E2E через браузер:
  create Alpha+Beta, installer до **Beta** (2-й проєкт) → зберігається і в UI, і на сервері. ✅
- **Фільтр попереджень** — `openPlan(drift?'change':'problem')` (р.1852) — пункт закритий.
- Обидва `.mjs` компілюються (`node -c`).

## Що я зробив
1. **Перезібрав backend із поточного джерела** (`node build-standwatch-work.mjs` →
   `standwatch-server.new.exe`) і розклав у:
   - `StandWatch/standwatch-server.exe`
   - `StandWatch/StandWatch-Debug-With-Current-Data-20260915/StandWatch/standwatch-server.exe`
   (щоб debug-збірка, яку запускає Антон, мала ВСІ фікси).
2. **Оновив portable** (був стейл від 15.09):
   - `PortableLauncher/payload.zip` → підмінив `standwatch-server.exe` на свіжий (host+README лишив);
     робив через власну dotnet-утиліту, бо `zip` нема, а PowerShell заблокований group policy.
   - `PortableLauncher/Program.cs`: `PayloadVersion` `2026.09.16.1` → **`2026.09.16.2`**
     (щоб уже встановлені копії пере-розпакувались).
   - `dotnet publish -c Release -r win-x64 --self-contained -p:PublishSingleFile=true` →
     **`PortableRelease/build-2026.09.16.2/StandWatch-Portable.exe`** (~205 МБ).
   - Smoke: запуск у чистій теці → розпакував payload, backend піднявся й відповів `/api/ping`. ✅

## НЕ робив (потребує згоди Антона / §4 IMPLEMENTATION-STATUS)
- **Destructive restore drill** («прибити та відновити» Poruch). Недеструктивний restore-test БД у
  Codex уже проходить; повний stack-drill вимагає узгодження §4 (retention, які volume статичні,
  quiesce/downtime, чи потрібен `pgdata`/`docker save`, критерії health) і подвійного підтвердження.
  Наступний технічний крок за §5: зафіксувати expected container inventory + health endpoints +
  порядок підняття для `rscore`, потім drill з поетапним журналом і стопом на першій невідповідності.

## Дрібне
- Портал Антона на **8788** не чіпав (лишився живий). Свої тестові інстанси прибрав.
- Мій ранній quick-fix каталогу (`FIX-2026-09-16-...md`) Codex переробив надійніше
  (`catalogSaveChain`+`reconcileCatalog`) — актуальна саме його версія.

## Drill — DRY-RUN зроблено (destructive НЕ виконував)
Погоджено з Антоном scope бекапу: **БД (`pg_dumpall`) + RabbitMQ-том + конфіги для звірки**;
образи НЕ зберігаємо (re-pull з реєстру за digest); lifecycle — `scripts/stop.sh`/`start.sh`;
після drill `docker image prune` на сервері; retention 3; downtime кілька хв ок; rabbit
до моменту бекапу — ок.

Новий модуль **`installer-drill.mjs`** (read-only): будує з `restore-point.json`+`containers.json`
повний впорядкований destructive-план (11 кроків, за `PORUCH-RESTORE-DRILL.md §6`), перелічує
контейнери/томи/образи-з-digest реальними іменами, перевіряє всі gate-умови §6 і пише
`drill-dryrun.json`. **Нічого не виконує.**
- Запуск: `node installer-drill.mjs data/backups/<plan-id>` (exit 0 = всі gate ✓, 1 = не готово).
- На плані `20260916080531886_poruch_qa_rscore`: 7 gate ✓, 1 ✗ (**потрібен ДРУГИЙ свіжий verified
  backup перед drill** — є лише старіший). Тобто безпечно блокує.

### Наступні кроки (після review Антоном dry-run)
1. Живий SSH-preflight у drill (повний inventory через `docker ps/inspect`, а не лише
   containers.json — бо Postgres там окремо; звірити current-vs-backup) + перевірка digest у реєстрі.
2. Wiring у панель: endpoint `/api/installer/drill?mode=dryrun` + кнопка в розділі backup/restore
   (щоб не лише з CLI). Тримати сумісним із `restoreTestJobs`/JSONL-журналом Codex.
3. Реальний destructive-прогін — окрема операція з подвійним підтвердженням, поетапним JSONL,
   стопом на першій невідповідності; лише після свіжого backup і явного «так» Антона.

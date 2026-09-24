# 2026-09-17 — Config Reconcile, Фаза 1 MVP (готово, dry-run у UI)

> Реалізовано за `PLAN-config-reconcile-restore.md`. Працює наскрізь на реальному Poruch.
> Codex офлайн до понеділка — робив я, окремим модулем + тонке підключення, щоб не було churn.

## Що зроблено
Two-way reconcile ОДНОГО конфіг-файлу (JSON): **сервер-зараз ↔ installer (за зафіксованим ref)**,
класифікація по ключах, **dry-run** (нічого не застосовує), **кнопка в UI**.

### Файли
- **`config-reconcile.mjs`** (новий, «мозок»): `flatten()`, `reconcile(backup, installer, qa)`,
  `buildTarget()`, `looksPlaceholder()`. Вердикти: `same / new-from-installer / backup-only /
  conflict / qa-override`. Є CLI для дебагу (`node config-reconcile.mjs a.json b.json [qa.json]`).
- **`installer-control.mjs`**: додано експорт `installerFileText(config, project, path, ref)`.
- **`stand-panel.work.mjs`**:
  - імпорти `installerFileText`, `reconcile as reconcileConfig`;
  - endpoint **`GET /api/reconcile?server=&group=rscore&path=<...>.json`** — ssh `cat` серверного
    файлу + `installerFileText` за `server.installerGroups[group].{project,ref,installRoot}` →
    `reconcileConfig` → JSON `{rows, summary, autoResolved, conflicts, total, ...}`;
  - кнопка **`⇄ Reconcile`** у шапці + модалка `reconcileDlg` (поле шляху, «Звірити», таблиця).

### Перевірено
- Движок: реальні appsettings (92 ключі, 91 same, 1 new-from-installer) + синтетика довела
  conflict / qa-override / backup-only / placeholder-детекцію.
- Endpoint наживо проти Poruch (SSH+GitLab) → коректний JSON.
- UI: вибір сервера → ⇄ Reconcile → «Звірити» → таблиця з summary-pills. Знайшло реальну нову
  опцію інсталятора `ServiceActions.analytics-dashboard[1]="view_user_performance"`.

## Свідомі спрощення MVP (не борги, а межа фази)
- Джерело «backup» у endpoint поки = **сервер-зараз** (швидко, і під frozen-assumption == backup).
  Правильне «з тарболу бекапу» — наступний крок (тягнути 1 файл із stand-files.tar.gz).
- Лише **JSON** (appsettings). `.env` і yaml/envoy — далі.
- **QA-профіль** передається порожній `{}` (движок готовий приймати; файл-профіль — далі).
- Group хардкоджено `rscore` у кнопці (endpoint приймає будь-яку).

## Наступні кроки (за планом)
1. Джерело backup = розпакований конфіг із **stand-files.tar.gz** (а не сервер-зараз).
2. **`.env`** парсер → той самий движок.
3. **QA-профіль** як version-controlled yaml + застосування overrides у reconcile.
4. **envoy/yaml** — `js-yaml` бандлом (esbuild), named-поля + рядковий diff.
5. Крос-валідація: DB user із connection string ↔ роль у `pg_dumpall`.
6. Інтерактивне рішення conflict у модалці (вибір backup/installer/ручний ввід) → `buildTarget`.
7. Static+runtime валідація → preview → **керований apply (scp + бекап поточного + рестарт
   affected + health-check + rollback)**. БД не чіпаємо.

## Стан збірки
- Свіжий backend (з reconcile + раніше: scp-backup-фікс + newerVersion-фікс) задеплоєно в
  `StandWatch-Debug-With-Current-Data-20260915/StandWatch/standwatch-server.exe`.
- Перезбір: `node build-standwatch-work.mjs` → `standwatch-server.new.exe`.
- Портал Антона 8788 не чіпав; свій тест-інстанс (9100) зупинив, lock прибрав.

## Оновлення 18.09 (Claude)
- **Reconcile перенесено в installer-модалку**: у списку «Конфігурації» JSON-файли «відрізняється/відсутній»
  клікабельні (`⇄`) → відкривають key-diff цього файлу. Кнопку з шапки прибрано. (`renderPlanResult` +
  `openReconcileFor`.)
- **Вигляд reconcile — git/TeamCity side-by-side diff**: ліворуч «Сервер зараз» (червоне, `-`), праворуч
  «Installer target» (зелене, `+`); `same` сховані за чекбоксом «показати однакові (N)». Без auto-resolve —
  лише перегляд для людини (за вимогою Антона). Рендер із наявних даних `/api/reconcile` (бекенд не міняв).
- **ФІКС КРЕША (важливо):** бекенд валився, коли скан/автоскан чіпав недоступний сервер (напр. Yetu) —
  Node виходив на unhandled rejection, і вся панель «Failed to fetch». Додано глобальну сітку
  `process.on('unhandledRejection'|'uncaughtException', log)` — недоступний сервер більше не валить бекенд.
- Перевірено curl-ом + браузером: vpo-service → 36 same, 1 конфлікт (`DatabaseAnalyze.IntervalHours` 1→8),
  бекенд переживає автоскан. Свіжий backend задеплоєно в debug-теку.
- **Далі:** yaml/envoy (js-yaml + named-поля/рядковий diff), `.env`, QA-профіль, потім apply/rollback.
  Косметика diff: довгі значення переносяться (overflow-wrap:anywhere); можливий кращий layout «ключ / значення».

## Оновлення 18.09 — редагування наявного сервера
- **Проблема:** можна було додати/видалити/перейменувати сервер, але **поправити host/IP чи SSH-юзера** — ні
  (лише руками в `servers.json` або видалити+завести заново з втратою прив'язок/кешу). Найчастіший кейс — «змінили IP».
- **Бекенд:** `POST /api/edit-server` `{name, newName?, host, user}` — робить `sshInspect` новим `user@host`,
  і **лише при успіху** пише `standUrl`+`ssh` узгоджено. Опційний rename — спершу, з міграцією кеш-ключів і каталогу
  (як `rename-server`). `installerGroups`/дефолт/кеш при зміні лише host — не чіпаються (ім'я те саме → ключ кешу той самий).
- **UI:** кнопка ✎ на картці огляду тепер відкриває модалку `editDlg` (замість `prompt`): назва+host+юзер, ключ read-only
  (з ⚙), кнопки «🗑 Видалити» (зліва) і «Перевірити й зберегти». Помилка SSH → червоний рядок, **не зберігає**.
- Перевірено: валідація (неіснуючий сервер → 400 «сервер не знайдено»), синтаксис, збірка. Задеплоєно в debug-теку.

## Оновлення 18.09 — JSONC-парсер, .env, ширша модалка
- **Ширша reconcile-модалка:** глобальний `dialog` різав на 520px → додано `dialog#reconcileDlg{width:min(1240px,96vw)}`.
  Колонки ~600px (було ~250), довгі значення й «показати однакові» більше не падають у вузький стовпчик.
- **JSONC-парсер** (`config-reconcile.mjs`: `parseJsonc`): прибирає `//`,`/* */`, trailing commas, BOM — але
  ЛИШЕ поза рядками (state-machine на подвійних лапках), тож `http://…` і `/*...*/` усередині значень не чіпає.
  Це лагодить падіння appsettings типу `Expected double-quoted property name` (vpo-report-service).
- **.env-парсер** (`parseEnv`) + диспетчер `parseConfig(path,text)` / `configFormat(path)` → `.json`|`.env`|null.
  Ендпоінт `/api/reconcile` приймає тепер `.json` і `.env` (yaml/envoy → 400), парсить через `parseConfig`,
  віддає `format`. UI: клікабельні у плані тепер і `.env` (рядкові перевірки, без regex зі слешами).
- **Юніт-перевірено:** JSONC (коментарі/коми/http:// у рядку), .env (export/лапки/inline-#), reconcile на .env.
- **Envoy/великий yaml — окремо, ще не чіпав** (потрібен js-yaml + named-поля + рядковий diff).

## Оновлення 18.09 — masked diff для secret (.env у списку плану)
Рішення Антона: для secret-файлів показуємо **структуру змін** (які ключі нові/зникли/змінились),
**маскуючи значення** — «важливо бачити зміни всюди», але секрети не світяться.
- `installer-control.mjs`: `installerComparableFileHashes` тепер **включає `.env`** у порівняння,
  тег `secret:true` (справжні бінарні секрети .pem/.key/*secret* лишаються поза порівнянням). Тому `.env`
  тепер **зʼявляються у списку файлів плану** (з 🔒), клікабельні → reconcile.
- `/api/reconcile`: для `format==='env'` значення в рядках маскуються (`••••••`), **порожнє лишається
  видимим `(порожнє)`** — це не секрет і ловить «затертий пароль». У відповіді `masked:true`.
- UI: нотатка «🔒 secret-файл — значення приховані, показано лише структуру», 🔒 біля файлу в списку.
- Юніт-перевірено на .env: conflict (DB_PASS ••→••, DNS_REFRESH ••→(порожнє)), new-from-installer,
  backup-only — структура видна, значення приховані. Ключі (імена параметрів) показуються — це не секрет.
- Задеплоєно в debug-теку. 9100 зупинено, 8788 не чіпано.

## Оновлення 18.09 — reveal-on-click для маскованих значень
Рішення Антона: масковане значення можна розкрити **по кліку** (не hover — щоб секрет не спалахував випадково).
- Бекенд `GET /api/reveal?server=&group=&path=&key=&side=server|installer` — тягне **одне** значення на явний
  клік (server → SSH `cat`+`parseConfig`+`flatten`; installer → `installerFileText`), повертає `{exists,value}`.
  Значення **не логуємо** (у консоль лише факт reveal), **не кешуємо** на бекенді.
- UI (`rc_go`): масковане значення рендериться як `<span class="rc-reveal" data-side data-key>` (пунктир, курсор).
  Клік → fetch, показ реального; повторний клік → знову масковано. Значення кешується лише в самому елементі
  (закриття модалки все скидає). Комірки diff переписані: `cell()/line()/valInner()` замість `lc()/rc()`.
- Перевірено: синтаксис, збірка, init цілий (консоль чиста), валідація ендпоінта. Задеплоєно.
- **Далі (за домовленістю, порядок):** (2) per-key вибір джерела `backup|installer|ручне` — обгортка над готовим
  `buildTarget(result, decisions)` → target-конфіг у dry-run («ось що поїде»); (3) apply/rollback (scp+restart+
  health-check), для секретів — резолв через `pass`-reference. Envoy/великий yaml — все ще окремо.

## Оновлення 18.09 — reconcile бере ціль із плану (фікс «не зафіксовано installer»)
- На Yetu reconcile .env падав «для цієї групи не зафіксовано installer (project/ref)», хоча план для rscore
  збережено. Причина: reconcile/reveal читали ЛИШЕ `server.installerGroups[group]` (окреме «фіксування» через
  `/api/installer/binding`), а користувач сформував **план**, не коммітив binding.
- Додано `resolveConfigBinding(server, group)`: спершу зафіксований `installerGroups[group]`, інакше —
  `latestInstallerPlan().plan.target` (`project`, `commit.id`→ref, `installRoot`). `/api/reconcile` і `/api/reveal`
  тепер через нього. Тобто reconcile працює скрізь, де є або binding, або збережений план.
- **✓ Перевірено наживо на Yetu** (Антон): `.env` звірка працює, installer підтягнувся правильний, reveal по кліку
  показує реальні значення. Видно, що креди — це `pass`-референси (`$(pass rscore/db_password)`) і `${...}`-шаблони,
  не хардкод; `RETAIL_PORTAL_ADDRESS: 10.0.30.166 → (порожнє)` — installer не задає.

## Оновлення 18.09 — group→installer автовибір (installer-панель)
- Скарга: для групи `rscore` дропдаун «Installer-репозиторій проєкту» показував ОБИДВА installer'и проєкту Yetu,
  треба було дообирати вручну. Хотілося, щоб для групи автоматично підтягувався її installer.
- `validateInstallerCatalog`: додано мапу **`groupInstaller`** (`server|group → projectPath`), round-trip перевірено.
- `loadProjects()`: передвибір installer тепер: коммітнутий binding → запамʼятований на групу (`groupInstaller`) →
  єдиний → **за назвою** (basename шляху містить назву групи; для Yetu обидва в GitLab-групі `rscore/…`, тож
  розрізняє саме basename: `rscore-installer` vs `retail-portal-installer`) → перший.
- `p_project.onchange` запамʼятовує ручний вибір на групу в `groupInstaller` (`saveCatalog`).
- **✓ Наживо:** ref показав `rscore/yetu/rscore-installer` автоматично.

## Оновлення 18.09 — Фаза 2: вибір джерела + прев'ю target (dry-run)
- **Двигун** (`config-reconcile.mjs`): додано `unflatten()` (dotted-path+масиви → вкладений обʼєкт) і
  `materialize(path,target)` (.json → JSON.stringify, .env → KEY=val). Юніт-перевірено: вкладені обʼєкти,
  масив із доданим елементом, ручне значення.
- **Ендпоінт** `POST /api/reconcile/target` `{server,group,path,decisions}` — reconcile → `buildTarget(decisions)` →
  якщо є `unresolved` вертає їх; інакше `materialize` → текст. Для `.env`/secret значення в прев'ю масковані.
  Нічого не застосовує, на диск не пише (чистий dry-run).
- **UI** (секція «Рішення по конфліктах» під diff): на кожен конфлікт — поле-значення + чіпи `сервер`/`installer`
  (+ `вручну` для секретів), inspector підсвічує початковий/кінцевий пробіл і рахує символи, дефолт для секрету —
  «лишити серверне». Кнопка «Показати цільовий конфіг · dry-run» активна лише коли всі конфлікти вирішені →
  показує матеріалізований target у `<pre>`. Рішення через делегування подій.
- **ПАСТКА (знову template-літерал):** `\n` у браузерному рядку в джерелі став реальним переносом → розрив рядка →
  `SyntaxError: Invalid or unexpected token`. Фікс: `\\n`. Оновлено пам'ять (тепер і про `\n`, `\t`, апостроф).
- **Перевірено:** двигун (unit), ендпоінт (валідація), init цілий (свіжа вкладка, консоль чиста).
  **НЕ перевірено візуально сама секція рішень** (потрібен живий reconcile із конфліктами) — Антону глянути на
  vpo-service/appsettings.json (є конфлікт `DatabaseAnalyze.IntervalHours 1→8`).

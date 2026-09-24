# StandWatch: повний аудит і план упорядкування

Дата: **2026-09-24**  
Статус документа: **чернетка для спільного рев'ю перед рефакторингом**  
Обсяг: уся StandWatch, а не лише backup/config merge  

## 1. Навіщо цей документ

StandWatch виріс із локальної панелі моніторингу стендів у застосунок, який уже
поєднує:

- інвентаризацію Docker-контейнерів;
- порівняння стенду з Registry, GitLab і TeamCity;
- каталог проєктів та installer-репозиторіїв;
- побудову зафіксованого installer target;
- планування змін сервісів і конфігурацій;
- локальний backup та перевірку PostgreSQL restore;
- повнофайловий merge конфігів;
- атомарний файловий apply і rollback через T2 snapshots;
- desktop/portable оболонку для Windows.

Окремі вертикальні сценарії вже працюють, але вони нарощувалися поступово й не
мають єдиної продуктової та транзакційної моделі. Перед додаванням керування
контейнерами потрібно впорядкувати source, збірку, дані, UI, стани операцій і
відновлення.

Цей документ фіксує узгоджений напрям. До завершення рев'ю він не є дозволом
на масове переписування чи контейнерний rollout.

## 2. Поточна робоча версія

Поточний робочий runtime після впорядкування каталогу:

```text
D:\_Work_\00_Inbox\TMP\RCC\StandWatch\runtime\current\
```

Точка запуску:

```text
D:\_Work_\00_Inbox\TMP\RCC\StandWatch\runtime\current\standwatch.exe
```

Поточний backend збігається з останньою локальною збіркою
`standwatch-server.new.exe`.

SHA-256 backend:

```text
B7A49B2EE73FEE2E3611A283BBD0DF2992A0A56A91A3C347E6116EED6DD1D307
```

Операційний стан пілота Poruch QA:

- останній DEBUG batch: `20260923070018239_batch_928f2db8`;
- пакет охоплював 9 файлів;
- 4 файли реально змінилися;
- 5 файлів були примусово перезаписані тим самим вмістом;
- SHA всіх 9 live-файлів після apply збіглися з target SHA;
- контейнери не оновлювались і не перезапускались;
- persistent discovery останнього batch rollback реалізований;
- виправлення rollback allowlist зібране та встановлене;
- повний користувацький цикл rollback після останнього виправлення ще треба
  перевірити практично;
- серверні файли наразі залишаються в застосованому target-стані.

Останній локальний прогін основного набору тестів: **27/27 успішно**. Загалом у
source є 30 unit-тестів у 7 test-файлах; `installer-control.test.mjs` не входив
до останньої стандартної команди запуску.

## 3. Що реалізовано у всій апці

### 3.1 Desktop-оболонка

Поточна схема:

```text
standwatch.exe (WinForms + WebView2)
  └─ запускає standwatch-server.exe --no-open
       └─ локальний HTTP backend на 127.0.0.1
```

Реалізовано:

- native WinForms-вікно;
- WebView2 замість зовнішнього Edge app-window;
- single-instance через named mutex;
- активація вже відкритого вікна через named pipe;
- запуск backend як прихованого дочірнього процесу;
- readiness check через `/api/ping` і перевірку правильного `dataDir`;
- Windows Job Object, який прибирає backend та його descendants при завершенні;
- graceful `/api/quit` із fallback на завершення власного process tree;
- локальний desktop log;
- окремий каталог WebView2 profile;
- відкриття зовнішніх HTTP/HTTPS-посилань у системному браузері.

Ця частина є хорошою основою. Повертатися до зовнішнього Edge або lifecycle
через `pagehide` не потрібно.

### 3.2 Portable launcher

Один portable EXE містить payload, створює поруч папку `StandWatch`, розпаковує
runtime і не перезаписує вже наявні файли в `data`.

Слабкі місця:

- payload version задана вручну в C# source;
- актуальний debug runtime оновлювався ручним копіюванням backend EXE;
- у workspace накопичено багато старих release, payload і smoke-копій;
- немає одного відтворюваного release pipeline;
- немає єдиного version/manifest, який однозначно показує склад збірки.

### 3.3 Сервери та SSH onboarding

Реалізовано:

- налаштування постійного SSH-ключа StandWatch;
- окремий bootstrap key для першого підключення;
- створення нового monitoring key;
- готова команда встановлення public key;
- додавання, редагування, перейменування і видалення сервера;
- перевірка SSH та Docker перед збереженням;
- спадкування default SSH settings;
- одноразове встановлення root-owned config helper через sudo;
- вузьке правило `NOPASSWD` лише для helper.

Проблема: додавання сервера зараз поєднує read-only monitoring і privileged
config management. Сервер неможливо природно додати лише для спостереження без
одночасного системного setup.

Пропонована модель capabilities:

```text
Monitoring ready
Installer linked
Config management ready
Backup ready
Container rollout ready       # пізніше
```

### 3.4 Огляд і сканування стендів

Через SSH/Docker, Registry, GitLab, TeamCity та HTTP збираються:

- container/image/tag;
- compose project і container state;
- image digest;
- commit, branch і build з OCI/rscore labels;
- digest відповідного registry tag;
- GitLab project і branch state;
- останній успішний TeamCity build;
- commit, які ще не потрапили в успішний build;
- HTTP fingerprint web assets і Swagger.

Правильно розділено два різні сигнали:

- стенд відстає від уже зібраного образу;
- у Git є зміни, які ще не зібрані.

Слабкі місця:

- scan виглядає однією непрозорою операцією, хоча має багато джерел;
- немає прогресу по джерелах і сервісах;
- немає cancel;
- `невідомо`, `помилка` і `дані застаріли` недостатньо розрізняються;
- backend autoscan і UI auto timer дублюють один одного;
- GitLab/TeamCity auto-mapping використовує heuristics, але confidence і
  джерело відповідності не завжди достатньо видимі;
- глобальне `NODE_TLS_REJECT_UNAUTHORIZED=0` послаблює TLS для всього процесу,
  а не лише для конкретних внутрішніх стендів.

### 3.5 Головний dashboard

Реалізовано:

- огляд усіх серверів;
- кеш останнього scan;
- групування сервісів за compose project;
- картки сервісів зі станом, deployed tag, release tag та verdict;
- окреме вікно деталей сервісу, Git/CI і вибору tag;
- installer drift banner.

На великих стендах карткова сітка перетворюється на довгу стіну. Потрібні:

- пошук;
- фільтри за станом;
- сортування за серйозністю;
- згортання compose-груп;
- явний час актуальності даних;
- стабільна семантика кольорів у всій програмі.

### 3.6 Старий ручний deploy flow

Існує окремий сценарій:

```text
вибір image tag
→ /api/deploy
→ sudo /usr/local/bin/deploy-svc.sh
```

Він не інтегрований із:

- installer plan;
- backup gates;
- файловими рішеннями;
- batch transaction;
- майбутнім container rollback.

Його не варто використовувати як основу нового container rollout. До появи
єдиної операційної моделі його слід позначити legacy/manual і не розвивати.

### 3.7 Проєкти, installer і compose-групи

Поточна предметна модель:

```text
Проєкт / банк
├─ installer-репозиторії
└─ сервери

Сервер
└─ compose-групи
   └─ installer binding + commit + scopeFiles + installRoot
```

Реалізовано:

- менеджер проєктів/банків;
- кілька installer-репозиторіїв у проєкті;
- прив'язка серверів до проєкту;
- manual/installer mode для кожної compose-групи;
- installer tag або branch, зафіксований на immutable commit;
- manifest checksum;
- compose scope для конкретної групи;
- installation root;
- автоматичне визначення root через Docker Compose labels;
- installer snapshot із compose-файлів;
- розкриття `.env` змінних і явне позначення unresolved variables.

Слабке місце: зв'язки розкладені між `servers.json`,
`installer-catalog.json`, cache, plans і browser localStorage. Назва сервера
часто використовується як ключ, тому rename потребує ручної міграції кількох
наборів даних. Поточний rename не мігрує принаймні `filePolicies`,
`groupInstaller`, plan filenames та `transaction.server`. Оскільки rollback
шукає сервер за `transaction.server`, перейменування може зробити наявні
транзакції недоступними для rollback.

### 3.8 Installer target і план

Поточний план містить:

- pinned installer commit/checksum;
- installer services;
- deployed service state;
- service differences;
- file SHA comparison;
- backup preflight;
- DB candidates і mounts;
- локальний plan snapshot.

Хороші рішення:

- target immutable;
- scope задається для конкретної compose-групи;
- plan спочатку read-only;
- порівнюється повний склад installer;
- секретні/бінарні файли не читаються бездумно;
- plan зберігається атомарно.

Проблема: поняття `plan` зараз одночасно означає target, snapshot, diff,
backup inventory, merge decisions і вже виконані зміни. Через це plan може мати
статус `read-only-draft`, хоча частину файлів уже застосовано.

Пропоноване розділення:

```text
Target     — бажаний стан із pinned installer
Snapshot   — фактичний стан сервера у момент збору
Plan       — різниця Target ↔ Snapshot
Decisions  — погоджені користувачем варіанти
Operation  — конкретна спроба виконання
Result     — фактичний результат і перевірки
```

### 3.9 Backup і restore-test

Реалізовано:

- preflight `df`, `du`, Docker inspect і mounts;
- визначення DB containers;
- локальний потоковий tar `home`, `scripts`, `volumes`;
- виключення runtime logs і PostgreSQL pgdata;
- окремий `pg_dumpall`;
- `pigz -1`, якщо доступний;
- progress, bytes і швидкість;
- SHA-256 та повне gzip verification;
- manifest `restore-point.json`;
- ізольований PostgreSQL restore-test у тимчасовому контейнері/volume;
- звірка ролей, databases, extensions і tables;
- cleanup тимчасових контейнерів/volumes.

Поточний Poruch backup приблизно містить:

- файловий архів близько 3.37 GB;
- PostgreSQL dump близько 454 MB;
- verified checksums/gzip;
- незахищений RabbitMQ named volume.

Обмеження:

- verified artifact ще не дорівнює перевіреному disaster restore;
- restore-test порівнює переважно структуру, а не дані/row counts;
- структура live DB береться у момент тесту, не з T0 snapshot;
- підтримується один PostgreSQL dump;
- backup live-директорій не quiesced;
- RabbitMQ volume не має backup/restore policy;
- великий tar використовується як джерело окремих baseline-файлів, що повільно;
- немає retention та encryption policy.

### 3.10 Config reconcile, merge, apply і rollback

Реалізовано:

- JSON/JSONC parsing;
- YAML/Compose/Envoy parsing;
- повнофайловий side-by-side line diff;
- навігація між hunks;
- рішення server / installer / manual;
- bulk `усе з сервера`, `усе з installer`, `ігнорувати файл`;
- browser persistence чернеток;
- validation target;
- live SHA gate;
- root-owned helper v3;
- T2 snapshot безпосередньо перед записом;
- atomic write;
- target SHA verification;
- local transaction journal;
- batch prepare/apply;
- автоматичний rollback уже застосованих файлів при падінні batch;
- ручний rollback окремого файла і останнього batch;
- контейнерні restart/update навмисно не виконуються.

Слабкі місця:

- рішення живуть переважно у browser `localStorage`;
- old key-level JSON reconcile існує паралельно з full-file engine;
- JSONC читається застосунком, але при справжній зміні файла helper використовує
  строгий `jq`/`python3 -m json.tool` validator і може відхилити валідний для
  застосунку JSONC; byte-identical DEBUG rewrite та rollback цю перевірку
  оминають;
- batch не має власного повного state machine;
- batch journal може залишатися `applied`, коли дочірні transactions уже
  rolled back;
- після повного ручного rollback endpoint latest-batch може пропустити цей
  batch без активних дочірніх transactions і запропонувати відкотити попередній;
- remote T2 і local journal — дві половини одного recovery mechanism;
- при втраті локального `data` програма не зможе зіставити наявні remote T2;
  transaction ID в імені remote-файла пояснюється лише локальним journal, тому
  snapshot фактично стає анонімним;
- немає retention/cleanup для T2;
- semantic correctness YAML/Envoy не гарантується лише синтаксичним parsing;
- великий backup повільно читається для кожного файла;
- file apply і plan status недостатньо синхронізовані.

### 3.11 Дані та історія

Поточний стан розкладений по:

```text
data/config.env
data/servers.json
data/installer-catalog.json
data/cache/*.json
data/plans/*.json
data/config-transactions/*.json
data/backups/*
browser localStorage
```

Додатково зараз існують два різні дерева `data`:

```text
D:\_Work_\00_Inbox\TMP\RCC\StandWatch\data\
D:\_Work_\00_Inbox\TMP\RCC\StandWatch\
  StandWatch-Debug-With-Current-Data-20260915\StandWatch\data\
```

Вони вже розійшлися за `servers.json`, installer catalog і складом runtime
артефактів. Авторитетним для чинної робочої версії є `data` біля фактично
запущеного runtime executable. Під час міграції це потрібно підтвердити через
`/api/ping.dataDir` і зафіксувати в inventory; кореневий `data` не можна
помилково використати як актуальний.

Окремі JSON зручні для дебагу, але немає єдиного джерела істини та нормальної
історії операцій. Потрібен екран, який відповідає на питання:

- що було заплановано;
- що погодив користувач;
- що реально виконано;
- які SHA були до і після;
- що відкотилося;
- що залишилося в partial state;
- які backup/T2 ще актуальні;
- які артефакти можна очищати.

Для structured metadata пропонується локальна SQLite-база або еквівалентний
transactional store. Великі backup залишаються звичайними файлами. JSON можна
залишити як export/debug формат.

### 3.12 UI та інформаційна архітектура

Зараз одночасно використовуються:

- головна dashboard-сітка;
- огляд серверів;
- project manager modal;
- right installer dock;
- plan modal;
- reconcile modal;
- full-file merge modal;
- permissions modal;
- service/tag modal.

Це призводить до модалок поверх модалок, загубленого контексту, кількох
scrollbar і перевантажених footer.

Пропонована верхня навігація:

```text
Огляд
Сервери
Проєкти / installer
Операції
Налаштування
```

Сторінка окремого сервера:

```text
Стан
Сервіси
Installer target
Конфігурації
Backup
Історія
```

Повнофайловий merge має бути окремим workspace, а не модалкою поверх plan
modal. Повернення з нього не повинно втрачати decisions і scroll context.

### 3.13 Кодова база

Основний `stand-panel.work.mjs` зараз має приблизно 3433 рядки і 356 KB. В
одному template-heavy файлі знаходяться:

- backend routes;
- backup і restore-test;
- SSH/helper setup;
- file transactions;
- HTML;
- CSS;
- увесь browser JavaScript.

Це вже спричиняло ситуації, коли Node syntax check проходив, але згенерований
browser JavaScript був пошкоджений escaping у template literal.

Винесені модулі вже існують для частини pure logic:

- `stand-version.mjs`;
- `installer-control.mjs`;
- `config-reconcile.mjs`;
- `yaml-reconcile.mjs`;
- `file-merge.mjs`;
- `backup-config-source.mjs`;
- `config-transaction.mjs`;
- `config-apply-safety.mjs`.

Наступний рефакторинг повинен розділити routes/services/frontend без зміни
поведінки.

### 3.14 Тести, source control і release hygiene

Є unit-тести pure modules, але майже немає автоматизованого покриття:

- HTTP routes;
- SSH failure modes;
- helper install/upgrade;
- batch partial failure/recovery;
- restart persistence;
- browser interactions;
- generated frontend syntax;
- portable update;
- `apply → app restart → rollback`;
- actual restore drill.

Build script не запускає тести автоматично. Поточний каталог не є Git
repository. У корені накопичені старі EXE, ZIP, release, smoke і staging
директорії. Це робить незрозумілим, який source і executable є канонічними.

## 4. Узгоджена структура робочої папки

Поточний корінь залишається контейнером для source, runtime, releases та
архівів:

```text
D:\_Work_\00_Inbox\TMP\RCC\StandWatch\
├─ repo\
│  ├─ src\
│  │  ├─ backend\
│  │  ├─ frontend\
│  │  └─ desktop\
│  ├─ tests\
│  ├─ scripts\
│  ├─ docs\
│  ├─ package.json
│  ├─ .gitignore
│  └─ README.md
├─ runtime\
│  └─ current\
│     ├─ standwatch.exe
│     ├─ standwatch-server.exe
│     ├─ runtime DLL
│     └─ data\
├─ dist\
│  └─ StandWatch-Portable-<version>.exe
├─ archive\
│  └─ legacy-20260924\
└─ temp\
```

Правила:

1. `repo` — єдине місце, де редагується source.
2. `runtime/current` — єдина встановлена робоча копія застосунку.
3. У runtime не редагується source вручну.
4. `dist` містить лише завершені immutable release artifacts.
5. `archive` не використовується для збірки чи запуску.
6. `temp` повністю disposable.
7. `data`, EXE, DLL, PDB, logs, WebView2 profiles, backup і secrets не
   потрапляють у Git.
8. Чинну папку `StandWatch-Debug-With-Current-Data-20260915` не рухати, доки
   застосунок запущений.
9. Під час міграції чинні `data`, plans, transactions і backup не видаляти.
10. Старі artifacts спочатку лише архівувати; очищення — окрема погоджена дія.

Майбутній portable layout після запуску одного distributable EXE:

```text
StandWatch\
├─ app\
│  ├─ standwatch.exe
│  ├─ standwatch-server.exe
│  └─ runtime files
├─ data\
│  ├─ standwatch.db
│  ├─ cache\
│  ├─ backups\
│  └─ logs\
├─ temp\
└─ version.json
```

Source може бути поділений на десятки модулів, але build повинен bundle backend
у один `standwatch-server.exe`. Користувач отримує один
`StandWatch-Portable-<version>.exe`, який створює готову папку програми і при
оновленні не перезаписує `data`.

## 5. Пропонований порядок робіт

### Статус виконання на 2026-09-24

- етап 0 виконано: чинний runtime зупинено, переміщено без копіювання великих
  backup у `runtime/current`, зафіксовано SHA та стан останнього DEBUG batch;
- етап 1 виконано: канонічний source міститься в `repo`, створено Git repository,
  baseline commit `80e100a` і tag `baseline-2026-09-24`;
- етап 2 виконано: `npm run release:portable` запускає tests, backend/frontend
  smoke, desktop build, формування versioned portable artifact і SHA manifest;
  review launcher також успішно розгорнуто й запущено в ізольованому каталозі;
- етап 3 частково виконано в commit `acf78ea`: rename із наявною історією
  блокується, latest-batch більше не відступає до старішої операції, додано
  regression tests; усього проходять 34 тести;
- authoritative runtime data: `runtime/current/data`;
- ще не виконано: оновлення `runtime/current` новою збіркою та користувацький
  цикл rollback поточного batch;
- етап 4 не розпочато.

### Етап 0. Зафіксувати робочий стан

- **Виконано 2026-09-24.**
- зупинити StandWatch перед файловими переміщеннями;
- зробити контрольну копію source, runtime metadata і manifest важливих
  artifacts;
- записати SHA чинних executable;
- зафіксувати current server/config operation state;
- не виконувати rollback або інші server mutations під виглядом рефакторингу.
- до оновлення portable version/payload policy не запускати старий portable
  launcher поверх чинного debug runtime.

### Етап 1. Створити чистий repository

- **Виконано 2026-09-24.**
- створити `repo`;
- перенести лише актуальний source, tests і документацію;
- створити `.gitignore`;
- ініціалізувати Git;
- зробити initial commit/tag поточної робочої версії;
- не переносити runtime data, secrets та великі artifacts у Git.

### Етап 2. Єдина команда test/build/package

- **Виконано й перевірено ізольованим launcher smoke 2026-09-24.**

Pipeline:

```text
unit tests
→ backend integration/syntax smoke
→ frontend generated-script check
→ build backend SEA
→ build desktop host
→ form payload
→ build portable launcher
→ manifest/version/SHA
→ clean dist artifact
```

Після цього має існувати одна очевидна відповідь на питання «який EXE
запускати».

### Етап 3. Закрити чинні критичні recovery-дефекти

- **Частково виконано:** code/test fixes готові; runtime update та реальний
  rollback ще не виконані.

До великого mechanical split, але вже після фіксації source у Git і
відтворюваної збірки:

- заборонити або повністю мігрувати rename сервера, якщо існують transactions;
- виправити latest-batch discovery, щоб rolled-back batch не відкривав шлях до
  випадкового rollback попереднього пакета;
- додати integration-тести для обох сценаріїв;
- перевірити користувацький цикл rollback поточного batch;
- зафіксувати authoritative runtime `data`;
- не запускати старий portable launcher до оновлення payload/version policy.

### Етап 4. Механічно розділити моноліт

Без зміни API, UI і поведінки рознести:

```text
src/backend/routes/
src/backend/services/
src/frontend/
src/desktop/
```

Після кожного переміщеного блока запускати tests і portable smoke. Старий
робочий runtime лишається контрольним.

### Етап 5. Нормалізувати domain model і persistence

- стабільні `projectId`, `serverId`, `installerId`, `groupId`, `planId`,
  `operationId`;
- окремі Target, Snapshot, Plan, Decisions, Operation, Result;
- transactional metadata store;
- автоматична non-destructive migration існуючих JSON;
- backend persistence merge decisions;
- operation journal і history UI.

### Етап 6. Перебудувати інформаційну архітектуру UI

- верхні розділи замість каскаду modal/dock;
- сторінка сервера з вкладками;
- full-screen merge workspace;
- єдині badges, кольори, progress і error states;
- history/operations як first-class UI;
- збереження контексту після повернення.

### Етап 7. Стабілізувати monitoring

- один backend scheduler;
- progress по джерелах;
- cancellation і timeout;
- source freshness;
- explicit unknown/error/stale;
- додати відсутні confidence/reason та manual override для GitLab і TeamCity
  mapping;
- адресна TLS policy.

### Етап 8. Завершити файловий recovery contour

- перевірити повний цикл `apply → rollback → повторний apply`;
- durable batch state machine;
- remote T2 index/recovery;
- T2 retention;
- компактний config snapshot замість повторного читання великого tar;
- єдина JSON/JSONC validation policy;
- прибрати legacy key-level reconcile після міграції;
- завершити DB restore-test для актуального backup;
- визначити RabbitMQ volume policy;
- backup retention/access/encryption policy.

### Етап 9. Лише потім container rollout

Майбутня операція концептуально:

```text
approved Plan
→ backup/recovery gates
→ file apply
→ pull pinned images
→ recreate лише визначених контейнерів
→ running/healthy/application checks
→ commit Result
або
→ rollback image refs + files + verification
```

Контейнери потрібно зіставляти за Compose/mount topology, а не за схожістю
імен. Старий `deploy-svc.sh` flow не використовувати як транзакційну основу.

## 6. Що не слід робити зараз

- не додавати container rebuild поверх нинішнього моноліту;
- не починати великий UI rewrite до clean repository і reproducible build;
- не видаляти старі artifacts до перевірки нового runtime;
- не переносити `data` в Git;
- не виконувати destructive restore;
- не вважати checksum-only backup доказом повного recovery;
- не підтримувати одночасно два рівноправні reconcile engines;
- не розвивати legacy deploy окремо від Operation model;
- не змішувати механічний source refactor із remote mutations.

## 7. Ризики, які мають бути закриті до контейнерів

1. Немає повністю перевіреного користувацького batch rollback після останнього
   виправлення.
2. Rename сервера тимчасово блокується, якщо історія посилається на його ім'я;
   повне вирішення потребує стабільного `serverId` і міграції persistence.
3. Latest-batch discovery виправлено й покрито regression tests; потрібна ще
   перевірка після встановлення нової збірки в runtime.
4. RabbitMQ named volume не захищений.
5. Batch apply/rollback не має повного durable state machine.
6. Local journal і remote T2 можуть втратити зв'язок; без local journal remote
   T2 практично стають анонімними файлами без retention.
7. Plan status не відображає фактично виконані operations.
8. Merge decisions не є server-side durable/auditable.
9. JSONC policy між app і helper неузгоджена саме для реальних змін JSONC.
10. Немає integration/E2E coverage критичних recovery-сценаріїв.
11. Build/release об'єднано в один відтворюваний процес; лишився launcher E2E
    smoke та формалізація release promotion.
12. Source перенесено в канонічний Git repository `repo`.
13. Secrets зберігаються plaintext, а TLS verification вимкнена глобально.
14. Монолітний backend/frontend файл робить подальше розширення ризиковим.
15. Portable source має payload version `2026.09.16.4`, а marker чинного
    runtime — `2026.09.15.13`. Повторний запуск старого portable launcher може
    перерозпакувати старий payload поверх вручну оновленого backend.
16. Існують два різні дерева `data`; перенесення неправильного дерева означатиме
    втрату актуальних servers/plans/transactions/backups.

## 8. Питання для зовнішнього рев'ю

Просимо рев'юера оцінити не окремі косметичні деталі, а весь напрям:

1. Чи правильне розділення Target / Snapshot / Plan / Decisions / Operation /
   Result?
2. Чи виправдана SQLite для локального metadata store, чи краще лишити інший
   transactional формат?
3. Чи безпечний порядок: repository/build → mechanical split → persistence/UI
   → recovery → containers?
4. Яких ризиків не вистачає в backup, config apply та майбутньому container
   rollout?
5. Як найкраще моделювати partial operation і coordinated rollback?
6. Чи варто add-server залишити read-only за замовчуванням, а privileged
   capabilities активувати окремо?
7. Які integration/E2E tests є мінімальним gate перед container operations?
8. Як краще організувати portable atomic update, schema migrations і rollback
   самої StandWatch?
9. Чи достатньо запропонованого source/runtime/dist/archive layout?
10. Який legacy функціонал варто видалити, а який тимчасово залишити read-only?

Очікуваний результат рев'ю: зауваження та альтернативи до початку реалізації,
а не негайні правки коду.

## 9. Найближчий практичний крок після погодження

1. Закрити запущену StandWatch.
2. Створити `repo`, `runtime`, `dist`, `archive`, `temp`.
3. Не видаляючи нічого, скопіювати актуальний source у `repo`.
4. Створити inventory і SHA manifest чинних runtime artifacts.
5. Ініціалізувати Git та initial commit.
6. Налаштувати єдину test/build команду.
7. Переконатися, що нова clean build функціонально ідентична поточній.
8. Виправити й покрити тестами rename/rollback та latest-batch дефекти.
9. Перевірити rollback поточного batch.
10. Лише тоді почати механічне розділення `stand-panel.work.mjs`.

## 10. Результат зовнішнього рев'ю від 2026-09-24

Незалежний перегляд коду й runtime підтвердив основні факти документа, включно
з SHA, розмірами source/backup, кількістю тестів, станом batch, дублюванням
reconcile і autoscan, global TLS bypass та plaintext secrets.

Прийняті уточнення:

- JSONC-ризик стосується реальної зміни файла, а не byte-identical rewrite чи
  rollback;
- rename сервера вже зараз ламає доступність rollback старих transactions;
- latest-batch discovery може перейти до попереднього batch після rollback;
- TeamCity mapping confidence у UI не просто недостатньо видимий — він взагалі
  не повертається в результат;
- старий portable launcher може перезаписати вручну оновлений runtime;
- два дерева `data` вже розійшлися і потребують явного визначення
  authoritative source;
- без local journal remote T2 не мають самодостатнього recovery index;
- recovery safety fixes треба виконати до великого mechanical split.

За оцінкою review, у workspace накопичено приблизно:

- 14 `_payload_*.zip` — близько 1.40 GB;
- 11 застарілих backend EXE у runtime — близько 1.06 GB;
- 4 EXE у корені — близько 0.29 GB;
- 48 службових каталогів із префіксом `_`.

Ці файли не видаляються під час первинного впорядкування. Спочатку вони
потрапляють у `archive/legacy-20260924`, а очищення виконується лише після
перевірки clean build і чинного runtime.

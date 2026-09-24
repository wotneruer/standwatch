# Хендовер для Codex — Config Reconcile (StandWatch), 21.09.2026

Автор: Claude (сесія 17–18.09, поки ти був офлайн). Робив **окремим модулем + тонке підключення**,
щоб мінімізувати перетин із твоїми правками. Нижче — що готово, як влаштовано, що далі, і **пастки**.

Джерела правди: `PLAN-config-reconcile-restore.md` (модель), `CONTINUE-2026-09-17-config-reconcile-mvp.md`
(деталі по датах). Ця нотатка — короткий вхід.

---

## 0. КРИТИЧНА ПАСТКА (прочитай перед будь-якою правкою UI)

Уся сторінка панелі — це **один JS template-літерал** `const PAGE = /* html */ \`…\`` у `stand-panel.work.mjs`,
і браузерний `<script>` теж усередині нього. Тому будь-який `\` у браузерному коді СПЕРШУ обробляє літерал:
- `\/` → `/` (ламає regex `/^https?:\/\//`);
- `\n`, `\t` → **реальний перенос** → розрив рядка в лапках → `SyntaxError`;
- `\s`, `\d`, `\w`, `\.` → просто `s/d/w/.` (regex тихо працює НЕ так).

Наслідок — увесь inline-скрипт мертвий, сторінка вічно «Завантаження…». **`node --check` цього НЕ ловить.**
Правила для браузерної частини:
- жодних regex-літералів зі слешами/класами → рядкові методи (`split('//').pop()`, `trimEnd()`);
- щоб у браузер потрапив справжній `\n` — писати `\\n` у джерелі;
- апостроф у рядку в `'…'` → брати `’` (U+2019), не `'`.
Після КОЖНОЇ правки UI перевіряти в браузері (console errors), не лише `node --check`.
(Ловилось двічі за сесію.)

## Робочі правила середовища
- Портал Антона на **8788 не вбивати**. Для власних перевірок: `node stand-panel.work.mjs --no-open --port 9100`,
  і **зупинити після** (`taskkill //F //PID <pid>`).
- Збірка: `node build-standwatch-work.mjs` → `standwatch-server.new.exe`. Деплой у
  `StandWatch-Debug-With-Current-Data-20260915/StandWatch/standwatch-server.exe`.
- Dev-режим (`node .mjs`) читає **порожні** `servers.json` / `installer-catalog.json` із source-теки.
  Реальні дані — у debug-теці (PORTABLE, `DATA_DIR`). Тому reconcile наживо тестується лише через exe.

---

## 1. Що ГОТОВО

### Двигун — `config-reconcile.mjs` (окремий модуль, «мозок»)
Експорти: `parseJsonc`, `parseEnv`, `configFormat`, `parseConfig`, `flatten`, `looksPlaceholder`,
`reconcile`, `buildTarget`, `unflatten`, `materialize`.
- **JSONC-парсер** `parseJsonc`: прибирає `//`,`/* */`, trailing commas, BOM — але ЛИШЕ поза рядками
  (state-machine на подвійних лапках), тож `http://…` і `/*…*/` усередині значень не чіпає.
- `parseEnv` + `parseConfig(path,text)` / `configFormat(path)` → `'json' | 'env' | null` (yaml/envoy → null).
- `reconcile(backup, installer, qa)` → `{rows, summary, conflicts, autoResolved, total}`.
  Вердикти: `same | new-from-installer | backup-only | conflict | qa-override`.
  Правило: «є в обох, різне» = **conflict** (НЕ auto-resolve на backup — рішення людини).
- `buildTarget(result, decisions)` → `{flat, unresolved}`. `decisions[key]`: `'server'|'installer'|{value}`
  (усе, що не `'installer'`/`{value}`, дає серверне).
- `unflatten(flat)` (dotted-path + `[i]` → вкладений обʼєкт), `materialize(path, target)`
  (.json → `JSON.stringify`, .env → `KEY=val`). Юніт-перевірено.

### Бекенд — `stand-panel.work.mjs`
- `resolveConfigBinding(server, group)` (біля рядка 196): ціль для reconcile = **зафіксований
  `installerGroups[group]` АБО останній збережений план** (`latestInstallerPlan().plan.target`:
  project, `commit.id`→ref, installRoot). Це фіксить «не зафіксовано installer», коли є план без binding.
- `GET /api/reconcile?server=&group=&path=` — cat серверного файлу (SSH) + `installerFileText` →
  `parseConfig` обох → `reconcile`. Приймає `.json` і `.env` (yaml → 400). Для `.env` значення **масковані**
  (`masked:true`, `••••••`, порожнє → `(порожнє)`).
- `GET /api/reveal?server=&group=&path=&key=&side=server|installer` — reveal ОДНОГО значення на клік.
  Значення **не логуємо, не кешуємо**.
- `POST /api/reconcile/target` `{server,group,path,decisions}` — `reconcile` → `buildTarget` →
  якщо `unresolved` вертає їх; інакше `materialize` → текст. Для secret прев'ю масковане.
  **Dry-run: нічого не застосовує, на диск не пише.**

### `installer-control.mjs`
- `installerFileText(config, project, path, ref)` — текст одного файлу репо за ref.
- `installerComparableFileHashes` тепер **включає `.env`** у порівняння з тегом `secret:true`
  (справжні бінарні секрети .pem/.key/*secret* лишаються поза). Тому `.env` зʼявляються у списку файлів плану.

### UI (у `stand-panel.work.mjs`, всередині PAGE)
- **Reconcile-модалка** інтегрована в план: JSON/`.env` файли зі статусом «відрізняється/відсутній»
  клікабельні (`⇄`, `.rc-file`) → `openReconcileFor(path)`. Модалка розширена (`dialog#reconcileDlg` до 1240px).
- **Side-by-side diff** (git-style): ліворуч сервер (червоне `−`), праворуч installer (зелене `+`),
  однакові згорнуті. Для secret — 🔒-нотатка, значення масковані, **reveal по кліку** (пунктирний спан).
- **Секція «Рішення по конфліктах»** під diff: на конфлікт — поле-значення + чіпи `сервер`/`installer`
  (+ `вручну` для секретів), inspector підсвічує початковий/кінцевий пробіл і рахує символи, дефолт для
  секрету — «лишити серверне». Кнопка **«Показати цільовий конфіг · dry-run»** активна лише коли всі
  конфлікти вирішені → `POST /api/reconcile/target` → показує матеріалізований target. Через делегування подій.

### Побічне (не reconcile, але зроблено цієї сесії)
- **Редагування сервера**: `POST /api/edit-server` + картка на ✎ (host/юзер/назва, SSH-перевірка перед збереженням).
- **group→installer автовибір**: `installerCatalog.groupInstaller` (`server|group → projectPath`);
  `loadProjects()` передобирає installer (binding → запамʼятований → єдиний → за basename шляху → перший).
- Фікси: `unhandledRejection`/`uncaughtException` safety-net (недоступний сервер більше не валить панель),
  `newerVersion` (конкретний білд замість `dev.latest`), scp-бекап (замість Node-стрімів).

## Стан перевірки
- ✅ Двигун (unit), усі 3 ендпоінти (валідація), init цілий (консоль чиста).
- ✅ Наживо на Yetu (Антоном): `.env` reconcile, reveal, автовибір installer.
- ⚠️ **Секцію «Рішення» візуально не перевіряли** наживо (треба конфлікт на живому сервері) — глянути на
  `vpo-service/appsettings.json` (`DatabaseAnalyze.IntervalHours 1→8`).

---

## 2. Що ТРЕБА зробити (за пріоритетом)

1. **Apply-фаза (T2)** — найголовніше, ще НЕМА. Керований запис target на сервер:
   `prepare → validate → runtime-preflight → snapshot поточних файлів → scp target →
   restart ЛИШЕ affected → health-check → (fail) rollback`. **БД не чіпати.** Rollback — first-class.
   Зараз `/api/reconcile/target` лише повертає прев'ю; персист/scp/рестарт — за тобою.
2. **Типізація ручних значень**: `{value}` з інпута — рядок; у JSON числове поле стане `"8"` а не `8`.
   Коерсити за типом оригіналу (installer/backup).
3. **Секрети / `pass` (§7 плану)**: значення не тягнути/не порівнювати, лише reference; resolve через
   secret-provider на apply. Для `.env` masked-режим уже є, але apply має підставляти `$(pass …)` правильно.
4. **QA-профіль**: version-controlled yaml (`profile`, `rules`, `overrides`) → `reconcile(…, qaProfile)`
   уже приймає третій аргумент; треба файл-профіль + UI редагування + застосування overrides (`dns_refresh_rate` тощо).
5. **envoy / великий yaml** — окреме рішення: **`js-yaml` бандлом** (esbuild), витяг **named-полів**
   (порти, адреси, `dns_refresh_rate`) у той самий key-diff, решта — **рядковий diff по кліку**. Масово не парсити.
6. **Static + runtime DB-валідація** (§5): юзер із connection string ↔ роль у `pg_dumpall`; runtime-preflight
   (PostgreSQL reachable, db/role exists, auth ok) перед apply.
7. Дрібне: group→installer перевірено лише на rscore (Yetu); косметика diff-layout за бажанням.

## Не ламати (домовленості)
- Reconcile **нічого не застосовує автоматично** — рішення завжди за людиною (жодного auto-resolve на конфліктах).
- Секрети в UI — масковані, reveal лише on-demand по кліку, значення не логувати/не персистити в plaintext без потреби.
- Доставка — **тільки UI**, консоль лише як тимчасовий debug.

---

## 3. Продовження Codex — 2026-09-21

### Rollback перед змінами

- Створено й перевірено архів source/docs:
  `_source_backup_before_config_apply_20260921_092243.zip`.
- SHA-256: `4A47277F1AE2A7F4EF0EF3F3C174FB4DC91ABF29197A22F3AB96885A4470459F`.
- Архів містить 25 вихідних/проєктних файлів; runtime-data, великі backup-и й EXE не дублювалися.

### Уже реалізовано

- Додані постійні тести `config-reconcile.test.mjs`, `backup-config-source.test.mjs`,
  `config-apply-safety.test.mjs` — 12 тестів проходять.
- Ручні JSON-значення тепер коерсяться у вихідний тип: number/boolean/null/object/array/string.
  Якщо backup та installer мають різні типи, ручне значення блокується як неоднозначне.
- Reconcile більше не використовує live server як authoritative «було»:
  - знаходить найновіший локальний **verified T0 backup** того самого server/group та installer ref/commit;
  - потоком дістає один файл зі `stand-files.tar.gz`, не розпаковуючи архів на диск;
  - окремо читає live-файл лише для SHA drift-check;
  - `/api/reconcile/target` блокується, якщо live SHA відрізняється від T0 SHA.
- Reveal лівої сторони тепер читає значення з T0 backup. Усі JSON API вже мають
  `Cache-Control: no-store` через спільний `json()` helper.
- UI перейменовано з «Сервер зараз» на **Verified backup T0** і показує backup plan id та live SHA status.
- JSONC-коментарі детектяться окремо: URL/`/*` у рядках не дають false positive.
- Affected containers визначаються за Docker bind mounts, включно з directory mounts, а не за назвою сервісу.
- Доданий read-only `POST /api/reconcile/prepare`: збирає typed target, перевіряє gates,
  comments, SHA та mount impact, але нічого не записує і не рестартить.

### Перевірено на реальному Poruch QA (read-only)

- T0: `20260916131839772_poruch_qa_rscore`, installer `1.7.3 / f7925511`.
- `volumes/config/vpo-service/appsettings.json` витягнуто з 3.37-ГБ archive за ~17 с.
- T0 SHA і live SHA збігаються:
  `a16f332b01ebbd78070a4fcda66797db9b340602f08928b5e7c1b554895f7b72`.
- Конфлікт: `DatabaseAnalyze.IntervalHours`, backup `1`, installer `8`.
- Manual `6` матеріалізується JSON number; `six` відхиляється.
- Prepare gates усі зелені; affected container за mount: `vpo-service`,
  `/usr/local/rscore/volumes/config/vpo-service/appsettings.json → /app/appsettings.json`.
- Browser inline script перевірено після рендера через `new Function(...)` — синтаксис коректний.

### Наступний незавершений крок

Apply ще навмисно не активований. `prepare` повертає блокери:

1. повторна live mount-перевірка безпосередньо перед записом;
2. T2 snapshot поточного файла + SHA;
3. передача target у sibling temp-файл, перевірка SHA/owner/mode, atomic rename;
4. restart affected container, health-check і rollback із T2 snapshot при невдачі;
5. redacted transaction journal без plaintext secrets.

Перший apply лишається обмеженим одним не-secret JSON:
`vpo-service/appsettings.json`; `.env`, YAML/envoy та БД не застосовувати.

### Транзакційний JSON apply + T2 rollback (продовження 21.09)

- Додано `config-transaction.mjs` і тести: безпечні remote paths/transaction id,
  redacted decision journal та оцінка Docker health. Загалом проходить 16 тестів.
- `POST /api/reconcile/prepare` тепер повторно читає live-файл і **живий** `docker inspect`,
  перевіряє SHA проти T0, JSONC, typed target, наявність і writable-стан bind mount,
  а також `sha256sum`, `base64`, віддалений JSON validator (`jq` або `python3`) і режим запису:
  напряму лише коли файл+директорія writable і файл належить SSH-користувачу, інакше через `sudo -n`.
- `POST /api/reconcile/apply` реалізує вузьку транзакцію лише для JSON:
  - повторний preflight;
  - sibling T2 snapshot із перевіркою SHA безпосередньо перед записом;
  - target передається через SSH stdin, пишеться у sibling temp, SHA і JSON перевіряються на сервері;
  - atomic `mv` зі збереженням mode/owner/context через `cp --preserve=all`;
  - restart лише контейнерів, що реально монтують файл;
  - health = `running`, а за наявності Docker healthcheck ще й `healthy`, у двох стабільних опитуваннях;
  - при будь-якій помилці після початку apply робиться автоматичний rollback із T2 і повторний health-check.
- `POST /api/reconcile/rollback` дає явний ручний відкат успішної транзакції для контрольного тесту.
- Журнали лежать у portable `data/config-transactions/*.json`; у них немає target/previous plaintext
  чи ручних значень — лише SHA, шлях, installer ref, контейнери та джерело рішення.
- У reconcile UI після typed dry-run є `Застосувати JSON…`, окремий confirm із файлом/контейнером/SHA,
  статус транзакції та кнопка `Відкотити до T2` після успіху.
- `.env`, YAML/envoy, БД і повний destructive restore ці endpoints навмисно не підтримують.

### Live preflight Poruch після реалізації

- Read-only prepare з рішенням `DatabaseAnalyze.IntervalHours = installer (8)` знову підтвердив:
  T0/live SHA однакові, target валідний, `vpo-service` знайдений за writable bind mount.
- Реальний apply **не запускався**. Його коректно заблокував privilege gate:
  файл/директорія не writable для `akirpichnikov`, а `sudo -n` на Poruch просить пароль.
- Перед першою транзакцією треба обрати політику привілеїв: рекомендовано встановити вузький root-helper
  для дозволених config paths/actions; альтернатива — одноразово передавати sudo password лише в памʼяті
  на час транзакції (ще не реалізовано). Не послаблювати ownership/ACL усієї `/usr/local/rscore`.

### Вузький root-helper

- Реалізовано `standwatch-config-helper.sh`: root-owned helper дозволяє тільки `check/apply/rollback`
  для реальних regular `*.json` після `realpath` у `/usr/local/*/volumes/config/`.
- Helper сам перевіряє transaction id, before/target SHA-256, створює sibling T2/temp, валідовує JSON,
  робить atomic `mv`; довільну shell-команду виконати через нього не можна.
- `install-standwatch-config-helper.sh <ssh-user>` встановлює helper у `/usr/local/sbin` і перевірену
  через `visudo` вузьку NOPASSWD-правилу лише на цей helper.
- У UI при `remoteToolsReady=false` є «Підготувати helper на сервері»: файли staging-яться у
  `~/.standwatch-helper`, а користувачу показується команда `ssh -t ... sudo sh ...`, яку він запускає
  власноруч і вводить sudo-пароль. Пароль StandWatch не отримує й не зберігає.
- Після інсталяції preflight автоматично обирає `writeMode=helper`; apply/rollback передають helper-у
  target через SSH stdin. Docker restart/health лишаються в непривілейованому flow.

### Backup progress після встановлення helper

- Перша реальна config-транзакція успішна: `20260921115919231_7ed8bed2`, Poruch QA / rscore,
  `vpo-service/appsettings.json`, `DatabaseAnalyze.IntervalHours 1 → 8`, `writeMode=helper`.
  Atomic write завершено, перезапущено лише `vpo-service`, стан `running`, restartCount 0.
  T2 snapshot лишився на сервері; ручний rollback ще не запускався.
- Новий Poruch plan `20260921115951134_poruch_qa_rscore` успішно отримав verified backup:
  `stand-files.tar.gz` 3,374,800,882 B + `rscore_postgresql.sql.gz` 454,546,954 B;
  завершено приблизно за 3 хвилини. Сервер і БД не змінювалися.
- Видиме `0 B / 0 B/s` було UI-проблемою, не зависанням: `sshCopyArtifact` оновлював progress
  лише після завершення всього `scp`.
- Додано живе опитування розміру локального `.part` кожні 500 мс і окремі фази:
  server archive → SCP transfer → local verify → DB dump/transfer/verify.
- Виправлено неточний UI-текст: поточний надійний flow справді використовує тимчасовий `.gz`
  на сервері, звіряє SHA після SCP і видаляє server temp у `finally`.

### Transaction-baseline замість повторного full backup

- Успішна транзакція вже фіксує server/group/path, before/target SHA, status і час без plaintext значень.
- Для JSON reconcile береться найновіша завершена транзакція цього файла. Якщо SHA live-файла дорівнює
  її target SHA (або before SHA після rollback), сам live-файл вважається `verified transaction baseline`.
- Якщо SHA не збігається, довіра до transaction-baseline автоматично скидається: джерелом знову стає
  verified full backup і UI показує drift. Тому ручну зміну на сервері не буде тихо прийнято за baseline.
- Жоден додатковий plaintext/encrypted config snapshot не зберігається. Full backup залишається точкою
  disaster restore, але після кожного контрольованого JSON apply його перебудовувати не потрібно.
- У UI ліва сторона тепер `Verified baseline` з позначкою `verified transaction` або `full backup`.
- `.env` як і раніше не входить у apply/checkpoint flow.

### Наступний зріз: YAML / Envoy і політики файлів

- На актуальному Poruch QA / rscore у порівнянні installer немає `.env`; реальні наступні кандидати:
  `home/02_platform.yml`, `home/03_custom.yml`, `home/04_api_gateway.yml`, `scripts/update.sh`,
  `volumes/config/api-gateway/envoy_dev.yaml`, `volumes/config/api-gateway/envoy.yaml`.
- `envoy_dev.yaml` не можна глобально ігнорувати за назвою: на DEV/test-стенді він може бути цільовим.
  Потрібна збережена політика на рівні конкретного server/group/installer/path:
  `managed` (звіряти і надалі дозволяти apply), `observe-only` (показувати diff, не включати в apply),
  `ignored` (не рахувати відмінністю, але показувати в окремому згорнутому лічильнику).
- Для Poruch QA / rscore `volumes/config/api-gateway/envoy_dev.yaml` має бути явно позначений
  `ignored`; це свідоме рішення користувача, а не прихована filename-евристика.
- Перший YAML-MVP — read-only для `volumes/config/api-gateway/envoy.yaml`: нормальний YAML parser,
  компактний список named-полів (адреси, порти, clusters/endpoints, `dns_refresh_rate`) і повний
  рядковий diff лише на вимогу. Apply/rollback YAML поки не вмикати.
- Compose `home/*.yml` і `scripts/update.sh` ідуть наступними окремими типами preview; образи compose
  вже покриває сервісна частина плану, тому не слід дублювати їх як десятки конфліктів конфігурації.

### YAML / Envoy read-only MVP реалізовано

- Додано `js-yaml` у локальні build dependencies; esbuild включає parser у portable backend EXE.
- Додано `yaml-reconcile.mjs`: безпечний YAML parse, semantic paths для named arrays і Envoy routes,
  key-level reconcile, bounded line diff та маскування secret-подібних YAML-ключів у текстовому diff.
- Envoy routes зіставляються за `match.path`, `match.prefix` або `match.safe_regex`, а не за індексом.
  На реальному Poruch це прибрало фальшивий каскад: 23 нібито змінених scalar-поля скоротилися до 1.
- Додано read-only `GET /api/reconcile/yaml`; він використовує verified full-backup baseline,
  перевіряє live SHA і читає installer за зафіксованим ref. Жодного YAML apply endpoint немає.
- У UI `.yaml/.yml` клікабельні: окреме вікно показує ключові адреси/порти/clusters/endpoints/
  `dns_refresh_rate`, інші структурні зміни згорнуто, повний рядковий diff відкривається окремо.
- Для файлів додані persistent режими `managed`, `observe-only`, `ignored`, scoped за
  `server|group|installer project|path`. На Poruch QA / rscore `envoy_dev.yaml` явно `ignored`;
  на інших стендах це не впливає.
- Live Poruch `envoy.yaml`: baseline `20260921115951134_poruch_qa_rscore`, live SHA збігається;
  `same=352`, `different=1`, `baseline-only=20`, `installer-only=10`, важливих змін `9`.
- Той самий YAML preview покриває Compose: `02_platform.yml` і `03_custom.yml` мають лише image-tag
  відмінності (показуються в згорнутому блоці, бо вже є в сервісному плані), а `04_api_gateway.yml`
  показує ключову зміну порту `80:90 → 80:5551`.
- Додано окремий read-only text diff для `scripts/*.sh`; на Poruch `scripts/update.sh` має 2 змінених
  рядки, основна зміна — installer прибирає старий `docker login ... -p ${DOCKER_PASSWORD}`.
- YAML UI спрощено після live-review: більше немає окремих блоків «ключові»/«інші» — усі структурні
  зміни в одній таблиці, а адреси/порти/mounts/environment лише мають бейдж `увага` і сортуються вище.
- Під час першого читання YAML/скрипта показується indeterminate progress bar, етап витягання baseline,
  лічильник секунд і пояснення, що читання великого архіву може тривати 10–30 секунд.
- Повний рядковий YAML diff винесено в окрему вкладену модалку; основна звірка більше не розтягується
  на сотні рядків униз.
- YAML/text preview має persistent cache у `data/cache/config-previews`. Перед використанням кешу backend
  дешево рахує SHA живого файла через SSH; ключ кешу також включає server/group/path/installer ref/baseline id.
  Якщо будь-що змінилось — великий backup перечитується й cache оновлюється; кнопка `Оновити` форсує це.
- Live-замір `home/02_platform.yml`: перша побудова 8.26 с, повторне відкриття з SHA-перевіркою 0.42 с.
- Структурні YAML-рядки з secret-подібними ключами тепер теж маскуються до запису persistent cache.
- Тести: 23/23; browser inline script smoke пройдено; робочий portable EXE оновлено.

### Повнофайловий Envoy merge-review

- Замість таблиці вирваних semantic paths повний `envoy.yaml` тепер відкривається як два повні,
  синхронно вирівняні файли: `Сервер / verified baseline` ліворуч і `Installer target` праворуч.
  Незмінений контекст не ховається, тому кожна різниця видима у своєму реальному YAML-оточенні.
- Рядки згруповано в change hunks. Кнопки `Попередня` / `Наступна` переводять до відповідного блоку,
  центрують його у вікні та підсвічують рамкою весь блок, а не кожен рядок окремо.
- Біля активної різниці можна вибрати `Сервер` або `Installer`. Це лише локальна чернетка рішення:
  вона зберігається в browser `localStorage`, scoped за server/group/path/installer ref/baseline,
  і не змінює ані сервер, ані installer, ані сформований план.
- Є лічильник `Зміна X із N`, кількість вирішених/невирішених блоків та очищення локальних рішень.
  YAML target assembly, preflight, apply і rollback навмисно ще не підключені.
- Реальний smoke на Poruch QA `volumes/config/api-gateway/envoy.yaml`: 835 вирівняних рядків,
  6 блоків змін, 732 видимих незмінених рядки; навігація і persistence вибору пройшли перевірку.
- Після останньої UI-правки: тести 23/23, inline browser script валідний, portable backend перебудовано
  і розгорнуто у `StandWatch-Debug-With-Current-Data-20260915/StandWatch` з наявними даними.
- Після user-review прибрано зайвий проміжний екран структурних `Зміни Envoy`: `envoy*.yaml` одразу
  відкриває повнофайловий merge. Інші YAML автоматично переходять у цей режим, якщо diff має 500+
  вирівняних рядків; компактні Compose/YAML лишаються у короткому структурному preview.
- Для кожного change-hunk додано третє рішення `Вручну`: під блоком відкривається textarea з installer-
  фрагментом, який можна відразу редагувати. Текст і режим автоматично зберігаються у scoped browser
  `localStorage`; це ще не серверний target і не використовується apply.
- Browser smoke після розгортання: Envoy відкрився напряму без старої YAML-модалки, 835 рядків / 6 hunks,
  manual editor видимий, ручна чернетка збереглася. Backend tests 23/23.
- Таблиця конфігурацій отримала явні affordance-контроли: шлях більше не маскується під URL-посилання,
  поруч є окрема синя кнопка `Порівняти YAML / Показати diff / Звірити значення`; стани стали
  контрастними outline-бейджами з піктограмами, а policy-select — кольоровим контролом з підписами
  `Керований / Лише дивитись / Ігнорувати`. Browser smoke: 9 action-кнопок, 10 станів і 10 політик.
- Таблицю повторно ущільнено після live-review: прибрано колонку розміру та чотири технічні counters
  (`без змін / відрізняються / відсутні / ignored`). У заголовку лишились `потребують уваги: X` та
  `опрацьовано: Y / X`; рядок має лише файл+дію, стан опрацювання і політику.
- File-review scoped за server/group/plan/path. Повністю вибрані YAML hunks і JSON conflicts дають
  `✓ Рішення вибрано`; read-only Compose/script preview — `✓ Переглянуто`; незавершені —
  `○ До перевірки`, ignored не входять у denominator. Browser smoke: `0/9 → 1/9` після вибору всіх
  шести Envoy hunks, таблиця має рівно 3 колонки.

### Єдиний повнофайловий merge та файлова транзакція

- JSON у `volumes/config/**/*.json`, Compose/YAML у `home/**/*.yml|yaml` і
  `volumes/config/**/*.yml|yaml`, а також `scripts/**/*.sh` тепер одразу відкривають один і той самий
  двопанельний редактор повного файла. Старі проміжні key-level/semantic/text-preview для цих типів
  більше не є точкою входу з плану.
- Кожен change-hunk має рішення `Сервер`, `Installer` або `Вручну`, навігацію між блоками й persistent
  browser draft. Блоки із замаскованими secret-подібними значеннями не дозволяють ручний режим, щоб
  `••••••` або plaintext-секрет випадково не потрапили у файл/localStorage; вибір сторони лишається.
- `.env` свідомо не переведено у повнотекстовий merge: воно лишається маскованим read-only/key-level,
  без apply, аби не розкривати секрети.
- Додані `POST /api/reconcile/file/prepare` і `/api/reconcile/file/apply`. Вони збирають raw target із
  рішень, перевіряють live SHA проти verified baseline, парсять JSON/YAML або запускають `bash -n`,
  створюють T2 sibling snapshot, роблять atomic rename і звіряють SHA.
- Apply/rollback на цій фазі змінює **лише файл**. Контейнери не оновлюються, не перезапускаються і
  health-check не запускається. Оновлення/перезапуск контейнерів — окрема наступна фаза.
- Root helper розширено на керовані JSON/YAML/SH шляхи; перед першим apply його треба один раз оновити
  через кнопку `Підготувати/оновити helper` і показану sudo-команду.
- Локальний portable розгорнуто у
  `StandWatch-Debug-With-Current-Data-20260915/StandWatch`; попередній backend збережено як
  `standwatch-server.before-unified-file-merge-20260922.exe`.
- Перевірки: 26/26 backend tests, shell syntax helper, browser inline-script syntax. Реальний read-only
  browser smoke на Poruch QA підтвердив прямий повнофайловий merge без старих модалок для JSON
  (`nethunt-integration-service/appsettings.json`, 2 hunks), Compose (`home/02_platform.yml`, 1 hunk)
  і shell (`scripts/update.sh`, 1 hunk); після вибору всіх блоків apply-кнопка активна. Реального apply
  під час smoke не виконано.

### Масові рішення та пакетний config apply

- У файловому merge додані `Усе з сервера`, `Усе з installer`, `Ігнорувати файл` і `Очистити`.
  `Усе з сервера` вважає файл опрацьованим, але вимикає пофайловий apply як порожню операцію;
  `Ігнорувати файл` записує scoped file policy й виключає його з майбутніх пакетів.
- У поточному плані додана кнопка `Застосувати пакет конфігів`. Вона активна лише за verified backup,
  актуального плану і коли кожен `managed` файл опрацьовано; `observe-only` та `ignored` не входять.
- Пакет спочатку робить preflight усіх файлів, показує кількість реальних змін і незмінних server-choice,
  а потім одним підтвердженням виконує file-only транзакції. Для кожного файла є окремий T2 та journal.
- Якщо будь-який запис пакета падає, backend автоматично відкочує вже застосовані файли у зворотному
  порядку. Після успіху UI дає ручну кнопку `Відкотити весь пакет до T2`. Контейнери не чіпаються.
- Read-only smoke: `vpo-service/appsettings.json` має 12 hunks; `Усе з сервера` дає 12/12 і disabled
  apply, `Усе з installer` дає 12/12 та enabled apply. Batch preflight для server-choice повернув
  `prepareReady=true`, `changeCount=0`, `unchangedCount=1`. Реальний batch apply не запускався.
- На Poruch QA 2026-09-22 read-only SSH-check підтвердив старий helper: JSON повертає `helper:jq`,
  а `home/*.yml` і `scripts/*.sh` відхиляються старим JSON-only allowlist. Нові helper-файли staged у
  `~/.standwatch-helper`; потрібен один повторний запуск installer через sudo. Він оновлює root-owned
  helper і постійне вузьке `NOPASSWD`-правило, після чого пакетні JSON/YAML/SH apply/rollback не повинні
  запитувати пароль або ручні chmod/chown. Запис зберігає mode/owner вихідного файла через
  `cp --preserve=all`, тому executable bit `scripts/update.sh` не губиться.
- Налаштування helper більше не є debug-командою: у поточному плані є штатна кнопка
  `🔐 Налаштувати права`. Після невдалого прототипу із зовнішнім PowerShell (`spawn UNKNOWN`) flow
  повністю перенесено всередину StandWatch. Програма використовує вже налаштований SSH, один раз
  просить sudo-пароль у маскованому діалозі, передає його віддаленому `sudo -S` лише через stdin,
  одразу очищає поле й не зберігає/не журналює пароль. Backend stage-ить актуальний helper, встановлює
  вузьке `NOPASSWD`-правило, перевіряє доступ до реального цільового файла й автоматично повторює
  preflight. Такий самий flow доступний із пакетного та пофайлового apply.

### DEBUG force-write всього config-пакета

- Додано окрему кнопку `🧪 DEBUG: перезаписати всі N`. Вона працює лише коли актуальний план,
  verified backup і всі managed JSON/YAML/SH мають повні merge-рішення.
- На відміну від звичайного apply, DEBUG-режим не пропускає файли з однаковим target/live SHA:
  для кожного файла створює T2, виконує atomic rewrite, перевіряє SHA і журналює окремі транзакції
  `config-file-debug-apply` у batch `config-file-debug-batch`.
- Backend вимагає окремий прапорець і точний confirmation token; UI перед записом показує кількість
  реально змінених та байт-в-байт однакових файлів. При падінні пакет автоматично відкочується у
  зворотному порядку; після успіху доступний ручний rollback усього DEBUG-пакета.
- Це все ще file-only перевірка: контейнери не оновлюються й не перезапускаються.

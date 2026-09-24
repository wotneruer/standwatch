# StandWatch runtime baseline — 2026-09-24

Цей manifest зафіксовано перед структурним рефакторингом.

## Авторитетні шляхи

Канонічний source:

```text
D:\_Work_\00_Inbox\TMP\RCC\StandWatch\repo
```

Чинний runtime після безпечного переміщення на тому самому диску:

```text
D:\_Work_\00_Inbox\TMP\RCC\StandWatch\runtime\current
```

Авторитетні runtime data:

```text
D:\_Work_\00_Inbox\TMP\RCC\StandWatch\runtime\current\data
```

Кореневий `D:\_Work_\00_Inbox\TMP\RCC\StandWatch\data` є старою окремою
копією і не є джерелом поточного runtime state.

## Контрольні SHA-256

```text
C2279C525A00B9630566CEF7549F4EAD4AC4C0AEE3EC7D6F57AD9510F94B722B  runtime/current/standwatch.exe
B7A49B2EE73FEE2E3611A283BBD0DF2992A0A56A91A3C347E6116EED6DD1D307  runtime/current/standwatch-server.exe
95A001A77B41C642B63D2D5A583CD868C9782C806F9CC03FF55EE95E46601A23  runtime/current/WebView2Loader.dll
C829FBAB70F2859B6A1AE1C3F8AAF397A032C6B57C760FF9FAB227430A792864  runtime/current/data/servers.json
BD0C6AC6C724EFD1209AD6DEC0FDEE6BB6A2A682900BA087A048AC72F01E8639  runtime/current/data/installer-catalog.json
B1AB905A8F95185101564A015D8031D9FE868CD6C0DAEFC07A87B527F22C1607  repo/stand-panel.work.mjs
```

## Runtime data inventory

На момент фіксації:

- plans: 12;
- config transactions: 20;
- backup directories: 4;
- server cache files: 5;
- загальний розмір runtime `data`: 18,842,631,359 bytes.

## Операційний стан

- останній DEBUG batch: `20260923070018239_batch_928f2db8`;
- 9 файлів у пакеті;
- 4 фактичні зміни;
- 5 byte-identical forced rewrites;
- контейнери не змінювались;
- повний rollback після останнього виправлення ще не перевірений користувацьким
  сценарієм.

## Важливе попередження про portable launcher

Встановлений runtime marker:

```text
2026.09.15.13
```

Зашита версія старого launcher source:

```text
2026.09.16.4
```

Старий portable launcher не запускати поверх `runtime/current`: він може
перерозпакувати старий payload поверх актуального вручну оновленого backend.

## Результат переміщення

Runtime переміщено без копіювання великих backup із:

```text
StandWatch-Debug-With-Current-Data-20260915\StandWatch
```

до:

```text
runtime\current
```

Після переміщення підтверджені SHA executable та наявність усіх 12 plans,
20 transactions і 4 backup directories.

## Відтворювана baseline-збірка

Після створення чистого repository виконано:

```text
npm run release:portable
```

Перевірено:

- усі 30 unit-тестів;
- backend SEA build;
- реальний запуск backend на випадковому loopback port;
- `/api/ping`;
- завантаження HTML;
- синтаксис фактично згенерованого inline browser JavaScript;
- framework-dependent desktop publish;
- self-contained desktop publish;
- payload із backend, desktop, WebView2 runtime files та обома helper scripts;
- self-contained portable launcher;
- versioned artifact і SHA manifest.

Baseline portable artifact:

```text
D:\_Work_\00_Inbox\TMP\RCC\StandWatch\dist\
  StandWatch-Portable-0.0.0-baseline.20260924.exe
```

```text
bytes:   257752400
sha256:  18EEF151156B3BED1689D7F30B12FB8D5C0C10E40347677C017DBFE660194F3D
```

Це build artifact для перевірки pipeline, а не команда оновити ним
`runtime/current`. End-to-end розпакування launcher в окремий smoke-каталог ще
не виконувалось.

## Наступна review-збірка

Після baseline у source виправлено два recovery-дефекти:

- rename сервера блокується, якщо плани/transactions ще посилаються на його
  display name;
- latest-batch endpoint більше не переходить до старішого batch, якщо новіший
  уже terminal/rolled-back.

Зміни зафіксовано commit `acf78ea`, тести: `34/34`. Для них використовується
version `0.0.0-review.20260924.1`. Review artifact спочатку перевіряється в
ізольованому каталозі й не встановлюється в `runtime/current` автоматично.

Review portable artifact:

```text
D:\_Work_\00_Inbox\TMP\RCC\StandWatch\dist\
  StandWatch-Portable-0.0.0-review.20260924.1.exe
```

```text
bytes:   257752400
sha256:  2D11EB43BE040810C9A8694F390814269F81617D35652C77BEEFF1D30E2782D6
```

Ізольований end-to-end smoke виконано в:

```text
D:\_Work_\00_Inbox\TMP\RCC\StandWatch\temp\portable-smoke-20260924-review1
```

Перевірено:

- launcher створює папку `StandWatch`;
- `.payload-version` дорівнює `0.0.0-review.20260924.1`;
- розпаковано 11 payload files плюс marker;
- desktop запускає bundled backend;
- `/api/ping` повертає `app=standwatch` і `dataDir` усередині smoke-каталогу;
- після тесту обидва процеси з тестового каталогу зупинені;
- `runtime/current` не змінювався.

## Встановлення review-збірки в current runtime

Після успішного ізольованого smoke payload `0.0.0-review.20260924.1`
встановлено в:

```text
D:\_Work_\00_Inbox\TMP\RCC\StandWatch\runtime\current
```

Перед заміною зроблено відновлювану копію 23 попередніх program-файлів:

```text
D:\_Work_\00_Inbox\TMP\RCC\StandWatch\archive\
  runtime-program-before-review-20260924-1
```

Перевірено після копіювання:

- backend SHA збігається з review manifest:
  `4CE742DC4B2A0187E1ADDE4D4D5FB857A035280D1EF2B468B200EC2F1B4727FE`;
- marker: `0.0.0-review.20260924.1`;
- authoritative `data` до і після: 14 069 файлів, 18 842 631 359 bytes;
- desktop стартував із `runtime/current`, backend слухав port 8799, WebView став
  ready; після закриття вікна desktop і backend завершились штатно;
- жодного config rollback чи іншої remote mutation під час оновлення не було.

## Прибирання workspace

Після успішної збірки, launcher smoke та promotion корінь workspace приведено
до канонічної структури:

```text
StandWatch\
├─ repo\
├─ runtime\
├─ dist\
├─ archive\
└─ temp\
```

Виконано:

- 95 legacy root entries переміщено без видалення в
  `archive/legacy-root-20260924`;
- ignored build outputs у `repo` видалено через `git clean -fdX`; вони повністю
  відтворюються командою `npm run release:portable`;
- `repo` після очищення займає приблизно 1.5 MB без `.git`-сміття збірки;
- 11 старих `standwatch-server.*.exe` видалено з `runtime/current`; їх копії є
  в `archive/runtime-program-before-review-20260924-1`;
- ізольований smoke-каталог видалено, `temp` порожній;
- baseline portable перенесено в `archive/obsolete-releases-20260924`;
- у `dist` залишено тільки актуальний review portable і його manifest;
- у `runtime/current` залишено актуальний payload та authoritative `data`.

Архів займає приблизно 27 GB і навмисно ще не видаляється: остаточне очищення
можна виконати після реального тесту config rollback.

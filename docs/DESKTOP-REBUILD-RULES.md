# StandWatch desktop rebuild — правила і план передачі

## 1. Мета

Перебудувати StandWatch як **справжню Windows desktop-програму**, а не локальний
HTTP-сервер, який окремо запускає Edge.

Очікувана поведінка:

- користувач запускає `standwatch.exe` і отримує одне нативне вікно;
- другий запуск не створює новий backend або нове вікно, а відновлює і фокусує
  вже відкрите;
- закриття вікна хрестиком гарантовано завершує desktop-host, Node backend,
  активне сканування та породжені `ssh`-процеси;
- після закриття не лишаються `standwatch.exe`, `standwatch-server.exe`, Edge або
  сирітські `ssh.exe`;
- зовнішній `msedge.exe --app` та `data/window-profile` більше не
  використовуються;
- `data/config.env`, `data/servers.json` і `data/cache/` зберігаються без втрат.

## 2. Робочі каталоги

- Основний каталог результату:
  `D:\_Work_\00_Inbox\TMP\RCC\StandWatch`
- Оригінальний source:
  `D:\_Work_\00_Inbox\TMP\RCC\tools`
- Оригінальний backup:
  `D:\_Work_\00_Inbox\TMP\RCC\StandWatch\_backup_before_edge_fix_20260914_1032`

Запис у `RCC\tools` із поточного sandbox раніше блокувався Group Policy. Якщо це
повториться, працювати з копією source всередині `StandWatch`, але наприкінці
залишити готовий patch/diff для перенесення в основний source.

## 3. Поточний стан — важливо прочитати перед роботою

### Файли executable

- `StandWatch/standwatch.exe` — **перший невдалий point-fix**, не вважати
  стабільною основою.
  SHA-256:
  `D94BBBEF17CC3C1CF984A5D58C7AE14CB02EE3E391AC5B93CCA3B98B7A7131CF`
- `StandWatch/standwatch.new.exe` — другий експериментальний point-fix, не
  встановлений і також не прийнятий.
  SHA-256:
  `B259E6E9E865C59EDF2E62F4B05B1928EE68EA558F08D611B876F033AEA55E03`
- `_backup_before_edge_fix_20260914_1032/standwatch.exe` — оригінальна SEA-збірка.
  SHA-256:
  `523CA499098ECA4EA46BDC459CA6E270CF3512E92C25DE3BA2FD636A94441354`
- `StandWatch/standwatch-server.exe` — уже створена копія оригінальної SEA-збірки;
  її можна використовувати лише як backend із параметром `--no-open`.
  SHA-256 такий самий: `523CA499...`.

### Source

- Оригінальний `RCC/tools/stand-panel.mjs` не змінений.
- Його SHA-256:
  `4D66C6BCEE5AE484B827BF4E782A2B8885B8F61E794B7D9F9CCB4331C92752A2`.
- `StandWatch/stand-panel.work.mjs` містить експериментальні зміни з
  `pagehide`, `taskkill`, browser PID tracking та `/api/open-window`.
  **Не переносити ці зміни сліпо в фінальну версію.**

### Підготовлена заготовка WebView2

У `StandWatch/DesktopHost/lib` локально скопійовані:

- `Microsoft.Web.WebView2.Core.dll`;
- `Microsoft.Web.WebView2.WinForms.dll`;
- `WebView2Loader.dll`.

Версія бібліотек: `1.0.2365.46`. Вони взяті з локальної інсталяції Microsoft
Office лише для можливості прототипування без мережі. Для нормальної відтворюваної
збірки бажано перейти на офіційний NuGet `Microsoft.Web.WebView2` із зафіксованою
версією, якщо корпоративна мережа це дозволить.

На машині встановлено:

- .NET SDK `8.0.422`;
- Microsoft Windows Desktop Runtime 8;
- Edge WebView2 Runtime `152.0.4191.66`;
- Node.js `26.3.0`.

Electron не встановлений, а доступ до npm із shell заблокований мережею/Group
Policy. Тому базовий рекомендований шлях — **.NET 8 WinForms + WebView2**.

## 4. Підтверджені причини старої проблеми

Стара SEA-програма робить таке:

1. Піднімає Node HTTP server на `127.0.0.1:8799`.
2. Пише `data/standwatch.lock` із PID, port, `startedAt`, `windowAt`.
3. Через `spawn(..., { detached: true })` запускає зовнішній Edge із
   `--app=http://127.0.0.1:<port>` і фіксованим
   `--user-data-dir=data/window-profile`.
4. Node server і Edge після цього живуть незалежно.

Наслідки:

- закриття хрестиком Edge не завершує Node server;
- Edge може лишити 4–8 background-процесів;
- повторний запуск знаходить старий server через lock;
- старий debounce 8 секунд міг просто завершити повторний exe без відкриття
  вікна — видима поведінка «нічого не сталося»;
- Edge-профілі накопичували сотні мегабайт і всі перевірені профілі мали
  `profile.exit_type = Crashed`;
- backend у момент чорного вікна був справний: `/` повертав HTTP 200 приблизно
  за 86 мс і правильний HTML. Чорне вікно було на рівні Edge/profile/rendering,
  а не Node API.

Спостережені профілі:

| Каталог | Файлів | Розмір | Стан |
|---|---:|---:|---|
| старий `StandWatch/data/window-profile` | 1132 | 432.6 MB | `Crashed` |
| новостворений StandWatch profile | 352 | 57.1 MB | `Crashed` |
| `D:\Utilities\Stands\data\window-profile` | 447 | 52.9 MB | `Crashed` |

Також у Windows Event Log є `LiveKernelEvent`/`WATCHDOG` (`1a8`, `1b8`, `141`).
Це можливий додатковий фактор графічної нестабільності, але не доведена
першопричина. Не маскувати його бездумним глобальним `--disable-gpu`.

## 5. Чого категорично не робити

- Не запускати зовнішній Edge через `--app`.
- Не лікувати lifecycle через `pagehide`/`sendBeacon`.
- Не вбивати всі `msedge.exe` через `Stop-Process -Name msedge` або `taskkill /IM`.
- Не визначати desktop window lifecycle через кількість Edge-процесів.
- Не використовувати `taskkill /F` як штатний спосіб закриття.
- Не видаляти `data` або весь browser profile як звичайну операцію запуску.
- Не змішувати runtime browser data з токенами, server config і cache.
- Не ковтати важливі startup exceptions через порожній `catch {}`.
- Не логувати значення GitLab/TeamCity token або приватний SSH key.
- Не встановлювати point-fix exe без проходження повної acceptance matrix нижче.

## 6. Рекомендована desktop-архітектура

### 6.1 Desktop host

Створити .NET 8 WinForms executable `standwatch.exe` із WebView2.

Відповідальність desktop host:

- створити й контролювати одне нативне вікно;
- single-instance;
- запуск/health-check/завершення backend;
- показ startup error замість чорного вікна;
- файловий лог;
- відкриття зовнішніх HTTP/HTTPS links у системному браузері;
- ніякого запуску standalone Edge app-window.

### 6.2 Backend

На першому етапі дозволено використати оригінальний
`standwatch-server.exe --no-open` як керований дочірній процес. Це зберігає всю
наявну логіку сканування без ризикового переписування.

Desktop host має:

1. Запустити backend приховано через `ProcessStartInfo`:
   `UseShellExecute=false`, `CreateNoWindow=true`, redirect stdout/stderr.
2. Передати `--no-open` і бажаний port.
3. Дочекатися `/api/ping`, перевіривши `app=standwatch` та правильний `dataDir`.
4. Лише після успішного health-check створити/navigate WebView2.
5. Прив'язати backend до Windows Job Object із
   `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, щоб crash/закриття host гарантовано
   прибирало backend і його `ssh` descendants.
6. При штатному закритті спочатку викликати `/api/quit`, дати короткий grace
   period, і лише потім застосувати process-tree fallback до **власного** backend.

У наступному рефакторингу backend бажано винести з SEA child process у бібліотеку
або окремий контрольований service module, але це не обов'язково для першої
стабільної desktop-версії.

### 6.3 Single instance

Використати named mutex, scoped до абсолютного installation directory, наприклад
хеш від `AppContext.BaseDirectory`.

Другий запуск повинен:

- не запускати backend;
- подати named event/pipe команду `activate` першому процесу;
- перший процес виконує `Restore`, `Show`, `Activate`, `BringToFront`;
- другий процес завершується лише після успішної передачі команди.

Не використовувати JSON PID/lock як єдиний single-instance механізм desktop host.
Старий `standwatch.lock` може лишитися внутрішньою деталлю backend на перехідному
етапі.

### 6.4 WebView2

- User data folder: `data/webview2`, окремо від конфігів і кешу StandWatch.
- `WebView2` створюється в процесі desktop host.
- `NewWindowRequested`: дозволяти лише `http`/`https`, відкривати через системний
  browser; інші schemes блокувати та логувати.
- У разі `ProcessFailed` показувати зрозуміле повідомлення і кнопку повторного
  завантаження, а не порожню чорну поверхню.
- Не вмикати Node integration у web content.
- DevTools у production вимкнути або сховати за явним diagnostic flag.

### 6.5 Розташування даних

Фінальна структура:

```text
StandWatch/
  standwatch.exe
  standwatch-server.exe          # перехідний керований backend
  WebView2Loader.dll             # якщо потрібен framework-dependent deployment
  *.dll / *.runtimeconfig.json   # залежно від publish mode
  data/
    config.env
    servers.json
    cache/
    logs/
      standwatch.log
    webview2/                     # disposable runtime browser data
```

Не переносити `window-profile` у нову runtime-схему. Старі профілі лише архівувати
для rollback/діагностики.

## 7. Вимоги до SSH key UX

Користувач задає шлях до ключа один раз. Цей ключ використовується за
замовчуванням для всіх стендів і для готового bootstrap-шаблону.

### 7.1 Конфіг

У `data/config.env` підтримати:

```env
SSH_KEY=C:/Users/<user>/.ssh/rcc_stand_ci
SSH_BOOTSTRAP_KEY=C:/Users/<user>/.ssh/rcc_stand_ci
SSH_DEFAULT_USER=<user>
```

Правила:

- `SSH_KEY` — ключ, яким StandWatch постійно підключається до стендів.
- `SSH_BOOTSTRAP_KEY` — ключ для першого підключення/встановлення public key.
- Якщо `SSH_BOOTSTRAP_KEY` не заданий, він автоматично дорівнює `SSH_KEY`.
- `SSH_DEFAULT_USER` використовується у формі додавання сервера.
- Зберігати тільки шлях. Ніколи не читати й не записувати private key у
  `config.env`, JSON або log.
- Перевіряти існування private key та `<key>.pub`, але не блокувати перегляд
  кешованих даних, якщо ключ тимчасово недоступний.

### 7.2 `servers.json`

Server entry має наслідувати default key. Не дублювати один шлях у кожному
записі без потреби.

Рекомендована модель:

```json
{
  "default": "RCC QA",
  "defaults": {
    "sshUser": "<user>",
    "sshKey": "C:/Users/<user>/.ssh/rcc_stand_ci",
    "bootstrapKey": "C:/Users/<user>/.ssh/rcc_stand_ci"
  },
  "servers": [
    {
      "name": "RCC QA",
      "standUrl": "https://host",
      "ssh": "<user>@host"
    }
  ]
}
```

Backward compatibility:

- старе `server.sshKey` вважати per-server override;
- якщо override немає — брати `defaults.sshKey`, далі `SSH_KEY`;
- чинний `servers.json` мігрувати без втрати записів;
- не переписувати файл тільки через читання; зберігати нову схему після явного
  save користувача або контрольованої міграції з backup.

### 7.3 Готовий bootstrap template

Зараз `keyInstallCommand()` показує placeholder `<РОБОЧИЙ_КЛЮЧ>`, через що шлях
треба вводити руками повторно. Це треба прибрати.

Після додавання host UI одразу показує повністю готову команду із вже відомими:

- default user;
- host;
- `SSH_KEY.pub`;
- `SSH_BOOTSTRAP_KEY` або fallback до `SSH_KEY`.

Шаблон для Windows повинен правильно цитувати шляхи з пробілами. Приклад
концептуально:

```cmd
type "<SSH_KEY>.pub" | ssh -i "<SSH_BOOTSTRAP_KEY>" <user>@<host> "umask 077; mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
```

Команда показується для копіювання; StandWatch не повинен автоматично змінювати
remote `authorized_keys` без окремої явної дії користувача.

Додатково:

- кнопка `Копіювати команду`;
- поруч коротко показати, який default key використано;
- per-server override у розширених налаштуваннях;
- test connection використовує resolved key за тією ж логікою, що й scan;
- одна функція `resolveSshSettings(server)` повинна бути джерелом істини для
  scan, add-server, bootstrap command і deploy.

## 8. Логування і діагностика

Додати rotating або bounded log `data/logs/standwatch.log`.

Логувати без секретів:

- desktop start/version/base directory;
- single-instance primary/secondary/activate;
- backend PID і command без token values;
- обраний port;
- `/api/ping` ready/failure;
- WebView2 initialize/navigation/process-failed;
- scan start/finish/cancel і server name;
- shutdown reason, grace timeout, forced child-tree cleanup;
- resolved SSH key **path** дозволено логувати, вміст ключа — ні;
- stdout/stderr backend із маскуванням можливих token/password values.

Startup error повинен бути видимим у нативному dialog/панелі, а не тільки в log.

## 9. План реалізації

1. Зафіксувати SHA-256 усіх current/backup binaries.
2. Не чіпаючи `data/config.env`, `servers.json`, `cache`, створити новий
   `DesktopHost` project.
3. Реалізувати mutex + activation event/pipe.
4. Реалізувати Job Object і запуск `standwatch-server.exe --no-open`.
5. Реалізувати backend health discovery для ports `8799..8819`.
6. Реалізувати WinForms window + WebView2 + startup/error screen.
7. Реалізувати graceful/forced shutdown лише власного process tree.
8. Перехопити кнопку `✕ Вийти`, щоб вона закривала desktop-host, а не лише
   backend.
9. Реалізувати external-link handling.
10. Додати file log із redaction.
11. Реалізувати `resolveSshSettings()` і default/bootstrap key schema.
12. Оновити add-server UI та готову bootstrap command без placeholder.
13. Додати backward-compatible migration `servers.json`.
14. Зібрати у staging directory; не замінювати root exe до acceptance tests.
15. Після green tests зробити окремий pre-install backup і лише тоді атомарно
    встановити фінальні artifacts.
16. Залишити source, build command, patch/diff для `RCC/tools` і короткий
    maintenance README.

## 10. Acceptance matrix

Усі сценарії обов'язкові.

### Lifecycle

1. Перший запуск без процесів: рівно одне вікно, один desktop-host, один backend.
2. Другий запуск через 100 мс, 1 с, 3 с і 10 с: нових backend/window немає;
   перше вікно активується.
3. Мінімізоване вікно + повторний запуск: вікно відновлюється і фокусується.
4. Закриття хрестиком під час idle: за 3 с не лишається host/backend/ssh.
5. Закриття під час scan: scan child processes завершуються, data files не
   пошкоджені.
6. Кнопка `✕ Вийти`: та сама семантика, що й системний хрестик.
7. Refresh/Ctrl+R: програма не завершується і не запускає другий backend.
8. Crash/kill desktop-host: Job Object прибирає backend/ssh descendants.
9. Crash backend: desktop window показує помилку/restart action, не чорний екран.

### Port і копії

10. `8799` вільний — використовується `8799`.
11. `8799` зайнятий чужим процесом — backend знаходить наступний port, host
    відкриває правильний.
12. Stale `standwatch.lock` — startup відновлюється без ручного видалення.
13. Копія в іншій теці: single-instance policy має бути явно визначена й
    протестована. Рекомендація — mutex scoped до installation path.

### UI/WebView2

14. Перше завантаження не показує чорне/порожнє вікно.
15. `ProcessFailed` дає зрозумілий recovery UI.
16. External links відкриваються в системному browser.
17. Після 20 циклів open/close WebView2 data не має постійного `Crashed` через
    штатне завершення.

### Дані

18. Існуючі `config.env`, `servers.json`, два cache files читаються без міграції
    вручну.
19. Жоден тест не стирає token/config/cache.
20. Старий `window-profile` новою програмою не використовується.

### SSH keys

21. Default key задається один раз і використовується scan/test/add-server.
22. Якщо bootstrap key не заданий, готова команда використовує default key.
23. Шлях із пробілами правильно quoted.
24. Per-server override працює і не змінює глобальний default.
25. Відсутній `.pub` дає зрозуміле повідомлення та спосіб виправлення.
26. Bootstrap command не містить `<РОБОЧИЙ_КЛЮЧ>` або інших placeholder після
    збереження налаштувань.
27. Логи не містять private key content, GitLab token або TeamCity token.

## 11. Definition of done

Робота не завершена, доки:

- немає green результату для всієї acceptance matrix;
- root `standwatch.exe` є desktop-host, а не Node SEA server;
- зовнішній Edge не запускається;
- закриття вікна гарантовано завершує весь власний process tree;
- повторний запуск активує існуюче вікно;
- default SSH key реально підставляється в test/scan/bootstrap flow;
- збережено rollback backup;
- задокументована точна build-команда;
- перевірено запуск із `D:\_Work_\00_Inbox\TMP\RCC\StandWatch` і після копіювання
  deployment artifacts в іншу теку.

## 12. Поточна точка передачі

На момент створення цього документа:

- активних `standwatch`/`msedge` процесів та listeners `8799..8819` не було;
- root `standwatch.exe` лишається першим невдалим point-fix;
- оригінальна SEA-збірка збережена в backup і скопійована як
  `standwatch-server.exe`;
- `DesktopHost/lib` підготовлений для локального WebView2 prototype;
- .NET project/WinForms code ще не створено;
- жодна desktop-збірка ще не встановлена;
- існуючі `config.env`, `servers.json` і cache не змінювалися під час підготовки
  цього плану.

## 13. Майбутній етап: звірка стенду з installer baseline

### 13.1 Мета

Додати можливість вибрати затегований installer або конкретний стан гілки та
порівняти описаний ним пул сервісів/файлів із фактичним станом вибраного стенду.
StandWatch повинен показати, що вже відповідає baseline, що потребує оновлення і
що не вдалося однозначно зіставити.

Це окремий майбутній етап. Він не входить у поточний Definition of done desktop-
збірки і не повинен розширювати чинну кнопку deploy до повного автоматичного
оновлення стенду.

### 13.2 Перший MVP — лише read-only та dry-run

1. Вибрати джерело baseline: installer tag або branch/build.
2. Отримати manifest installer-а з точними версіями сервісів, образів і файлів.
3. Автоматично зіставити елементи manifest із контейнерами та GitLab/TeamCity-
   даними, не покладаючись лише на однакову назву проєкту.
4. Показати таблицю `поточне → цільове` зі статусами:
   `актуально`, `потребує оновлення`, `відсутнє`, `неоднозначно`, `не знайдено`.
5. Дозволити вибрати підмножину сервісів/файлів і сформувати план виконання.
6. На цьому етапі StandWatch нічого не змінює на сервері, не зупиняє сервіси й
   не запускає міграції. Максимальний результат — preview/export команд.

Файли можна вважати керованими лише тоді, коли manifest задає їхній цільовий
шлях, версію або checksum та джерело artifact. Невідомі відповідності не можна
вгадувати — вони блокують автоматичне виконання, але не read-only звіт.

### 13.3 Сервер першої валідації

Перший кандидат — `Poruch QA`, `10.0.31.88`.

Причини:

- цей стенд уже доданий у StandWatch, а SSH та отримання стану контейнерів на
  ньому раніше перевірялися;
- збережений scan містить 17 сервісів, чого достатньо для перевірки як звичайних,
  так і неоднозначних відповідностей назв;
- він використовує той самий ланцюжок SSH, registry, TeamCity і GitLab, який
  потрібен для майбутньої функції;
- `RCC DEV` (`10.0.31.55`) виключений із цієї валідації й не повинен
  опитуватися або змінюватися.

Перша валідація на `Poruch QA` не має змінювати сервер. Спочатку треба працювати
зі збереженим scan/cache; повторний SSH-scan запускати лише окремою дією. Валідація
вважається успішною, якщо для кожного елемента installer manifest можна пояснити
зв'язок або явно показати причину, через яку відповідність не знайдена:

`installer manifest → service/image tag → TeamCity build → commit → GitLab project`.

### 13.4 Що свідомо відкладено

Автоматичне застосування плану не починати, доки окремо не спроєктовані й не
перевірені:

- preflight і maintenance lock;
- backup БД та тестове відновлення з нього;
- порядок залежностей і сумісність конфігів/міграцій;
- health-check після кожного кроку;
- поведінка при частковому падінні;
- rollback сервісів, файлів і БД;
- аудит дій, права доступу та заборона паралельних deploy.

Поки цих гарантій немає, StandWatch залишається інструментом спостереження та
підготовки плану, а не release orchestrator-ом.

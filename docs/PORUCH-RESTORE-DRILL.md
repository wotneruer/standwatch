# Poruch QA — backup pilot та сценарій відновлення

Дата фіксації: **16.09.2026**  
Сервер: **Poruch QA (`10.0.31.88`)**  
Docker Compose group: **`rscore`**  
Installation root: **`/usr/local/rscore`**

## 1. Зафіксована ціль installer

- Plan ID: `20260916080531886_poruch_qa_rscore`.
- Installer project: `vpo/installer`.
- Installer tag: `1.7.2`.
- Commit: `f3899ec26d8d146b4ad37087679f5d720faff0ea` (`f3899ec2`).
- Manifest checksum:
  `0a19b4201401381076c6bbcc793fe8d95446501fbce543f9bac2d7acec8b0b8d`.
- Сервісів у manifest: `18`.

## 2. Успішна локальна точка відновлення

Статус: **`verified`**  
Створено: **2026-09-16 11:24:31 Europe/Kyiv**  
Каталог:

`StandWatch/data/backups/20260916080531886_poruch_qa_rscore`

Артефакти:

| Артефакт | Розмір | Розпаковано | SHA-256 |
|---|---:|---:|---|
| `containers.json` | 187653 B | — | `ec25343b1856fd5e58798ed2fc1c71a182fa11ff8276672c3c1388143257bc86` |
| `stand-files.tar.gz` | 3374796832 B | 3433103360 B | `839f4dcbb1431f0ac24f0b04f9589165c6644da4da2111249e1c1f928faa4573` |
| `database/rscore_postgresql.sql.gz` | 397317274 B | 1020323340 B | `32ed76b4c7e6b6a36b726a69968f652f3f8ecb09ab8802619b3baababe6a5616` |

Перевірено:

- завершення SSH stream без помилки;
- повне локальне читання gzip;
- SHA-256 кожного артефакту;
- виявлено один DB-контейнер `rscore-postgresql` (`postgres:14.5`);
- для нього виконано повний `pg_dumpall`;
- `database.detected` і `database.dumped` збігаються;
- backup manifest має `database.complete: true`.

У файловий архів входять `home`, `scripts`, `volumes`.

Навмисно виключено:

- `volumes/logs` — runtime-логи не потрібні для відновлення;
- `volumes/postgresql/pgdata`;
- `volumes/*/pgdata` — живий або старий PostgreSQL data directory не є
  консистентною точкою відновлення. Джерело відновлення БД — `pg_dumpall`.

## 3. Нюанси, виявлені під час пілота

1. Стандартний `tar -czf` був повільним на `volumes/vpo-portal/images` обсягом
   близько 3.3 GiB. На Poruch уже є `/usr/bin/pigz`; backup переведено на
   багатопотоковий `pigz -1`.
2. Перша спроба зупинилася на недоступних runtime-файлах RabbitMQ і старому
   `postgresql_bk/pgdata`. Ці каталоги виключено зі scope.
3. Друга спроба виявила гонку двох читачів SSH stdout і отримала пошкоджений
   gzip. Writer переведено на єдиний pipeline; окремий smoke-тест `home/scripts`
   на Poruch успішно пройшов повне gzip-читання.
4. Retry очищає лише app-generated пошкоджені артефакти попередньої спроби зі
   статусом `failed`, тому багатогігабайтні файли не накопичуються.
5. Актуальний plan повторно використовується, доки фактичні tags сервісів не
   змінилися. Невдалий backup не вимагає нового plan.

## 4. Що цей статус ще не гарантує

`verified` зараз означає: файли локально записані, gzip читається, checksum
збігається, PostgreSQL dump отримано повністю.

Це **ще не доводить**, що:

- SQL dump успішно відновлюється в чистий PostgreSQL 14.5;
- після restore присутні всі ролі, databases, schemas, extensions і дані;
- відновлені `home/scripts/volumes` мають правильні owners/modes;
- compose stack стартує з нуля;
- сервіси проходять health/API smoke checks.

Тому deploy має лишатися `blocked-until-restore-workflow`.

## 5. Обов'язковий недеструктивний етап перед «прибити все»

1. Повторно перевірити SHA-256 трьох артефактів.
2. Створити ізольований тимчасовий PostgreSQL **14.5**, який не використовує
   порти, network і volumes робочого стенду.
3. Розпакувати `rscore_postgresql.sql.gz` потоком у `psql` тимчасового контейнера.
4. Зафіксувати та порівняти з робочою БД:
   - перелік roles і databases;
   - schemas та extensions;
   - кількість таблиць;
   - row counts для погодженого набору критичних таблиць;
   - помилки restore log.
5. Видалити лише тимчасовий контейнер/volume після збереження звіту.
6. Позначити restore point як `restore-tested` лише якщо всі перевірки успішні.

Якщо на сервері недостатньо місця для тимчасової БД, тест виконати на окремому
Docker host або локальній машині. Робочий PostgreSQL для цього не зупиняти.

## 6. Майбутній destructive restore drill

Цей етап запускається лише після окремого підтвердження користувача та статусу
`restore-tested`.

### Перед видаленням

1. Погодити maintenance window і допустимий downtime.
2. Зупинити зміни даних користувачами/інтеграціями.
3. Створити **другий свіжий** verified backup безпосередньо перед drill.
4. Зафіксувати фактичний стан:
   - `docker ps/inspect`;
   - compose projects і working directories;
   - image tags/digests;
   - health endpoints;
   - DB roles/databases/schema/контрольні row counts.
5. Перевірити, що обидві локальні точки відновлення доступні та checksum
   збігаються.
6. Підготувати точні команди restore і rollback; жодних широких `rm -rf`.

### Destructive scope

Точний перелік контейнерів, networks, volumes і директорій має бути отриманий із
`containers.json` та compose labels. Не можна видаляти весь Docker host або
сторонні compose groups.

Орієнтовна послідовність:

1. Зупинити лише compose group `rscore`.
2. Видалити лише його контейнери та погоджені volumes.
3. Очистити/перейменувати лише погоджений `/usr/local/rscore`.
4. Відновити `home/scripts/volumes` із локального архіву зі збереженням
   зафіксованих owners/modes.
5. Створити чистий PostgreSQL 14.5.
6. Відновити roles/databases/data з `pg_dumpall`.
7. Відтворити compose stack із зафіксованими image tags/digests.
8. Запустити спочатку PostgreSQL та інфраструктуру, потім backend/web сервіси.

### Критерії успіху

- усі очікувані контейнери `running/healthy`;
- tags/digests відповідають restore point;
- DB roles/databases/schema і контрольні row counts збігаються;
- немає критичних помилок у startup logs;
- проходять погоджені API/UI smoke checks;
- StandWatch scan не показує втрати сервісів або невідомих образів.

### Умови негайної зупинки

- checksum хоча б одного локального артефакту не збігається;
- тестове відновлення PostgreSQL не пройшло;
- scope видалення не можна однозначно відокремити від інших compose groups;
- не визначені owners/modes або секрети, потрібні для старту;
- немає другого свіжого verified backup;
- вільного місця недостатньо для restore.

## 7. Реалізований недеструктивний restore-test

У StandWatch реалізовано операцію **`Перевірити відновлення БД`**:

- повторна SHA-256 перевірка всіх backup artifacts;
- створення ізольованого PostgreSQL того самого image без host ports і без
  робочих volumes;
- потоковий restore локального `sql.gz` через SSH;
- порівняння roles, databases, extensions та таблиць із живою БД;
- збір JSONL-журналу, результату й startup log тимчасового PostgreSQL;
- збереження результату в `restore-point.json`;
- новий статус `restore-tested`.

Тимчасові ресурси мають префікс `standwatch_restore_` і видаляються адресно у
`finally`, у тому числі після помилки. Робочий PostgreSQL не зупиняється і не
змінюється.

Перед destructive drill ще потрібні окреме підтвердження користувача, другий
свіжий verified backup та реалізація health/startup журналу для всього stack.

## 8. Фактичний результат restore-test 16.09.2026

План `20260916080531886_poruch_qa_rscore` успішно пройшов недеструктивну
перевірку:

- усі backup artifacts повторно пройшли SHA-256;
- dump відновлено у чистий ізольований `postgres:14.5`;
- збіглися роль `rscore`, databases `postgres`, `rscore`, `template1`;
- збіглися extensions, включно з `uuid-ossp` у базі `rscore`;
- збігся повний перелік користувацьких таблиць;
- робоча БД не зупинялась і не змінювалась;
- тимчасові container і volume після тесту відсутні.

План отримав `restore-tested`, deploy-gate — `ready-for-approved-drill`.
Діагностика лежить у каталозі backup: `restore-test.jsonl`,
`restore-test-result.json`, `restore-test-container.log`.

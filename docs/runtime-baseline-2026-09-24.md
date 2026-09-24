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


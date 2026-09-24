# Fix 2026-09-16 — installer не додавався до 2-го (і далі) проєкту

> Автор правки: Claude (Codex був недоступний — ліміти). Джерело істини — `stand-panel.work.mjs`.
> Цей файл, щоб Codex/ти могли звіритись і згорнути правку у свій pipeline.

## Симптом
У модалці «Проєкти / installer» до першого проєкту (Poruch) installer додавався,
а до другого (Yetu) — «＋ Додати installer» нічого не робив: лишалось `installer: 0`,
без помилки. Особливо стабільно відтворювалось, коли до проєкту спершу **прикріпили сервер**,
а вже потім додавали installer.

## Корінна причина (клієнтський JS у `stand-panel.work.mjs`)
`saveCatalog()` після кожного успішного POST **перезаписував увесь об'єкт**:
`installerCatalog = j.catalog` (нова копія з сервера, через debounce ~120 мс).

Обробники всередині `renderProjectManager()` тримають посилання на об'єкт проєкту `p`,
зафіксований на момент рендера. Будь-яке збереження (напр. `refreshServerSummary()` при
прикріпленні сервера) через 120 мс підміняло `installerCatalog` новою копією — і `p`
ставав **stale** (вказував на стару, від'єднану копію).

Далі `pm_add_installer` робив `p.installers.push(...)` у стару копію, а `saveCatalog()`
серіалізував **нову** (де installer немає) → рендер читав нову → «0 installer». Додане
мовчки губилось. Перший проєкт зазвичай встигав до першої підміни — тому й «Poruch працює».

Сервер (`/api/installer/catalog`, `validateInstallerCatalog`, `installer-control.mjs`)
**не винен** — прямий POST з installer до 2-го проєкту приймається коректно.

## Правка (2 місця, обидва в `stand-panel.work.mjs`)
1. **Корінь — `saveCatalog()`:** прибрано `installerCatalog = j.catalog` (і зайвий
   `localStorage.setItem` після нього). Локальний каталог уже пройшов ту саму валідацію,
   тож лишається джерелом істини в межах сесії; свіжу серверну версію все одно підтягує
   `hydrateInstallerCatalog()` при наступному відкритті. Це усуває підміну об'єкта —
   отже весь клас stale-`p` багів (не лише installer, а й rename/toggle серверів).
2. **Захист — `pm_add_installer.onclick`:** проєкт береться **живим** на момент кліку
   (`const proj = catalogProject(selectedCatalogProject)`), а не з замкнутого `p`; push іде
   в `proj.installers`. Навіть якщо колись знову з'явиться підміна каталогу — додавання не загубиться.

> Увага: коментарі всередині клієнтського `<script>` живуть у template-літералі (backtick) —
> не використовувати `` ` `` та `${` у тих коментарях (обриває літерал).

## Збірка й розкладка
- Збірка: `node build-standwatch-work.mjs` → `standwatch-server.new.exe` (SEA, windowless).
- Розкладено копією `standwatch-server.new.exe` →
  - `StandWatch/standwatch-server.exe` (канонічний),
  - `StandWatch/StandWatch-Debug-With-Current-Data-20260915/StandWatch/standwatch-server.exe` (те, що ти запускаєш).
- Десктоп-хост (`standwatch.exe`) сам піднімає `standwatch-server.exe` — тож достатньо перезапустити хост.

## Перевірено (E2E, реальний бекенд + браузер)
Сценарій: створив проєкти Alpha і Beta, додав installer до **Beta** (2-й проєкт).
- UI: `Beta → installer: 1`, картка «Beta core / vpo/installer».
- Сервер `/api/installer/catalog`: installer реально збережений під Beta. ✅

## Що варто перевірити далі (не чіпав)
- `parseComposeImages` бере тег прямо з рядка `image:` і **не розкриває** `${VAR}` з `.env`
  (у Poruch-репо теги задані через змінні) — валідність тегів на реальних файлах треба звірити.
- Багато scratch-тек (`_payload_stage_*`, `_*_smoke`, `PortableRelease/build-*`) — прибрати пізніше.

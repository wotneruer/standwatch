# TODO — звірка з installer: скоуп по групі (retail vs rscore на 1 сервері)

> Діагностика записана, код НЕ чіпав. Продовжити пізніше.

## Симптом
Yetu QA має 2 окремі installer-репо (`rscore/yetu/rscore-installer`,
`rscore/yetu/retail-portal-installer`). У звірці retail «не видно повноцінно»:
retail-контейнери зі стенду не потрапляють у вкладку, а retail-сервіси з installer
сиплються як «є в installer, але контейнера нема», хоча вони крутяться (видно в Огляді).

## Причина (перевірено по коду `stand-panel.work.mjs`, `buildPlanView`, ~р.1597–1602)
Звірка асиметрична:
- **Сервер зараз** (`byStand`) — стенд-рядки, **обрізані до однієї групи** `currentGroup()`.
- **Installer target** (`byTarget`) — **ВСІ** сервіси одного снапшоту (`installerState.snapshot.services`,
  тобто весь `home/*.yml` вибраного інсталятора), **без** фільтра по групі.

Наслідок: якщо репо містить файли кількох продуктів (тут retail-файли `home/01_retail_infrastructure.yml`,
`home/02_retail.yml` видно в rscore-звірці), вони засмічують будь-яку групу. А контейнери іншої
групи (retail) у поточну (rscore) вкладку не входять узагалі. Сканер контейнери БАЧИТЬ — проблема
лише в зіставленні.

## Обхід (без коду)
«Налаштувати ціль» → Група контейнерів = `retail`, Installer-репозиторій = `retail yetu`,
Директорія = `/usr/local/retail`. Кожна група звіряється зі своїм інсталятором окремо.

## Запропонований фікс (корінно)
1. При виборі **групи** автопідставляти прив'язаний до неї installer-репо
   (retail→retail-installer, rscore→rscore-installer) — прибрати ручну плутанину.
2. **Скоупити `byTarget` до сервісів поточної групи** — target-сервіси не з цієї групи не тягнути
   в таблицю. Потрібен мапінг «сервіс installer → група» (варіанти: по прив'язці installer↔група +
   installRoot; або по файлу-джерелу `sourceFile`; або по compose-project образу).

## Відкрите питання (перед фіксом)
Підтвердити: retail і rscore на стенді — це **різні docker-compose проєкти** (окремі
`/usr/local/retail` і `/usr/local/rscore`)? Якщо так — прив'язка «група → свій installer-репо +
свій installRoot» і скоуп звірки по групі. Потім правити `stand-panel.work.mjs` + перезбирати
`build-standwatch-work.mjs` (аналогічно [FIX-2026-09-16-installer-catalog-stale-ref.md](FIX-2026-09-16-installer-catalog-stale-ref.md)).

## Стан catalog (Debug-збірка, для контексту)
- installRoots має лише `Poruch QA|rscore|vpo/installer` → для Yetu install-root дефолтиться `/usr/local/<group>`.
- Yetu installers: rscore-installer + retail-portal-installer, обидва `manifestRoot: home`.

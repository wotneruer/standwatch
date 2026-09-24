# План: reconcile та керована підготовка конфігів при апгрейді інсталятора

> Статус: **фіналізована модель, погоджено 17.09.2026** (Антон + рев'ю). Коду ще нема.
> Продовження теми restore для Poruch QA після того, як backup+restore-test працюють.
> Ця версія — після спрощення: **two-way** (backup↔installer), без old-installer three-way,
> бо backup робимо **безпосередньо перед апгрейдом**.

## 1. Навіщо (проблема)

«Втупу накотити installer-конфіги й перезапустити» на живому Poruch = лотерея. Розробникам
віри нема — вони міняють конфіги. Треба **побудувати target-конфіг для нової версії локально,
зберігши environment-specific значення**, показати diff, і лише потім керовано застосувати.

**Ядро — креденшиали/параметри, не «файли».** Інсталятор везе **шаблонні** креди й дефолти
(юзер/пароль/ключі, приклад-значення), а реально БД і сервіси працюють зі **своїми**. Оскільки
**контейнер БД НЕ перезбираємо/не переініціалізуємо**, накотити інсталяторські дефолти = сервіс
піде в БД з чужим паролем → усе ляже.

**Головна гарантія (одним реченням):** target-конфіг вживає **реальні значення запущеної системи**
(з pre-upgrade backup), інсталятор дає лише **структуру та нові опції**, QA-профіль — обов'язкові
тестові overrides. БД не чіпаємо.

## 2. Модель джерел (two-way + профіль + safety-view)

Backup робиться **безпосередньо перед апгрейдом**, тож це не старий baseline, а **pre-upgrade
snapshot** — актуальний стан системи. Тому:

```
backup     → authoritative values (реальний стан перед апгрейдом)
installer  → desired structure / нові опції / нові дефолти
QA profile → обов'язкові environment-specific overrides (напр. dns_refresh_rate)
server-now → safety / diff-view (що саме перезапишемо), НЕ джерело правди
```

**Frozen-config assumption (обов'язково):** після створення backup (T0) конфігурація вважається
**замороженою** до завершення апгрейду (T2). Якщо хтось руками змінить конфіг між T0 і push — це
race condition, updater не зобов'язаний його рятувати. (T0 backup → T1 reconcile → T2 apply.)

## 3. Правила reconcile (two-way, по ключах)

Для кожного ключа/поля (backup · installer · +server як diff-view · +QA-профіль):

| Ситуація | Дія | Автоматично? |
|---|---|---|
| ключ **лише в installer** (нема в backup) | **нова опція → додати з installer** | ✅ auto |
| ключ **у backup та installer однакові** | взяти значення | ✅ auto |
| ключ **є в обох, значення різні** | **REVIEW** — це або env-значення (лишити backup), або продукт змінив default (взяти installer); машина не доведе → **людина вирішує** | ⚠ review |
| ключ **лише в backup** (нема в installer) | лишити / warn за policy | ✅/⚠ |
| поле з **QA-профілю** | застосувати **завжди зверху** (напр. `dns_refresh_rate: 5s`) | ✅ auto |
| **secret** | лише **reference/provider**, значення не порівнюємо (див. §7) | — |

**Ключове:** «є в обох, різне» **НЕ** розв'язуємо мовчки на користь backup — інакше пропустимо
легітимну зміну продукту. Це review. Але таких — жменя (креди/порти), не 300.

**Auto-класифікація, оператору — лише що треба.** Мета — щоб UI показував не «choose × 300», а:
```
✓ 143 параметри вирішено автоматично
⚠ 4 потребують перегляду (conflicts)
✗ 1 помилка валідації
```

«changeme / example / password123 / порожнє / localhost / зразкові UUID» — окремий validator, що
підсвічує підозрілі значення (не блокує, але піднімає увагу).

## 4. Класи конфігів — кожному свій інструмент

Спершу **дешевий sha256-статус для всіх** (сервер рахує, нічого не тягнемо) — це лише optimization
«skip якщо однакові», не архітектура. Далі — лениво:

| Клас | Приклад на Poruch | Інструмент |
|---|---|---|
| Прості модульні | `home/*.yml` (compose) | sha + звичний diff; образи вже покриває reconcile |
| **Параметричні (малі, руками)** | `.env`, `appsettings*.json` | **reconcile по ключах** (§3) |
| Структурні/великі | `envoy` (api-gateway/device-gateway) | **нормальний YAML parser** → витяг **named-полів** (порти, адреси, `dns_refresh_rate`) у reconcile; решта — **рядковий diff по кліку** |
| Скрипти | `scripts/*.sh` | текстовий diff |
| Секрети | паролі/ключі | лише reference (§7) |

**YAML: не regex-парсинг.** Бандлимо `js-yaml` через esbuild (наш «без залежностей» — це був SEA-
constraint, а не закон), парсимо в дерево й витягуємо шляхи (`clusters[name=user-service]…`).
Envoy **не моделюємо семантично** — лише витягуємо кілька налаштованих полів; масового парсингу нема,
з сервера тягнемо **один файл по кліку**.

## 5. Валідація «щоб не ламало»: static + runtime

Розділяємо явно:
- **Static** (з локальних артефактів): юзер із connection string **існує як роль у БД-дампі**
  (наш backup робить **`pg_dumpall`**, тож ролі в дампі Є); порти/адреси узгоджені між envoy і
  appsettings; ключі присутні.
- **Runtime preflight** (перед apply, реальна перевірка): 
  ```
  [OK] PostgreSQL reachable
  [OK] database rscore exists
  [OK] role rscore_app exists
  [OK] authentication succeeded
  ```
  Бо статично довести, що **пароль вірний**, неможливо (він хешований/відсутній у дампі) — лише
  connection-test. Це і є найсильніша гарантія.

## 6. Потік роботи (transaction + rollback)

```
T0  backup (pre-upgrade snapshot)          ← вже вміємо
T1  reconcile → target config (локально)
    ├ sha-статус усіх
    ├ витяг фактичних значень (backup конфіги + pg_dumpall)
    ├ two-way по ключах (§3) + QA-профіль
    └ static-валідація (§5)
    → PREVIEW: diff target ↔ server-now («ось що поїде») + список review/errors
T2  apply (керовано, як транзакція):
    prepare → validate → runtime-preflight (§5) → snapshot(поточні файли)
    → scp target → restart ЛИШЕ affected → health-check
        ├ OK   → done
        └ FAIL → restore snapshot → restart affected → health-check again
```

БД **не чіпаємо, не переініціалізуємо** на жодному кроці. Rollback — **first-class** (не «десь є .bak»).

## 7. Секрети / `pass`

Іде міграція на систему секретів (`pass`). Поля-секрети:
- **значення не тягнемо, не зберігаємо, не порівнюємо**;
- перевіряємо лише **присутність reference** («є посилання на pass» / «нема»);
- resolve — через secret provider на apply, не в plaintext.
Інтеграцію pass продумати окремо (окрема гілка).

## 8. QA-профіль — декларативний version-controlled файл

Не хардкод і не UI-only. Приклад:
```yaml
profile: poruch-qa
rules:
  database:
    reinitialize: false
    secrets: { preserve: true }
  envoy:
    dns_refresh_rate: { required: true, value: 5s }
overrides:
  api-gateway:
    dns_refresh_rate: 5s
```
Переваги: version-control, code review, повторне використання, історія, застосування без ручного
заповнення щоразу. UI лише **редагує/показує** цей профіль.

## 9. Порядок реалізації — вертикальний MVP спершу

> **Доставка — ТІЛЬКИ UI** (кнопки/вкладка в панелі StandWatch). Відходимо від консолей.
> Консоль (`node config-reconcile.mjs …`) припустима лише як **тимчасовий debug-крок** для
> першої перевірки семантики на «голій» базі — але кінцевий результат кожної фази йде в інтерфейс.
> Reconcile-логіку тримати окремим модулем `config-reconcile.mjs`, у `stand-panel.work.mjs` —
> лише тонке підключення (endpoint + вкладка), щоб мінімізувати перетин із правками Codex.


Найбільший ризик — **семантика reconcile**, не «як витягти creds». Тому спершу тонкий вертикальний
зріз на **одному сервісі**, повний ланцюг:
```
1. user-service / appsettings.json
2. backup value ↔ new installer (§3 two-way)
3. + QA-профіль
4. target config
5. diff / preview
6. static validation
7. dry-run (нічого не застосовує)
```
Довести, що модель реально працює. Потім розширення:
```
.env → home compose → envoy(YAML parser + named fields)
→ QA profiles → static+runtime DB validation
→ apply/restart/health/rollback → pass
```

## 10. Відкриті питання
- Named-поля envoy (api-gateway/device-gateway) — виписати на прикладі, коли дійдемо; орієнтир:
  **порти, адреси, `dns_refresh_rate`**.
- Формат/локація pass-референсів у конфігах — коли міграція оформиться.
- Політика для «ключ лише в backup» (прибирати чи лишати) — за замовч. лишати + warn.
- Health-check: які саме сигнали на сервіс (running/healthy + endpoint?) — уточнити при apply-фазі.

---
_Модель: two-way (backup=pre-upgrade snapshot ↔ installer) + QA-profile + review на конфліктах +
frozen-assumption + static/runtime валідація + health-check/rollback. Старт — вертикальний MVP на
user-service/appsettings, за командою Антона._
